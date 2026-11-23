import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AssignableMapping,
  desiredSgids,
  type MappedAssignable,
  type MemberSyncInput,
  ownedSgids,
  planMemberSync,
  planSyncPass,
} from "./reconcile.ts";

/**
 * The reconcile's required cases (IMPLEMENTATION §11): the leaver, the unmapped
 * role, the manual group outside the owned set, the >1-rank member, and the
 * blast-radius trip. Plus the edges that make the guard exact.
 */

const OFFICER = "role-officer";
const RECRUIT = "role-recruit";
const RECRUITER = "role-recruiter";
const MISSION_MAKER = "role-mission-maker";
const MEDIC = "role-medic";
/** A Discord role that is nobody's Assignable (e.g. a colour role). */
const UNMAPPED_ROLE = "role-unmapped";

/** A TeamSpeak group outside the mapping: Server Admin, a manual grant, etc. */
const MANUAL_SGID = 6;

const entries: [string, MappedAssignable][] = [
  [OFFICER, { kind: "rank", name: "Officer", tsSgid: 71 }],
  [RECRUIT, { kind: "rank", name: "Recruit", tsSgid: 68 }],
  [RECRUITER, { kind: "role", name: "Recruiter", tsSgid: 64 }],
  // Mission maker is real in Discord but has no TeamSpeak group (MIGRATION.md).
  [MISSION_MAKER, { kind: "role", name: "Mission maker", tsSgid: null }],
  [MEDIC, { kind: "badge", name: "Medic", tsSgid: 76 }],
];
const mapping: AssignableMapping = new Map(entries);
const owned = ownedSgids(mapping);

function input(overrides: Partial<MemberSyncInput>): MemberSyncInput {
  return {
    memberId: "m-1",
    displayName: "Test Member",
    tsUid: "uid-1",
    inGuild: true,
    discordRoleIds: [],
    alreadyDisabled: false,
    currentSgids: [],
    ...overrides,
  };
}

test("ownedSgids collects non-null sgids and nothing else", () => {
  assert.deepStrictEqual([...owned].sort((a, b) => a - b), [64, 68, 71, 76]);
});

test("ownedSgids dedupes a sgid mapped twice", () => {
  const doubled: AssignableMapping = new Map([
    ["a", { kind: "rank", name: "Officer", tsSgid: 71 }],
    ["b", { kind: "role", name: "Recruiter", tsSgid: 71 }],
  ] as [string, MappedAssignable][]);
  assert.deepStrictEqual([...ownedSgids(doubled)], [71]);
});

