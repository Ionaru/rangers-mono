import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { buildSteamLoginUrl, verifySteamCallback } from "./steam.ts";

const STEAM_ID = "76561198009917136";

/** A callback as Steam actually sends it: signed openid.* params in the query string. */
function callbackParams(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.identity": `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    "openid.return_to": "https://7th-ranger.com/link/steam/callback",
    "openid.response_nonce": "2026-07-11T20:00:00Zabcdef",
    "openid.assoc_handle": "1234567890",
    "openid.signed":
      "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "aG9uZXN0bHktYS1zaWduYXR1cmU=",
    ...over,
  });
}

/** Steam's verification response is key:value lines, not JSON. */
function steamSays(valid: boolean, status = 200): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${valid}\n`, {
        status,
      }),
    );
}

Deno.test("the login URL asks Steam to tell us who they are", () => {
  const url = buildSteamLoginUrl({
    realm: "https://7th-ranger.com",
    returnTo: "https://7th-ranger.com/link/steam/callback",
  });

  assertStringIncludes(url, "https://steamcommunity.com/openid/login?");
  assertStringIncludes(url, "openid.mode=checkid_setup");
  // identifier_select for both: we do not know the SteamID64 yet, which is the point.
  assertStringIncludes(
    url,
    "openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select",
  );
  assertStringIncludes(
    url,
    "openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select",
  );
  assertStringIncludes(
    url,
    "openid.return_to=https%3A%2F%2F7th-ranger.com%2Flink%2Fsteam%2Fcallback",
  );
  assertStringIncludes(url, "openid.realm=https%3A%2F%2F7th-ranger.com");
});

Deno.test("a Steam-validated callback yields the SteamID64", async () => {
  const result = await verifySteamCallback(callbackParams(), steamSays(true));
  assertEquals(result, { ok: true, steamId: STEAM_ID });
});

Deno.test("is_valid:false is refused", async () => {
  // The whole point of check_authentication: without this, anyone can link any
  // Steam account by editing the query string.
  const result = await verifySteamCallback(callbackParams(), steamSays(false));
  assertEquals(result.ok, false);
});

Deno.test("a Steam outage is refused, not waved through", async () => {
  const result = await verifySteamCallback(
    callbackParams(),
    steamSays(true, 503),
  );
  assertEquals(result.ok, false);
});

Deno.test("an unparseable response is refused", async () => {
  const garbage: typeof fetch = () =>
    Promise.resolve(new Response("<html>go away</html>", { status: 200 }));
  const result = await verifySteamCallback(callbackParams(), garbage);
  assertEquals(result.ok, false);
});

Deno.test("a claimed_id that is not a Steam identity URL never reaches Steam", async () => {
  let called = false;
  const spy: typeof fetch = () => {
    called = true;
    return Promise.resolve(new Response("is_valid:true"));
  };

  const hostile = [
    // A lookalike host.
    "https://steamcommunity.com.evil.test/openid/id/76561198009917136",
    // A suffix after the id.
    "https://steamcommunity.com/openid/id/76561198009917136/../../evil",
    // A prefix before the scheme.
    "https://evil.test/https://steamcommunity.com/openid/id/76561198009917136",
    // Not 17 digits.
    "https://steamcommunity.com/openid/id/123",
    // Not digits at all.
    "https://steamcommunity.com/openid/id/notasteamid00000",
    // Plain http.
    "http://steamcommunity.com/openid/id/76561198009917136",
  ];

  for (const claimedId of hostile) {
    const result = await verifySteamCallback(
      callbackParams({ "openid.claimed_id": claimedId }),
      spy,
    );
    assertEquals(result.ok, false, `should have refused ${claimedId}`);
  }

  // Not one of them was worth asking Steam about.
  assert(!called, "a malformed claimed_id must not be sent to Steam");
});

Deno.test("a callback with no claimed_id is refused", async () => {
  const params = callbackParams();
  params.delete("openid.claimed_id");
  const result = await verifySteamCallback(params, steamSays(true));
  assertEquals(result.ok, false);
});

Deno.test("the assertion is echoed back verbatim, with only the mode changed", async () => {
  let sent: URLSearchParams | undefined;
  const capture: typeof fetch = (_url, init) => {
    sent = new URLSearchParams(init?.body as URLSearchParams);
    return Promise.resolve(new Response("is_valid:true"));
  };

  await verifySteamCallback(callbackParams(), capture);

  assert(sent);
  // Steam signed these fields. Drop or reorder one and it says is_valid:false.
  assertEquals(sent.get("openid.mode"), "check_authentication");
  assertEquals(sent.get("openid.sig"), "aG9uZXN0bHktYS1zaWduYXR1cmU=");
  assertEquals(
    sent.get("openid.signed"),
    "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
  );
  assertEquals(sent.get("openid.response_nonce"), "2026-07-11T20:00:00Zabcdef");
});
