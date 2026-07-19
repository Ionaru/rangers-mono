import type { AssignableRef } from "./types.ts";
import { resolveRank } from "./rank.ts";

/**
 * The Discord -> TeamSpeak group reconcile (ARCHITECTURE §4.4, IMPLEMENTATION
 * §6). This is one of the two functions the test suite exists for, and it is
 * pure on purpose: plain data in, plain data out, no I/O, no clock, no
 * environment. The worker gathers the inputs (the guild poll, the member list,
 * each identity's current server groups) and applies the outputs; everything
 * that can be *wrong* about a sync pass is decided here, where it is testable
 * without a live server.
 *
 * Sgids are numbers here, matching the database's `assignable.ts_sgid integer`.
 * The TeamSpeak library speaks strings; the worker converts at the boundary and
 * this module never sees them.
 */

/** One entry of the Assignable mapping, as the reconcile needs it. */
export interface MappedAssignable extends AssignableRef {
  /** null = defined in Discord but not mirrored to TeamSpeak (Mission maker). */
  tsSgid: number | null;
}

/**
 * The whole mapping, keyed by Discord role id: the snowflake is the only join
 * key between a member's Discord roles and the groups we own (ADR 0002).
 */
export type AssignableMapping = ReadonlyMap<string, MappedAssignable>;

/**
 * The owned set: every TeamSpeak group the mapping claims. The reconcile only
 * ever adds or removes within this set; every other group on the server
 * (Server Admin, Server Query, channel groups, one-off manual grants) is
 * invisible to it and persists untouched (ADR 0002).
 */
export function ownedSgids(mapping: AssignableMapping): ReadonlySet<number> {
  const owned = new Set<number>();
  for (const entry of mapping.values()) {
    if (entry.tsSgid !== null) owned.add(entry.tsSgid);
  }
  return owned;
}

/** Everything the reconcile needs to know about one member. */
export interface MemberSyncInput {
  /** Opaque to the reconcile; echoed into the plan so the worker can apply it. */
  memberId: string;
  /** For logs and the preview only. Decides nothing. */
  displayName: string;
  tsUid: string;
  /**
   * Present in the guild poll. `false` means they left or were kicked: their
   * roles are treated as none, so every owned group falls off. That inversion
   * (iterate OUR members, not the guild list) is the leaver fix the whole
   * design hangs on (§4.4); a leaver needs no special case here.
   */
  inGuild: boolean;
  /** Their Discord role ids from the poll. Empty for a leaver. */
  discordRoleIds: readonly string[];
  /** `member.disabled_at` is already stamped: stamp it only the first time. */
  alreadyDisabled: boolean;
  /**
   * Every group the identity holds on TeamSpeak, raw and unfiltered, or `null`
   * when the pass could not read it (the server does not know this uid, or the
   * ServerQuery lookup threw). `null` is not "holds nothing": it is "we do not
   * know", so the group reconcile produces no adds or removes for them. The
   * `disabled_at` decision below is a Discord fact and is still made, so a
   * leaver whose TeamSpeak link is broken is still stamped (§4.4) rather than
   * silently skipped.
   */
  currentSgids: readonly number[] | null;
}

/** What one member's sync should do. Both sets are subsets of `owned`. */
export interface MemberSyncPlan {
  memberId: string;
  displayName: string;
  tsUid: string;
  toAdd: number[];
  toRemove: number[];
  /** First time seen missing from the guild: stamp `disabled_at` (§4.4). */
  stampDisabled: boolean;
  /**
   * Seen back in the guild while `disabled_at` is set: clear it. The docs only
   * say when to stamp; clearing on return is this module's call, made because
   * the column's documented meaning is "seen missing from the guild" and
   * leaving it set on a rejoiner would make it a lie.
   */
  clearDisabled: boolean;
  /** Discord states that should not be (e.g. two rank roles). Mirrored, not fixed. */
  warnings: string[];
}

/**
 * The three-way reconcile for one member: desired (from Discord) versus current
 * (on TeamSpeak), both clamped to the owned set.
 */