test("a converged member produces an empty diff", () => {
  const plan = planMemberSync(
    input({
      discordRoleIds: [OFFICER, RECRUITER],
      currentSgids: [71, 64],
    }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
  assert.deepStrictEqual(plan.warnings, []);
});

test("missing owned groups are added", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, MEDIC], currentSgids: [71] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, [76]);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("the leaver: every owned group removed, manual group untouched, disabled stamped", () => {
  // Not in the guild any more, so roles are []. They still hold three owned
  // groups on TeamSpeak plus a manual one the sync does not own.
  const plan = planMemberSync(
    input({
      inGuild: false,
      discordRoleIds: [],
      currentSgids: [71, 64, 76, MANUAL_SGID],
    }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, [64, 71, 76]);
  assert.ok(plan.stampDisabled);
  assert.strictEqual(plan.clearDisabled, false);
});

test("a leaver already stamped is not stamped again", () => {
  const plan = planMemberSync(
    input({ inGuild: false, alreadyDisabled: true, currentSgids: [68] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toRemove, [68]);
  assert.strictEqual(plan.stampDisabled, false);
  assert.strictEqual(plan.clearDisabled, false);
});

test("a rejoiner gets disabled_at cleared", () => {
  // Beyond the written spec (the docs only say when to stamp): a member seen
  // back in the guild while disabled_at is set gets it cleared, because the
  // column means "seen missing from the guild" and they no longer are.
  const plan = planMemberSync(
    input({
      inGuild: true,
      alreadyDisabled: true,
      discordRoleIds: [RECRUIT],
      currentSgids: [68],
    }),
    mapping,
    owned,
  );
  assert.ok(plan.clearDisabled);
  assert.strictEqual(plan.stampDisabled, false);
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("an unmapped Discord role contributes nothing", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [UNMAPPED_ROLE], currentSgids: [] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
  assert.deepStrictEqual(plan.warnings, []);
});

test("a mapped assignable with a null sgid contributes nothing", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [MISSION_MAKER], currentSgids: [] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("a manual TeamSpeak group outside the owned set is never touched", () => {
  // They hold Server Admin (or any group the mapping does not claim). It must
  // appear in neither set, whatever Discord says.
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER], currentSgids: [MANUAL_SGID] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, [71]);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("two rank roles: warned about, mirrored anyway", () => {
  // Discord is the source of truth, so the sync mirrors the broken state and
  // reports it; the fix belongs in Discord (§6 step 7).
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, RECRUIT], currentSgids: [71] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.warnings.length, 1);
  assert.ok(plan.warnings[0].includes("Officer"));
  assert.ok(plan.warnings[0].includes("Recruit"));
  assert.deepStrictEqual(plan.toAdd, [68]);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("blast-radius: removals from more members than the cap halts the pass", () => {
  // Six members each losing one owned group, cap of five: halted. The seventh
  // member has only an addition, and a halted pass applies nothing at all, so
  // the plan's halted flag governs the additions and the stamps too.
  const inputs = [
    ...Array.from({ length: 6 }, (_, i) =>
      input({
        memberId: `m-${i}`,
        tsUid: `uid-${i}`,
        discordRoleIds: [],
        currentSgids: [76],
      })),
    input({
      memberId: "m-adder",
      tsUid: "uid-adder",
      discordRoleIds: [MEDIC],
      currentSgids: [],
    }),
  ];
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 5 });
  assert.ok(pass.halted);
  assert.deepStrictEqual(pass.removalMemberCount, 6);
  assert.deepStrictEqual(pass.maxRemovals, 5);
});

test("blast-radius: exactly the cap does not halt", () => {
  // The spec says "exceeds": a pass touching exactly SYNC_MAX_REMOVALS members
  // still applies.
  const inputs = Array.from({ length: 5 }, (_, i) =>
    input({
      memberId: `m-${i}`,
      tsUid: `uid-${i}`,
      discordRoleIds: [],
      currentSgids: [76],
    }));
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 5 });
  assert.strictEqual(pass.halted, false);
  assert.deepStrictEqual(pass.removalMemberCount, 5);
});

test("blast-radius counts members, not groups", () => {
  // One member losing three groups is one member: a single demotion must not
  // read as a mass removal.
  const inputs = [
    input({ discordRoleIds: [], currentSgids: [71, 64, 76] }),
  ];
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 2 });
  assert.strictEqual(pass.halted, false);
  assert.deepStrictEqual(pass.removalMemberCount, 1);
});

test("additions alone never trip the guard", () => {
  const inputs = Array.from({ length: 50 }, (_, i) =>
    input({
      memberId: `m-${i}`,
      tsUid: `uid-${i}`,
      discordRoleIds: [MEDIC],
      currentSgids: [],
    }));
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 5 });
  assert.strictEqual(pass.halted, false);
  assert.deepStrictEqual(pass.changed.length, 50);
});

test("a pass separates the changed from the converged", () => {
  const inputs = [
    input({
      memberId: "m-same",
      tsUid: "uid-same",
      discordRoleIds: [OFFICER],
      currentSgids: [71],
    }),
    input({
      memberId: "m-diff",
      tsUid: "uid-diff",
      discordRoleIds: [OFFICER],
      currentSgids: [68],
    }),
  ];
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 5 });
  assert.deepStrictEqual(pass.members.length, 2);
  assert.deepStrictEqual(pass.changed.length, 1);
  assert.deepStrictEqual(pass.changed[0].memberId, "m-diff");
  assert.deepStrictEqual(pass.changed[0].toAdd, [71]);
  assert.deepStrictEqual(pass.changed[0].toRemove, [68]);
});

test("a converged >1-rank member carries a warning but is not in changed", () => {
  // The trap the worker's warning loop must dodge: a member holding two rank
  // roles whose TeamSpeak groups already mirror both is a no-op pass (empty
  // toAdd/toRemove, no stamp/clear), so planSyncPass leaves them out of
  // `changed`. The exclusivity warning still has to surface every pass
  // (IMPLEMENTATION §6 step 7), so the worker iterates `plan.members`, not
  // `plan.changed`. This locks that contract: the warning is on `members`, and
  // it would be lost if a caller only looked at `changed`.
  const pass = planSyncPass(
    [
      input({
        memberId: "m-conflict",
        tsUid: "uid-conflict",
        discordRoleIds: [OFFICER, RECRUIT],
        currentSgids: [71, 68],
      }),
    ],
    mapping,
    { maxRemovals: 5 },
  );
  assert.deepStrictEqual(pass.members.length, 1);
  assert.deepStrictEqual(pass.changed.length, 0);
  const [member] = pass.members;
  assert.deepStrictEqual(member.toAdd, []);
  assert.deepStrictEqual(member.toRemove, []);
  assert.deepStrictEqual(member.warnings.length, 1);
  assert.ok(member.warnings[0].includes("rank"));
});

