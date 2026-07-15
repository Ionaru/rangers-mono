import type { APIRoute } from "astro";
import {
  completeTeamspeakLink,
  consumeLinkCode,
  findLiveLinkCode,
  getDb,
  isUniqueViolation,
  recordLinkCodeAttempt,
} from "@7r/db";
import { verifyLinkCode } from "@7r/identity";
import { redirectWith, sameOriginGuard } from "../../../lib/forms.ts";
import { fetchOnlineClients } from "../../../lib/worker-client.ts";

/**
 * The last step: they typed the code back, so link the identity.
 *
 * This is the one route in the flow where being careless would let somebody
 * claim a teammate's TeamSpeak identity, so the decision is deliberately not
 * made here. `verifyLinkCode` is a pure function in `@7r/identity` with tests
 * against every way it can go wrong (expired, consumed, wrong code, out of
 * attempts, and a dead challenge being used as a guessing oracle). This route
 * does the I/O the verdict asks for and nothing else.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const blocked = sameOriginGuard(request);
  if (blocked) return blocked;

  const member = locals.member!;
  const db = getDb();

  const form = await request.formData();
  const submitted = form.get("code");

  if (typeof submitted !== "string") {
    return redirectWith("/link/teamspeak", { error: "no_pending" });
  }

  const challenge = await findLiveLinkCode(db, member.id);
  if (!challenge) {
    // Nothing outstanding: expired, already used, or they never started one.
    return redirectWith("/link/teamspeak", { error: "no_pending" });
  }

  const verdict = verifyLinkCode(challenge, submitted, new Date());

  if (!verdict.ok) {
    // A wrong guess costs an attempt. Out of attempts burns the challenge, so it
    // cannot be ground down over five separate page loads.
    if (verdict.reason === "wrong_code") {
      await recordLinkCodeAttempt(db, challenge.id);
    } else if (verdict.reason === "too_many_attempts") {
      await recordLinkCodeAttempt(db, challenge.id);
      await consumeLinkCode(db, challenge.id);
    }

    return redirectWith("/link/teamspeak", { error: verdict.reason });
  }

  /**
   * The nickname, best-effort.
   *
   * It is decoration: the `uid` is the identity, and everything downstream (the
   * group sync, attendance) keys on that. So this is allowed to fail. If the
   * worker blips in the two minutes between the poke and the code being typed
   * back, the link still completes with a null nickname rather than telling a
   * member who did everything right that it did not work.
   */
  let tsNickname: string | null = null;
  try {
    const online = await fetchOnlineClients();
    tsNickname = online.find((client) =>
      client.uid === challenge.targetTsUid
    )?.nickname ??
      null;
  } catch {
    // Deliberately swallowed. See above.
  }

  try {
    /**
     * Burn the code, write the identity, and adopt any guest attendance that
     * TeamSpeak identity had accrued before it was linked. One transaction
     * (@7r/db), because a half-applied link is a link nobody can explain.
     */
    await completeTeamspeakLink(db, {
      memberId: member.id,
      linkCodeId: challenge.id,
      tsUid: challenge.targetTsUid,
      tsNickname,
    });
  } catch (cause) {
    /**
     * Somebody else linked that identity between the pick-list being rendered
     * and this write. The list already hides taken identities, but that check
     * and this write are not atomic, and only the database can be.
     *
     * The member is not at fault and there is nothing they can do, so say what
     * happened rather than showing them a 500.
     */
    if (isUniqueViolation(cause)) {
      await consumeLinkCode(db, challenge.id);
      return redirectWith("/link/teamspeak", { error: "ts_taken" });
    }
    throw cause;
  }

  return redirectWith("/me", { notice: "ts_linked" });
};
