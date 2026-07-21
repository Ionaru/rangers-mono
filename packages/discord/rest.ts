/**
 * The Discord REST client: plain `fetch`, and it stays plain `fetch`.
 *
 * Not `@discordjs/rest`, which brings 9 transitive dependencies including a
 * second HTTP stack, to buy rate-limit bucketing worth nothing at roughly one
 * request every three minutes (IMPLEMENTATION §1). There is no gateway either
 * (ADR 0003). Retrying a failed request is not bucketing: it needs no dependency
 * and no shared state, only the loop below.
 */

const API_BASE = "https://discord.com/api/v10";

/** A non-2xx from Discord, carrying the status so callers can tell 404 from 403. */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Discord API ${status} for ${path}: ${body.slice(0, 300)}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * How hard to try when Discord answers with weather rather than an answer.
 *
 * Constants, not environment: a knob nobody turns is a knob that documents
 * nothing, this package is consumed by `apps/web` as well as the worker (so it
 * has no config dependency by design), and the one caller that genuinely needs
 * different numbers is the one with a human waiting, which passes them directly.
 */
export interface RetryPolicy {
  /** Total tries for a transient failure, not extra tries. 3 = one try plus two retries. */
  transientAttempts: number;
  /** Backoff before each retry, jittered. One shorter than `transientAttempts`. */
  backoffMs: readonly number[];
  /**
   * Per attempt, and it stays armed while the caller reads the body, so it has
   * to be long enough for both halves.
   */
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  transientAttempts: 3,
  backoffMs: [500, 1_500],
  timeoutMs: 10_000,
};

/**
 * How many times a 429 is honoured. Deliberately separate from the transient
 * budget and deliberately unchanged: a one-shot backfill firing eighty role
 * writes down one route WILL be rate limited, and being told to wait is a
 * working request, not a failing one.
 */
const RATE_LIMIT_ATTEMPTS = 5;

/**
 * Methods it is safe to send twice.
 *
 * This is the only thing standing between a 500 on `createGuildRole` (a POST,
 * roles.ts) and a duplicate badge role in the guild. A 5xx means Discord may
 * have processed the request and failed to say so, so a non-idempotent method is
 * never replayed: the caller is told, and a human decides. `PUT` is on the list
 * because Discord's role-grant endpoint is genuinely idempotent (roles.ts).
 */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

/**
 * Statuses that mean "ask again later", including Cloudflare's own range.
 *
 * discord.com sits behind Cloudflare, so 520 (unknown error at the origin), 521
 * (origin down), 522 (connection timed out) and 523/524/525/527 never came from
 * the Discord API at all: they are the edge saying it could not reach or hold a
 * conversation with the origin. None of them tell us anything about our request,
 * which is exactly why retrying is right and why the body is an HTML error page
 * rather than JSON. A 501 is missing on purpose: that one will not fix itself.
 */
function isTransientStatus(status: number): boolean {
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return status >= 520 && status <= 527;
}

