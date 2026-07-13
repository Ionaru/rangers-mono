import type { APIRoute } from "astro";
import { getDb, isUniqueViolation, setSteamLink } from "@7r/db";
import { verifySteamCallback } from "@7r/identity";
import { redirectWith } from "../../../lib/forms.ts";

/**
 * Steam sent them back. Prove it, then store the SteamID64.
 *
 * No same-origin check here, and that is not an oversight: this request arrives
 * as a top-level GET redirect *from Steam*, so it has no Origin of ours and
 * never could. What stands in for it is stronger: the assertion in the query
 * string is signed by Steam, and `verifySteamCallback` hands the whole thing
 * back to Steam and asks whether that signature is real. A forged callback
 * cannot survive that, which is the entire reason the check exists.
 *
 * It is still gated on a session by the middleware, so the account can only ever
 * be linked to the member who is signed in.
 */
export const GET: APIRoute = async ({ url, locals }) => {
  const member = locals.member!;

  const result = await verifySteamCallback(url.searchParams);

  if (!result.ok) {
    console.warn("[web] steam link refused:", result.reason);
    return redirectWith("/me", { error: "steam_failed" });
  }

  try {
    await setSteamLink(getDb(), {
      memberId: member.id,
      steamId: result.steamId,
    });
  } catch (cause) {
    // One member per Steam account: the column is unique. Somebody else has
    // already linked it, which is either a mistake or two people sharing an
    // account, and neither is ours to resolve silently.
    if (isUniqueViolation(cause)) {
      return redirectWith("/me", { error: "steam_taken" });
    }
    throw cause;
  }

  return redirectWith("/me", { notice: "steam_linked" });
};
