import type { APIRoute } from "astro";
import { consumeLinkCode, findLiveLinkCode, getDb } from "@7r/db";
import { assertSameOrigin, redirectWith } from "../../../lib/forms.ts";

/**
 * Abandon the outstanding challenge.
 *
 * The reason this exists: a member who picked the wrong person from the list has
 * poked a code at somebody else and cannot complete it. Without a way out they
 * are stuck on the code-entry screen for five minutes, and the natural thing to
 * do is guess, which burns their attempts. Issuing a new code would also have
 * killed this one (only one challenge is live at a time, see `createLinkCode`),
 * but they cannot get back to the pick-list to issue one.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  assertSameOrigin(request);

  const db = getDb();
  const pending = await findLiveLinkCode(db, locals.member!.id);
  if (pending) await consumeLinkCode(db, pending.id);

  return redirectWith("/link/teamspeak");
};
