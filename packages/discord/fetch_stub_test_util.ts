/**
 * A stubbed `globalThis.fetch`, shared by this package's tests.
 *
 * Every test here exercises an HTTP shape against a live-looking Discord: the
 * retry loop, the pagination walks. None of them can reach the real API (there
 * is no test guild, ARCHITECTURE §9), so they all need the same stub, and it
 * had started to exist twice.
 *
 * `_test_util` in the name keeps `deno test`'s own discovery from treating this
 * file as a test: it defines no `Deno.test` and would otherwise be reported as
 * a module with no tests in it.
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
 * request (a fresh body each time), and a `Response` is cloned so the same one
 * can be served repeatedly.
 */
export function stubFetch(
  responses: (Response | Error | (() => Response))[],
): Stub {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  let index = 0;

  globalThis.fetch = ((url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index++;
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(typeof next === "function" ? next() : next.clone());
  }) as typeof globalThis.fetch;

  return { calls, restore: () => (globalThis.fetch = original) };
}

/** A 200 carrying JSON. */
export const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200 });

/** A failure status carrying a plain-text body. */
export const status = (code: number, body = "upstream said no") =>
  new Response(body, { status: code });
