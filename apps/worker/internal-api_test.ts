import { assertEquals } from "@std/assert";
import type { Db } from "@7r/db";
import type { TeamspeakConnection } from "@7r/teamspeak";
import { createInternalApiHandler } from "./internal-api.ts";

/**
 * The internal API is the one authorisation boundary in the system: everything
 * behind it can read who is on TeamSpeak and poke any of them. It is reachable
 * from anything on the Compose network, so "it has no published port" is not the
 * control, the bearer token is.
 *
 * That check is pure request-handling, so it is testable without a TeamSpeak
 * server, and it is worth testing precisely because the rest of this package
 * cannot be.
 */

const TOKEN = "correct-horse-battery-staple-and-then-some";

/** Enough of a Db to answer `ping`, which is all /healthz needs. */
const fakeDb = { execute: () => Promise.resolve() } as unknown as Db;

/** Never called in these tests: every one of them is refused before it gets here. */
const fakeTeamspeak = {} as unknown as TeamspeakConnection;

function handler() {
  return createInternalApiHandler({
    db: fakeDb,
    teamspeak: fakeTeamspeak,
    token: TOKEN,
    log: () => {},
    alert: () => {},
  });
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://worker:8080${path}`, init);
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

Deno.test("/healthz needs no token: the container healthcheck calls it", async () => {
  const response = await handler()(request("/healthz"));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, db: "up" });
});

Deno.test("an internal route with no Authorization header is refused", async () => {
  const response = await handler()(request("/internal/ts/clients"));
  assertEquals(response.status, 401);
});

Deno.test("an internal route with the wrong token is refused", async () => {
  const response = await handler()(
    request("/internal/ts/clients", { headers: bearer("not-the-token") }),
  );
  assertEquals(response.status, 401);
});

Deno.test("a token that is a prefix of the real one is refused", async () => {
  // The failure mode a `startsWith` or a truncating compare would have.
  const response = await handler()(
    request("/internal/ts/clients", {
      headers: bearer(TOKEN.slice(0, TOKEN.length - 1)),
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test("a token with the real one as a prefix is refused", async () => {
  const response = await handler()(
    request("/internal/ts/clients", { headers: bearer(`${TOKEN}extra`) }),
  );
  assertEquals(response.status, 401);
});

Deno.test("an empty bearer token is refused", async () => {
  const response = await handler()(
    request("/internal/ts/clients", { headers: bearer("") }),
  );
  assertEquals(response.status, 401);
});

Deno.test("a non-Bearer Authorization scheme is refused", async () => {
  const response = await handler()(
    request("/internal/ts/clients", {
      headers: { Authorization: `Basic ${TOKEN}` },
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test("the poke route is refused without a token, before the body is even read", async () => {
  // If this ever 400s instead of 401ing, the auth check has drifted below the
  // body parsing and an unauthenticated caller is reaching the handler.
  const response = await handler()(
    request("/internal/ts/poke", {
      method: "POST",
      body: JSON.stringify({ clid: "1", message: "hello" }),
    }),
  );
  assertEquals(response.status, 401);
});

Deno.test("an unknown path is 404, authenticated or not", async () => {
  assertEquals((await handler()(request("/nope"))).status, 404);
  assertEquals(
    (await handler()(request("/internal/nope", { headers: bearer(TOKEN) })))
      .status,
    404,
  );
});

Deno.test("a poke with no clid is a 400, once authenticated", async () => {
  const response = await handler()(
    request("/internal/ts/poke", {
      method: "POST",
      headers: bearer(TOKEN),
      body: JSON.stringify({ message: "hello" }),
    }),
  );
  assertEquals(response.status, 400);
});

Deno.test("a poke with a non-string clid is a 400, not a crash", async () => {
  const response = await handler()(
    request("/internal/ts/poke", {
      method: "POST",
      headers: bearer(TOKEN),
      body: JSON.stringify({ clid: { evil: true }, message: "hello" }),
    }),
  );
  assertEquals(response.status, 400);
});

Deno.test("a poke with an unparseable body is a 400, not a crash", async () => {
  const response = await handler()(
    request("/internal/ts/poke", {
      method: "POST",
      headers: bearer(TOKEN),
      body: "{not json",
    }),
  );
  assertEquals(response.status, 400);
});
