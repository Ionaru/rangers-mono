/**
 * Steam OpenID 2.0, by hand.
 *
 * No library: the whole protocol, for our purposes, is "send them there, and
 * ask Steam whether what came back is real". OpenID 2.0 is dead everywhere else
 * and Steam is the last thing standing on it, so a dependency here would be a
 * dependency on someone else's maintenance of a dead protocol.
 *
 * What this proves is account ownership, and what it yields is a SteamID64. It
 * is a plain profile field: optional, gates nothing, applies no vetting rule,
 * and a member without one is not incomplete (ADR 0009, CONTEXT.md).
 */

const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

const OPENID_NS = "http://specs.openid.net/auth/2.0";
const OPENID_IDENTIFIER_SELECT =
  "http://specs.openid.net/auth/2.0/identifier_select";

/**
 * Where to send the member.
 *
 * `identifier_select` for both `identity` and `claimed_id` is the "you tell me
 * who they are" mode: we do not know their SteamID64 yet, which is the entire
 * point of asking.
 */
export function buildSteamLoginUrl(
  options: { realm: string; returnTo: string },
): string {
  const params = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.identity": OPENID_IDENTIFIER_SELECT,
    "openid.claimed_id": OPENID_IDENTIFIER_SELECT,
    "openid.return_to": options.returnTo,
    "openid.realm": options.realm,
  });

  return `${STEAM_OPENID_ENDPOINT}?${params}`;
}

/**
 * Exactly 17 digits, and anchored at both ends.
 *
 * The strictness is the security property. `claimed_id` is a URL that an
 * attacker controls the shape of, so a loose pattern (an unanchored match, or
 * `\d+`) is how you end up trusting
 * `https://steamcommunity.com/openid/id/123.evil.com` or extracting an id from
 * something that was never a Steam URL at all. The only thing that may match is
 * a canonical Steam identity URL (IMPLEMENTATION §4).
 */
const CLAIMED_ID_PATTERN =
  /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export type SteamVerification =
  | { ok: true; steamId: string }
  | { ok: false; reason: string };

/**
 * Verify what Steam sent back, and extract the SteamID64.
 *
 * Statelessly, with `check_authentication`: Steam does not support OpenID
 * associations, so there is no shared secret to validate a signature against
 * locally. We hand the assertion straight back and ask Steam whether it signed
 * it. That is a network call on every link, and it is the only thing standing
 * between us and a member linking any Steam account they like by editing a query
 * string.
 *
 * `fetchImpl` is injectable so the verification logic can be tested without the
 * network, which is the whole reason this function takes the params rather than
 * a Request.
 */
export async function verifySteamCallback(
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<SteamVerification> {
  const claimedId = params.get("openid.claimed_id");
  if (!claimedId) {
    return { ok: false, reason: "no openid.claimed_id in the callback" };
  }

  // Check the shape BEFORE asking Steam. A claimed_id that is not a Steam
  // identity URL is not something to send back for signing; it is a probe.
  const match = CLAIMED_ID_PATTERN.exec(claimedId);
  if (!match) {
    return {
      ok: false,
      reason: "openid.claimed_id is not a Steam identity URL",
    };
  }
  const steamId = match[1];

  // Echo every openid.* parameter back verbatim, with only the mode swapped.
  // Verbatim matters: this is a signed assertion, and dropping or reordering a
  // signed field makes Steam say `is_valid:false` and look like an attack.
  const body = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  const response = await fetchImpl(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    return { ok: false, reason: `Steam returned ${response.status}` };
  }

  // The response is key:value lines, not JSON. Require the affirmative; anything
  // else, including a body we cannot parse, is a refusal.
  const text = await response.text();
  const isValid = text
    .split("\n")
    .some((line) => line.trim() === "is_valid:true");

  if (!isValid) {
    return { ok: false, reason: "Steam did not validate the assertion" };
  }

  return { ok: true, steamId };
}