export function planMemberSync(
  input: MemberSyncInput,
  mapping: AssignableMapping,
  owned: ReadonlySet<number>,
): MemberSyncPlan {
  const warnings: string[] = [];

  /**
   * The member's roles resolved through the mapping. A role id the mapping does
   * not know is somebody else's Discord role and contributes nothing; a mapped
   * assignable with a null sgid (Mission maker) is real in Discord but has no
   * TeamSpeak shadow, so it contributes nothing either.
   */
  const held: MappedAssignable[] = [];
  for (const roleId of input.discordRoleIds) {
    const entry = mapping.get(roleId);
    if (entry) held.push(entry);
  }

  /**
   * Rank is exclusive, and Discord is the truth, so a member with two rank
   * roles is a Discord problem to report, not a sync problem to solve. Both
   * sgids stay in the desired set: the sync mirrors what Discord says, and the
   * fix belongs where the truth lives (§6 step 6).
   */
  const { conflicting } = resolveRank(held);
  if (conflicting.length > 0) {
    const names = held.filter((a) => a.kind === "rank").map((a) => a.name);
    warnings.push(
      `holds ${names.length} rank roles in Discord (${
        names.join(", ")
      }); rank is exclusive, fix it in Discord`,
    );
  }

  // The group reconcile runs only when we actually know the member's TeamSpeak
  // state. `currentSgids === null` means the pass could not read it (identity
  // unknown to the server, or a ServerQuery error): we cannot honestly diff
  // groups we cannot see, so we touch none. The disabled_at decision below is a
  // pure Discord fact and is made regardless, which is the whole point: it must
  // not wait on TeamSpeak, or a leaver with a broken link is never stamped.
  let toAdd: number[] = [];
  let toRemove: number[] = [];
  if (input.currentSgids !== null) {
    const desired = new Set<number>();
    for (const entry of held) {
      if (entry.tsSgid !== null && owned.has(entry.tsSgid)) {
        desired.add(entry.tsSgid);
      }
    }

    // Clamping current to owned is the guarantee that a manual grant, Server
    // Admin, or anything else outside the mapping can never appear in toRemove.
    const current = new Set(input.currentSgids.filter((s) => owned.has(s)));

    toAdd = [...desired].filter((s) => !current.has(s)).sort((a, b) => a - b);
    toRemove = [...current].filter((s) => !desired.has(s)).sort((a, b) =>
      a - b
    );
  }

  return {
    memberId: input.memberId,
    displayName: input.displayName,
    tsUid: input.tsUid,
    toAdd,
    toRemove,
    stampDisabled: !input.inGuild && !input.alreadyDisabled,
    clearDisabled: input.inGuild && input.alreadyDisabled,
    warnings,
  };
}

/** A whole pass, with the blast-radius decision already made. */
export interface SyncPassPlan {
  /** Every member considered, no-ops included: the preview wants totals. */
  members: MemberSyncPlan[];
  /** The ones with something to do (a diff, a stamp, or a clear). */
  changed: MemberSyncPlan[];
  /**
   * The blast-radius guard tripped: apply NOTHING from this pass, additions and
   * disabled_at stamps included. "Additions are never blocked" (§6) means adds
   * never *trip* the guard, not that they survive a halted pass: a pass this
   * wrong (a bad mapping, a garbage poll) is not to be trusted for any write.
   */
  halted: boolean;
  /** Members whose toRemove is non-empty. What the guard counts. */
  removalMemberCount: number;
  maxRemovals: number;
}

/**
 * Plan a full reconcile pass and apply the blast-radius guard (§6 step 4).
 *
 * The guard counts *members losing groups*, not groups lost: one demotion
 * removing four groups is one member. Normal operation touches 0-2 people, so
 * a pass wanting to strip more than `maxRemovals` members is definitionally a
 * bug, and the only safe reaction is to do nothing and say so loudly. It is a
 * standing guard, not a first-run check: the dry-run protects run #1, this
 * protects run #200.
 */
export function planSyncPass(
  inputs: readonly MemberSyncInput[],
  mapping: AssignableMapping,
  options: { maxRemovals: number },
): SyncPassPlan {
  const owned = ownedSgids(mapping);
  const members = inputs.map((input) => planMemberSync(input, mapping, owned));
  const changed = members.filter((m) =>
    m.toAdd.length > 0 || m.toRemove.length > 0 || m.stampDisabled ||
    m.clearDisabled
  );
  const removalMemberCount =
    members.filter((m) => m.toRemove.length > 0).length;

  return {
    members,
    changed,
    halted: removalMemberCount > options.maxRemovals,
    removalMemberCount,
    maxRemovals: options.maxRemovals,
  };
}
