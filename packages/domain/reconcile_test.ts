import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type AssignableMapping,
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

Deno.test("ownedSgids collects non-null sgids and nothing else", () => {
  assertEquals([...owned].sort((a, b) => a - b), [64, 68, 71, 76]);
});

Deno.test("ownedSgids dedupes a sgid mapped twice", () => {
  const doubled: AssignableMapping = new Map([
    ["a", { kind: "rank", name: "Officer", tsSgid: 71 }],
    ["b", { kind: "role", name: "Recruiter", tsSgid: 71 }],
  ] as [string, MappedAssignable][]);
  assertEquals([...ownedSgids(doubled)], [71]);
});

Deno.test("a converged member produces an empty diff", () => {
  const plan = planMemberSync(
    input({
      discordRoleIds: [OFFICER, RECRUITER],
      currentSgids: [71, 64],
    }),
    mapping,
    owned,
  );
  assertEquals(plan.toAdd, []);
  assertEquals(plan.toRemove, []);
  assertEquals(plan.warnings, []);
});

Deno.test("missing owned groups are added", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, MEDIC], currentSgids: [71] }),
    mapping,
    owned,
  );
  assertEquals(plan.toAdd, [76]);
  assertEquals(plan.toRemove, []);
});

Deno.test("the leaver: every owned group removed, manual group untouched, disabled stamped", () => {
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
  assertEquals(plan.toAdd, []);
  assertEquals(plan.toRemove, [64, 71, 76]);
  assert(plan.stampDisabled);
  assertFalse(plan.clearDisabled);
});

Deno.test("a leaver already stamped is not stamped again", () => {
  const plan = planMemberSync(
    input({ inGuild: false, alreadyDisabled: true, currentSgids: [68] }),
    mapping,
    owned,
  );
  assertEquals(plan.toRemove, [68]);
  assertFalse(plan.stampDisabled);
  assertFalse(plan.clearDisabled);
});

Deno.test("a rejoiner gets disabled_at cleared", () => {
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
  assert(plan.clearDisabled);
  assertFalse(plan.stampDisabled);
  assertEquals(plan.toAdd, []);
  assertEquals(plan.toRemove, []);
});

Deno.test("an unmapped Discord role contributes nothing", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [UNMAPPED_ROLE], currentSgids: [] }),
    mapping,
    owned,
  );
  assertEquals(plan.toAdd, []);
  assertEquals(plan.toRemove, []);
  assertEquals(plan.warnings, []);
});

Deno.test("a mapped assignable with a null sgid contributes nothing", () => {
  const plan = planMemberSync(
    input({ discordRoleIds: [MISSION_MAKER], currentSgids: [] }),
    mapping,
    owned,
  );
  assertEquals(plan.toAdd, []);
  assertEquals(plan.toRemove, []);
});

Deno.test("a manual TeamSpeak group outside the owned set is never touched", () => {
  // They hold Server Admin (or any group the mapping does not claim). It must
  // appear in neither set, whatever Discord says.
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER], currentSgids: [MANUAL_SGID] }),
    mapping,
    owned,
  );
  assertEquals(plan.toAdd, [71]);
  assertEquals(plan.toRemove, []);
});

Deno.test("two rank roles: warned about, mirrored anyway", () => {
  // Discord is the source of truth, so the sync mirrors the broken state and
  // reports it; the fix belongs in Discord (§6 step 6).
  const plan = planMemberSync(
    input({ discordRoleIds: [OFFICER, RECRUIT], currentSgids: [71] }),
    mapping,
    owned,
  );
  assertEquals(plan.warnings.length, 1);
  assert(plan.warnings[0].includes("Officer"));
  assert(plan.warnings[0].includes("Recruit"));
  assertEquals(plan.toAdd, [68]);
  assertEquals(plan.toRemove, []);
});

Deno.test("blast-radius: removals from more members than the cap halts the pass", () => {
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
  assert(pass.halted);
  assertEquals(pass.removalMemberCount, 6);
  assertEquals(pass.maxRemovals, 5);
});

Deno.test("blast-radius: exactly the cap does not halt", () => {
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
  assertFalse(pass.halted);
  assertEquals(pass.removalMemberCount, 5);
});

Deno.test("blast-radius counts members, not groups", () => {
  // One member losing three groups is one member: a single demotion must not
  // read as a mass removal.
  const inputs = [
    input({ discordRoleIds: [], currentSgids: [71, 64, 76] }),
  ];
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 2 });
  assertFalse(pass.halted);
  assertEquals(pass.removalMemberCount, 1);
});

Deno.test("additions alone never trip the guard", () => {
  const inputs = Array.from({ length: 50 }, (_, i) =>
    input({
      memberId: `m-${i}`,
      tsUid: `uid-${i}`,
      discordRoleIds: [MEDIC],
      currentSgids: [],
    }));
  const pass = planSyncPass(inputs, mapping, { maxRemovals: 5 });
  assertFalse(pass.halted);
  assertEquals(pass.changed.length, 50);
});

Deno.test("a pass separates the changed from the converged", () => {
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
  assertEquals(pass.members.length, 2);
  assertEquals(pass.changed.length, 1);
  assertEquals(pass.changed[0].memberId, "m-diff");
  assertEquals(pass.changed[0].toAdd, [71]);
  assertEquals(pass.changed[0].toRemove, [68]);
});
