/**
 * A stubbed `globalThis.fetch`, shared by this package's tests.
 *
 * Every test here exercises an HTTP shape against a live-looking Discord: the
 * retry loop, the pagination walks. None of them can reach the real API (there
 * is no test guild, ARCHITECTURE §9), so they all need the same stub, and it
 * had started to exist twice.
 *
 * `_test_util` in the name keeps `node --test`'s own discovery (`*_test`) from
 * treating this file as a test: it registers no tests and would otherwise be
 * run as a test file with nothing in it.
 */

export interface Stub {
  /** Every call made while the stub was installed, in order. */
  calls: { url: string; init: RequestInit }[];
  /** Call in a `finally`: a leaked stub breaks whatever test runs next. */
  restore(): void;
}

/**
 * Serve the given responses in order; the last one repeats.
 *
 * An `Error` entry rejects (a dead connection), a function entry is called per
 * request (a fresh body each time), and a `Response` is rebuilt from its text so the
 * same one can be served repeatedly. (Not `clone()`: on Node, cancelling the body
 * of one branch of a cloned Response never resolves while the other branch is
 * unread, which hangs the retry loop's `body.cancel()`.)
 */
export function stubFetch(
  responses: (Response | Error | (() => Response))[],
): Stub {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  globalThis.fetch = (async (
    url: string | URL | Request,
    init: RequestInit = {},
  ) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    const text = next.body === null ? null : await next.clone().text();
    return new Response(text, { status: next.status, headers: next.headers });
  }) as typeof globalThis.fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

/** A 200 carrying JSON. */
export const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200 });

/** A failure status carrying a plain-text body. */
export const status = (code: number, body = "upstream said no") =>
  new Response(body, { status: code });