// `currentSgids: null` = the pass could not read this member's TeamSpeak state
// (the server does not know the uid, or the lookup threw). Groups must not be
// touched, but the disabled_at decision is a Discord fact and must still be
// made: a leaver with a broken link is still stamped (§4.4).

test("a leaver with unreadable TeamSpeak state is still stamped disabled", () => {
  const plan = planMemberSync(
    input({ inGuild: false, discordRoleIds: [], currentSgids: null }),
    mapping,
    owned,
  );
  assert.ok(plan.stampDisabled);
  assert.strictEqual(plan.clearDisabled, false);
  // Cannot see their groups, so touches none: no phantom removals either.
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("an in-guild member with unreadable TeamSpeak state gets no phantom adds", () => {
  // The trap the nullable state avoids: passing [] for an unresolved member
  // would make every owned group they qualify for look missing and be queued
  // as an add that can never apply. null means "unknown", so toAdd stays empty.
  const plan = planMemberSync(
    input({
      inGuild: true,
      discordRoleIds: [OFFICER, MEDIC],
      currentSgids: null,
    }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
  assert.strictEqual(plan.stampDisabled, false);
  assert.strictEqual(plan.clearDisabled, false);
});

test("a rejoiner with unreadable TeamSpeak state still gets disabled_at cleared", () => {
  const plan = planMemberSync(
    input({
      inGuild: true,
      alreadyDisabled: true,
      discordRoleIds: [RECRUIT],
      currentSgids: null,
    }),
    mapping,
    owned,
  );
  assert.ok(plan.clearDisabled);
  assert.strictEqual(plan.stampDisabled, false);
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("the rank-conflict warning still fires when TeamSpeak state is unreadable", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, RECRUIT], currentSgids: null }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.warnings.length, 1);
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});

test("a null-state leaver is in changed (for the stamp) but adds nothing to the removal count", () => {
  // It has a disabled_at transition, so the pass must act on it, but it has no
  // removals: an unreadable member can never widen the blast-radius guard.
  const pass = planSyncPass(
    [input({ inGuild: false, discordRoleIds: [], currentSgids: null })],
    mapping,
    { maxRemovals: 5 },
  );
  assert.deepStrictEqual(pass.changed.length, 1);
  assert.deepStrictEqual(pass.removalMemberCount, 0);
  assert.strictEqual(pass.halted, false);
});

test("desiredSgids resolves mapped roles and ignores everything else", () => {
  // The extraction that lets the gather decide who needs a TeamSpeak lookup
  // without re-deriving the desired set. It is the same function the plan uses,
  // which is the point: a second implementation that came out too small would
  // remove groups from people.
  assert.deepStrictEqual(
    [...desiredSgids([OFFICER, MEDIC], mapping, owned)].sort((a, b) => a - b),
    [71, 76],
  );
  // Not ours, and mapped-but-not-mirrored: neither contributes.
  assert.deepStrictEqual([
    ...desiredSgids([UNMAPPED_ROLE, MISSION_MAKER], mapping, owned),
  ], []);
  assert.deepStrictEqual([...desiredSgids([], mapping, owned)], []);
});

test("desiredSgids is clamped to owned, so a group this pass will not touch is never desired", () => {
  // What the caller does with a group it could not read: null the sgid out of
  // the mapping for the pass. The group must then leave the desired set too, or
  // it would be added back on a pass that cannot see who holds it.
  const withoutOfficer: AssignableMapping = new Map(
    entries.map(([roleId, a]) =>
      a.tsSgid === 71 ? [roleId, { ...a, tsSgid: null }] : [roleId, a]
    ),
  );
  const narrowed = ownedSgids(withoutOfficer);
  assert.deepStrictEqual([...desiredSgids([OFFICER], withoutOfficer, narrowed)], []);
});

test("a member already holding exactly what Discord grants keeps it", () => {
  // The regression that would matter most: if the desired set ever came out
  // empty for a member who legitimately holds a group, the group would be
  // removed. This is the case that says it does not.
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, MEDIC], currentSgids: [71, 76] }),
    mapping,
    owned,
  );
  assert.deepStrictEqual(plan.toAdd, []);
  assert.deepStrictEqual(plan.toRemove, []);
});
