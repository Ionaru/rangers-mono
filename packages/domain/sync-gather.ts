import {
  type AssignableMapping,
  desiredSgids,
  type MemberSyncInput,
  ownedSgids,
} from "./reconcile.ts";

/**
 * Turning "who holds each owned group" into "what does each member hold".
 *
 * The reconcile used to ask TeamSpeak about each member in turn: two commands
 * each, two hundred commands a pass, and a permanent flood (throttle.ts). It now
 * asks about each owned GROUP instead: fifteen commands, whatever the roster
 * does. This function is the join in the middle, and it is pure because the join
 * is where the change can go wrong: an identity matched to the wrong TeamSpeak
 * client, or a member wrongly believed to hold nothing, is a group written to
 * the wrong person or stripped from the right one.
 *
 * **It does not change which side is authoritative.** The pass still iterates
 * OUR members and reads their roles from Discord (ARCHITECTURE §4.4): a leaver
 * still falls out with no special case, because nothing here is driven by who
 * TeamSpeak happens to know. The group lists are a lookup table, not the
 * iteration order.
 */

/** One holder of one owned group, as `servergroupclientlist -names` reports it. */
export interface GroupHolder {
  /** The durable TeamSpeak database id, which is what a group write addresses. */
  cldbid: string;
  /** The identity, which is what `member.ts_uid` stores. */
  uid: string;
}

/** A member's Discord side, which the caller has already resolved from the poll. */
export type GatherMemberInput = Omit<MemberSyncInput, "currentSgids">;

/** A member who needs a per-identity lookup before their adds can be applied. */
export interface ProbeTarget {
  memberId: string;
  displayName: string;
  tsUid: string;
}

export interface GatheredMember {
  displayName: string;
  tsUid: string;
}

export interface GatherResult {
  /** Ready for `planSyncPass`, one per member, in the order given. */
  inputs: MemberSyncInput[];
  /** Resolved for everyone who holds at least one owned group. */
  cldbidByMemberId: Map<string, string>;
  /**
   * Holds no owned group, but Discord says they should hold at least one. Their
   * `currentSgids` is `[]` (a proven fact: they were in none of the lists), so
   * the plan is right; what is missing is the `cldbid` to apply it with. The
   * caller resolves those, and downgrades any it cannot to `null`.
   */
  needsProbe: ProbeTarget[];
  /**
   * Holds no owned group and Discord wants none either: nothing to do, so no
   * lookup was spent on them. The cost of the cheap pass is that a dead or
   * mistyped `ts_uid` on such a member is no longer noticed, which is why they
   * are named rather than merely counted.
   */
  notLookedUp: GatheredMember[];
  /**
   * Their TeamSpeak state could not be read honestly, so `currentSgids` is
   * `null` and no group is touched. Their `disabled_at` still follows Discord.
   */
  unresolved: (GatheredMember & { reason: string })[];
  /**
   * Groups whose holder list came back in a shape that cannot be joined: an
   * entry with no uid or no cldbid, or one client listed twice in the same
   * group. Never a normal condition. Keyed by sgid so the caller can exclude
   * exactly those groups rather than the whole pass, which is what it does for a
   * group it could not read at all: the two are the same problem (we cannot see
   * who holds this group) arriving by different routes.
   */
  malformedBySgid: Map<number, number>;
}

/**
 * @param members every member with a linked `ts_uid`, Discord side already resolved
 * @param holdersBySgid one entry per owned group that could be READ this pass;
 *   a group missing from this map is one the caller decided not to reconcile,
 *   and it must already have been dropped from `mapping` (see sync.ts). Entries
 *   for sgids outside the owned set are ignored.
 * @param mapping the Assignable mapping, after any dead or unreadable sgid has
 *   been nulled out. Both `owned` and `desired` come from it, so the two can
 *   never disagree about which groups this pass is willing to touch.
 */