export interface DiscordRestOptions {
  botToken: string;
  /**
   * Overrides for the defaults, which are sized for the worker: a background
   * loop that runs again in five minutes and would rather wait than fail. The
   * SSR guild gate has a person waiting on the response and passes something
   * much shorter (apps/web/src/middleware.ts).
   */
  retry?: Partial<RetryPolicy>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter downwards, so several callers that failed at the same instant do
 * not come back at the same instant.
 */
const jittered = (ms: number) => Math.round(ms * (0.5 + Math.random() * 0.5));

/**
 * A transport failure, as opposed to a bug in the caller.
 *
 * Deno raises every network-layer problem (connection reset, DNS, TLS) as a
 * `TypeError` from `fetch` itself, and an expired `AbortSignal.timeout` as a
 * `TimeoutError` DOMException. Neither carries a machine-readable code, so the
 * check is the class plus the fact that it came out of `fetch`. A genuine
 * programming error would also be a `TypeError`, which is why this only ever
 * decides whether to retry: whatever it is, if it survives the retries it is
 * thrown at the caller unchanged.
 */
function isRetriableThrow(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError");
}

/**
 * One request, as the bot.
 *
 * `Authorization: Bot <token>` is the whole auth story: the bot token is not an
 * OAuth token and carries no user's consent. It is also why guild roles come
 * from here rather than from the login (IMPLEMENTATION §4): this works with the
 * user absent, needs no scope, and never expires.
 *
 * Two failures are absorbed rather than raised. A **429** is honoured for as
 * long as Discord asks, unchanged from the first version of this file. A
 * **transient 5xx, a Cloudflare 52x or a dead connection** is retried a few
 * times with backoff, because Phase 4's sync met all three in its first day
 * live: each one failed a whole reconcile pass and paged the error webhook for
 * something that had already fixed itself by the next tick.
 *
 * Bounded, in both cases, because a retry loop against an API that keeps saying
 * no is how an IP gets itself temporarily banned: Discord restricts addresses
 * that make more than 10,000 invalid (401/403/429) requests in ten minutes.
 */
export async function discordFetch(
  { botToken, retry }: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const policy = { ...DEFAULT_RETRY, ...retry };

  /**
   * `new Headers` rather than a spread. Spreading a `Headers` instance yields
   * `{}` and spreading the array form yields numeric keys, so either would drop
   * a caller's `X-Audit-Log-Reason` silently, and an audit log entry that never
   * appears is not something anyone notices.
   */
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${botToken}`);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const method = (init.method ?? "GET").toUpperCase();
  const replayable = IDEMPOTENT_METHODS.has(method) &&
    // A stream body cannot be sent twice, and the second attempt would fail as
    // "body already consumed", which looks nothing like the transport error
    // that caused it.
    (init.body === undefined || init.body === null ||
      typeof init.body === "string");

  let rateLimited = 0;
  let transientTries = 0;

  while (true) {
    /**
     * A fresh signal per attempt: its clock starts when it is created, so one
     * hoisted out of the loop would silently turn a per-attempt timeout into a
     * per-call one. `AbortSignal.any` rather than assigning over the caller's
     * signal, which would honour exactly one of the two.
     */
    const timeout = AbortSignal.timeout(policy.timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout;

    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...init,
        headers,
        signal,
      });
    } catch (error) {
      // The caller asked us to stop. That is not a failure to retry around.
      if (init.signal?.aborted) throw error;
      transientTries++;
      if (
        !replayable || !isRetriableThrow(error) ||
        transientTries >= policy.transientAttempts
      ) {
        throw error;
      }
      await sleep(jittered(policy.backoffMs[transientTries - 1] ?? 1_000));
      continue;
    }

    if (response.status === 429) {
      rateLimited++;
      if (rateLimited >= RATE_LIMIT_ATTEMPTS) {
        await response.body?.cancel().catch(() => {});
        throw new DiscordApiError(
          429,
          path,
          "still rate limited after 5 attempts; stopping rather than digging in",
        );
      }
      // `retry_after` is seconds, and a float. Read the body rather than the
      // header: the header is per-bucket, the body is what Discord wants us to do.
      const body = await response.json().catch(() => ({})) as {
        retry_after?: number;
      };
      await sleep(Math.ceil((body.retry_after ?? 1) * 1000) + 100);
      continue;
    }

    if (isTransientStatus(response.status) && replayable) {
      transientTries++;
      if (transientTries < policy.transientAttempts) {
        // Release the connection before abandoning the attempt. An unread body
        // holds one open, and `cancel()` rejects if the attempt's own timeout
        // already fired, which must not become the error the caller sees.
        await response.body?.cancel().catch(() => {});
        await sleep(jittered(policy.backoffMs[transientTries - 1] ?? 1_000));
        continue;
      }
    }

    return response;
  }
}

/** As `discordFetch`, but a non-2xx throws and the body is parsed. */
export async function discordJson<T>(
  options: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await discordFetch(options, path, init);
  if (!response.ok) {
    throw new DiscordApiError(
      response.status,
      path,
      await response.text().catch(() => "(the body could not be read)"),
    );
  }
  try {
    return await response.json() as T;
  } catch (cause) {
    /**
     * A 2xx whose body is not the JSON it claims to be: a Cloudflare
     * interstitial served as 200, a truncated response, or the attempt's
     * timeout expiring during the read. Callers branch on `DiscordApiError` and
     * its status; a bare `SyntaxError` or `DOMException` escaping from here
     * would bypass every one of those branches.
     */
    throw new DiscordApiError(
      response.status,
      path,
      `the response body could not be read as JSON: ${String(cause)}`,
    );
  }
}
