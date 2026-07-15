import type { APIRoute } from "astro";
import { clearTeamspeakLink, getDb } from "@7r/db";
import { redirectWith, sameOriginGuard } from "../../lib/forms.ts";

/**
 * Unlink TeamSpeak.
 *
 * Self-service, because members must be able to undo their own links and request
 * deletion (ARCHITECTURE §7, GDPR-lite). It does not un-attribute attendance
 * already credited to them: see `clearTeamspeakLink`.
 *
 * The next role sync will strip their TeamSpeak groups, because the reconcile
 * iterates members with a linked `ts_uid` and they no longer have one. That is
 * the intended consequence, not a bug.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const blocked = sameOriginGuard(request);
  if (blocked) return blocked;

  await clearTeamspeakLink(getDb(), locals.member!.id);

  return redirectWith("/me", { notice: "ts_unlinked" });
};
