import type { APIRoute } from "astro";
import { clearSteamLink, getDb } from "@7r/db";
import { redirectWith, sameOriginGuard } from "../../lib/forms.ts";

/**
 * Unlink Steam. It gates nothing, so this costs the member nothing but the
 * ability of other members to find them in game.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const blocked = sameOriginGuard(request);
  if (blocked) return blocked;

  await clearSteamLink(getDb(), locals.member!.id);

  return redirectWith("/me", { notice: "steam_unlinked" });
};
