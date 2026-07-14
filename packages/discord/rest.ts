/**
 * The Discord REST client: plain `fetch`, and it stays plain `fetch`.
 *
 * Not `@discordjs/rest`, which brings 9 transitive dependencies including a
 * second HTTP stack, to buy rate-limit bucketing worth nothing at roughly one
 * request every three minutes (IMPLEMENTATION §1). There is no gateway either
 * (ADR 0003).
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

export interface DiscordRestOptions {
  botToken: string;
}

/**
 * One request, as the bot.
 *
 * `Authorization: Bot <token>` is the whole auth story: the bot token is not an
 * OAuth token and carries no user's consent. It is also why guild roles come
 * from here rather than from the login (IMPLEMENTATION §4): this works with the
 * user absent, needs no scope, and never expires.
 */
export async function discordFetch(
  { botToken }: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  /**
   * Retry a 429, and only a 429.
   *
   * The project reads Discord about once every three minutes, which is why it
   * does not carry `@discordjs/rest` and its rate-limit bucketing (IMPLEMENTATION
   * §1). But a one-shot backfill fires eighty role writes down the same route in
   * a few seconds, and Discord will absolutely rate-limit that. Honouring
   * `retry_after` costs six lines; being throttled halfway through a backfill and
   * not knowing which grants landed costs an afternoon.
   *
   * Bounded, because a retry loop against an API that keeps saying no is how an
   * IP gets itself temporarily banned: Discord restricts addresses that make more
   * than 10,000 invalid (401/403/429) requests in ten minutes.
   */
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${botToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (response.status !== 429) return response;

    // `retry_after` is seconds, and a float. Read the body rather than the
    // header: the header is per-bucket, the body is what Discord wants us to do.
    const body = await response.json().catch(() => ({})) as {
      retry_after?: number;
    };
    const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  throw new DiscordApiError(
    429,
    path,
    "still rate limited after 5 attempts; stopping rather than digging in",
  );
}

/** As `discordFetch`, but a non-2xx throws and the body is parsed. */
export async function discordJson<T>(
  options: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await discordFetch(options, path, init);
  if (!response.ok) {
    throw new DiscordApiError(response.status, path, await response.text());
  }
  return await response.json() as T;
}
