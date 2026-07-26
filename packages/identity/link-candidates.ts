/**
 * Which online TeamSpeak clients a member may claim as themselves.
 *
 * Pure, and split out from the worker's `handleClients` for exactly one reason:
 * this is where a real bug lived and where the fix has to be testable. The worker
 * has no test environment (ARCHITECTURE §9), so the rule that decides what to
 * offer takes plain data in and returns plain data out.
 *
 * The rule: an identity already linked to *someone else* is never offered, so the
 * mistake of claiming a teammate's identity is not presented in the first place.
 * An identity linked to *the requester* IS offered, marked `current`, because a
 * re-link (a reinstall, or upgrading a `legacy_import` claim to a verified `poke`
 * link) means picking the identity you already hold. Leaving your own identity
 * out was the bug: a linked member saw an empty list and read it as "you are not
 * connected".
 */

/** An online client, as the worker reports it. */
export interface OnlineClientLite {
  clid: string;
  uid: string;
  nickname: string;
}

/** One member's current TeamSpeak link. */
export interface TeamspeakLink {
  memberId: string;
  tsUid: string;
}

/** An online client a member may pick, with whether it is the one they already hold. */
export interface PickableClient extends OnlineClientLite {
  current: boolean;
}

/**
 * Filter the online clients to the ones `memberId` may claim.
 *
 * `memberId` is optional as a fail-safe, not as a feature. It reaches here from a
 * query parameter on the worker's internal API, and an unidentified request is
 * offered nothing that is already linked: the conservative answer, never someone
 * else's identity. The web link pages used to make exactly that unidentified
 * call; they are gone (ADR 0017) and every caller now names its requester, so the
 * branch is what a malformed request lands on rather than a flow anybody runs.
 * Order is preserved: the caller renders the list as given.
 */
export function pickableClients(input: {
  online: readonly OnlineClientLite[];
  links: readonly TeamspeakLink[];
  memberId?: string;
}): PickableClient[] {
  const { online, links, memberId } = input;

  const owner = new Map(links.map((link) => [link.tsUid, link.memberId]));

  const pickable: PickableClient[] = [];
  for (const client of online) {
    const linkedTo = owner.get(client.uid);
    // Unlinked: anyone may claim it.
    if (linkedTo === undefined) {
      pickable.push({ ...client, current: false });
      continue;
    }
    // Linked to the requester: their current identity, offered and marked.
    if (memberId !== undefined && linkedTo === memberId) {
      pickable.push({ ...client, current: true });
      continue;
    }
    // Linked to someone else (or nobody is identified): not offered.
  }
  return pickable;
}
