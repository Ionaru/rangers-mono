import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordApiError, discordFetch, discordJson } from "./rest.ts";
import { ok, status, stubFetch } from "./fetch_stub_test_util.ts";

/** Await `fn`, require it to reject with `cls` (and a message with `msg`), return it. */
async function rejects<E extends Error>(
  fn: () => Promise<unknown>,
  cls: new (...args: never[]) => E,
  msg?: string,
): Promise<E> {
  let caught: unknown;
  let rejected = false;
  try {
    await fn();
  } catch (e) {
    caught = e;
    rejected = true;
  }
  assert.ok(rejected, "expected the promise to reject");
  assert.ok(
    caught instanceof cls,
    `expected ${cls.name}, got ${String(caught)}`,
  );
  if (msg !== undefined) {
    assert.ok(
      (caught as Error).message.includes(msg),
      `expected message ${JSON.stringify((caught as Error).message)} to include ${JSON.stringify(msg)}`,
    );
  }
  return caught as E;
}

/**
 * The retry loop, against a stubbed `fetch`.
 *
 * Worth testing precisely because the thing it guards against cannot be
 * reproduced on demand: Discord returned 500, 520 and 522 on three separate days
 * of Phase 4's first week, each failing a whole reconcile pass. What must not
 * regress is which failures are retried (weather) and which are not (a POST that
 * may already have been processed, a 403 that will never fix itself).
 */

const OPTIONS = {
  botToken: "bot-token",
  // No real waiting, and a per-attempt budget long enough that a stub can never
  // race it.
  retry: { backoffMs: [0, 0], timeoutMs: 5_000 },
};

test("a healthy request is made once and returned untouched", async () => {
  const stub = stubFetch([ok({ id: "1" })]);
  try {
    assert.deepStrictEqual(await discordJson(OPTIONS, "/guilds/1"), {
      id: "1",
    });
    assert.deepStrictEqual(stub.calls.length, 1);
    assert.deepStrictEqual(
      new Headers(stub.calls[0].init.headers).get("Authorization"),
      "Bot bot-token",
    );
  } finally {
    stub.restore();
  }
});

test("a 500 on a GET is retried, and the recovery is what the caller sees", async () => {
  const stub = stubFetch([status(500), status(500), ok({ id: "1" })]);
  try {
    assert.deepStrictEqual(await discordJson(OPTIONS, "/guilds/1/members"), {
      id: "1",
    });
    assert.deepStrictEqual(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("a Cloudflare 522 is retried: it never reached Discord at all", async () => {
  const stub = stubFetch([status(522, "<!DOCTYPE html>"), ok({ id: "1" })]);
  try {
    assert.deepStrictEqual(await discordJson(OPTIONS, "/guilds/1/members"), {
      id: "1",
    });
    assert.deepStrictEqual(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("the retries are bounded, and the last failure is reported honestly", async () => {
  const stub = stubFetch([status(503)]);
  try {
    const error = await rejects(
      () => discordJson(OPTIONS, "/guilds/1/members"),
      DiscordApiError,
    );
    assert.deepStrictEqual(error.status, 503);
    // Three tries, not more: an IP that keeps asking gets itself banned.
    assert.deepStrictEqual(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("a 500 on a POST is NOT retried: it may already have been processed", async () => {
  const stub = stubFetch([status(500)]);
  try {
    await rejects(
      () =>
        discordJson(OPTIONS, "/guilds/1/roles", {
          method: "POST",
          body: JSON.stringify({ name: "Medic" }),
        }),
      DiscordApiError,
    );
    // The whole point: a second attempt would be a second badge role.
    assert.deepStrictEqual(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("a 403 is not retried: a missing intent does not fix itself", async () => {
  const stub = stubFetch([status(403, "Missing Access")]);
  try {
    const error = await rejects(
      () => discordJson(OPTIONS, "/guilds/1/members"),
      DiscordApiError,
    );
    assert.deepStrictEqual(error.status, 403);
    assert.deepStrictEqual(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("a dropped connection on a GET is retried", async () => {
  const stub = stubFetch([
    new TypeError("error sending request: connection reset"),
    ok({ id: "1" }),
  ]);
  try {
    assert.deepStrictEqual(await discordJson(OPTIONS, "/guilds/1/members"), {
      id: "1",
    });
    assert.deepStrictEqual(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("a dropped connection that never recovers is thrown, not swallowed", async () => {
  const stub = stubFetch([new TypeError("error sending request")]);
  try {
    await rejects(() => discordJson(OPTIONS, "/guilds/1/members"), TypeError);
    assert.deepStrictEqual(stub.calls.length, 3);
  } finally {
    stub.restore();
  }
});

test("a 429 is honoured and the request is repeated", async () => {
  const stub = stubFetch([
    new Response(JSON.stringify({ retry_after: 0 }), { status: 429 }),
    ok({ id: "1" }),
  ]);
  try {
    assert.deepStrictEqual(await discordJson(OPTIONS, "/guilds/1/members"), {
      id: "1",
    });
    assert.deepStrictEqual(stub.calls.length, 2);
  } finally {
    stub.restore();
  }
});

test("a caller's own headers survive: an audit-log reason must reach Discord", async () => {
  const stub = stubFetch([new Response(null, { status: 204 })]);
  try {
    await discordFetch(OPTIONS, "/guilds/1/members/2/roles/3", {
      method: "PUT",
      headers: new Headers({ "X-Audit-Log-Reason": "badge backfill" }),
    });
    const sent = new Headers(stub.calls[0].init.headers);
    assert.deepStrictEqual(sent.get("X-Audit-Log-Reason"), "badge backfill");
    assert.deepStrictEqual(sent.get("Authorization"), "Bot bot-token");
  } finally {
    stub.restore();
  }
});

test("a 2xx carrying a non-JSON body fails as a Discord error, not a raw SyntaxError", async () => {
  // A Cloudflare interstitial served as 200. Every caller branches on
  // DiscordApiError, so this must not arrive as something else.
  const stub = stubFetch([new Response("<!DOCTYPE html>", { status: 200 })]);
  try {
    const error = await rejects(
      () => discordJson(OPTIONS, "/guilds/1/members"),
      DiscordApiError,
    );
    assert.deepStrictEqual(error.status, 200);
    assert.deepStrictEqual(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("a caller that overrides the policy gets exactly one try", async () => {
  // What the SSR guild gate asks for: a person is waiting, and a slow failure
  // is worse for them than a fast one.
  const stub = stubFetch([status(500)]);
  try {
    await rejects(
      () =>
        discordJson(
          { botToken: "t", retry: { transientAttempts: 1, backoffMs: [] } },
          "/guilds/1/members/2",
        ),
      DiscordApiError,
    );
    assert.deepStrictEqual(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});
