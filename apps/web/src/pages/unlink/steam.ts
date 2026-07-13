import type { APIRoute } from "astro";
import { clearSteamLink, getDb } from "@7r/db";
import { assertSameOrigin, redirectWith } from "../../lib/forms.ts";

/**
 * Unlink Steam. It gates nothing, so this costs the member nothing but the
 * ability of other members to find them in game.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  assertSameOrigin(request);

  await clearSteamLink(getDb(), locals.member!.id);

  return redirectWith("/me", { notice: "steam_unlinked" });
};