export function gatherSyncInputs(
  members: readonly GatherMemberInput[],
  holdersBySgid: ReadonlyMap<number, readonly GroupHolder[]>,
  mapping: AssignableMapping,
): GatherResult {
  const owned = ownedSgids(mapping);

  /** uid -> the client it resolves to, and which owned groups it holds. */
  const holding = new Map<string, { cldbid: string; sgids: Set<number> }>();
  /** The same relation the other way round, purely to catch it disagreeing. */
  const uidByCldbid = new Map<string, string>();
  /**
   * Identities the group lists describe inconsistently. The library merges the
   * first response entry into every later one, so a single response entry that
   * is missing a field silently inherits another client's value: a uid paired
   * with the wrong cldbid is a group written to the wrong person. Neither
   * direction of that mapping can legitimately be many-to-one, so a repeat with
   * a different partner is proof the response cannot be trusted for that
   * identity, and it is dropped rather than acted on.
   */
  const conflicted = new Set<string>();
  const malformedBySgid = new Map<number, number>();
  const countMalformed = (sgid: number) =>
    malformedBySgid.set(sgid, (malformedBySgid.get(sgid) ?? 0) + 1);

  for (const [sgid, holders] of holdersBySgid) {
    if (!owned.has(sgid)) continue;
    /**
     * A group cannot legitimately list the same client twice, so a repeat is
     * the merge quirk above showing up in its one undetectable form: an entry
     * that inherited BOTH fields from the first entry, which is byte-identical
     * to a real holder and would otherwise be absorbed silently, losing whoever
     * that entry was really about and with them their removal.
     */
    const seenInGroup = new Set<string>();

    for (const holder of holders) {
      // Falsy, not `=== ""`: an absent key parses to undefined while the
      // library's types promise a string, so TypeScript will not catch it.
      if (!holder.uid || !holder.cldbid) {
        countMalformed(sgid);
        continue;
      }
      if (seenInGroup.has(holder.cldbid)) {
        countMalformed(sgid);
        continue;
      }
      seenInGroup.add(holder.cldbid);

      const seenUid = uidByCldbid.get(holder.cldbid);
      if (seenUid === undefined) {
        uidByCldbid.set(holder.cldbid, holder.uid);
      } else if (seenUid !== holder.uid) {
        conflicted.add(seenUid);
        conflicted.add(holder.uid);
      }

      const held = holding.get(holder.uid);
      if (held === undefined) {
        holding.set(holder.uid, {
          cldbid: holder.cldbid,
          sgids: new Set([sgid]),
        });
      } else {
        if (held.cldbid !== holder.cldbid) conflicted.add(holder.uid);
        held.sgids.add(sgid);
      }
    }
  }

  const inputs: MemberSyncInput[] = [];
  const cldbidByMemberId = new Map<string, string>();
  const needsProbe: ProbeTarget[] = [];
  const notLookedUp: GatheredMember[] = [];
  const unresolved: (GatheredMember & { reason: string })[] = [];

  for (const member of members) {
    const named = { displayName: member.displayName, tsUid: member.tsUid };

    // `ts_uid` is only constrained NOT NULL-ish by the query that selects these
    // rows, so an empty one is reachable (a bad import, a bad force-link). It
    // joins to nothing and cannot be looked up, so it is not "holds nothing".
    if (member.tsUid === "") {
      unresolved.push({ ...named, reason: "member has an empty ts_uid" });
      inputs.push({ ...member, currentSgids: null });
      continue;
    }

    if (conflicted.has(member.tsUid)) {
      unresolved.push({
        ...named,
        reason:
          "TeamSpeak reported this identity with more than one client database id; the group lists cannot be trusted for them",
      });
      inputs.push({ ...member, currentSgids: null });
      continue;
    }

    const held = holding.get(member.tsUid);
    if (held !== undefined) {
      cldbidByMemberId.set(member.memberId, held.cldbid);
      inputs.push({
        ...member,
        currentSgids: [...held.sgids].sort((a, b) => a - b),
      });
      continue;
    }

    // Absent from every owned group's holder list. Because those lists are
    // complete for the groups this pass is willing to touch, that is a positive
    // answer and not a gap: they hold none of them.
    inputs.push({ ...member, currentSgids: [] });
    if (desiredSgids(member.discordRoleIds, mapping, owned).size > 0) {
      needsProbe.push({
        memberId: member.memberId,
        displayName: member.displayName,
        tsUid: member.tsUid,
      });
    } else {
      notLookedUp.push(named);
    }
  }

  return {
    inputs,
    cldbidByMemberId,
    needsProbe,
    notLookedUp,
    unresolved,
    malformedBySgid,
  };
}
