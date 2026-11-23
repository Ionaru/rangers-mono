import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AssignableMapping,
  type MappedAssignable,
  planSyncPass,
} from "./reconcile.ts";
import {
  type GatherMemberInput,
  gatherSyncInputs,
  type GroupHolder,
} from "./sync-gather.ts";

/**
 * The join between "who holds each owned group" and "what should this member
 * hold". Everything that can be wrong about batching the gather is in here: a
 * member wrongly read as holding nothing plans adds that cannot apply, and an
 * identity matched to the wrong client writes groups to the wrong person.
 */

const OFFICER = "role-officer";
const RECRUIT = "role-recruit";
const MEDIC = "role-medic";
const MISSION_MAKER = "role-mission-maker";
const UNMAPPED_ROLE = "role-unmapped";

const OFFICER_SGID = 71;
const RECRUIT_SGID = 68;
const MEDIC_SGID = 76;
/** Outside the mapping: Server Admin, a manual grant, a channel group. */
const MANUAL_SGID = 6;

const entries: [string, MappedAssignable][] = [
  [OFFICER, { kind: "rank", name: "Officer", tsSgid: OFFICER_SGID }],
  [RECRUIT, { kind: "rank", name: "Recruit", tsSgid: RECRUIT_SGID }],
  [MEDIC, { kind: "badge", name: "Medic", tsSgid: MEDIC_SGID }],
  [MISSION_MAKER, { kind: "role", name: "Mission maker", tsSgid: null }],
];
const mapping: AssignableMapping = new Map(entries);

function member(overrides: Partial<GatherMemberInput> = {}): GatherMemberInput {
  return {
    memberId: "m-1",
    displayName: "Test Member",
    tsUid: "uid-1",
    inGuild: true,
    discordRoleIds: [],
    alreadyDisabled: false,
    ...overrides,
  };
}

function holders(
  map: Record<number, GroupHolder[]>,
): Map<number, GroupHolder[]> {
  return new Map(
    Object.entries(map).map(([sgid, list]) => [Number(sgid), list]),
  );
}

test("a holder of owned groups gets both their cldbid and their current set", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER] })],
    holders({
      [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [MEDIC_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [RECRUIT_SGID]: [],
    }),
    mapping,
  );

  assert.deepStrictEqual(
    result.inputs[0].currentSgids,
    [OFFICER_SGID, MEDIC_SGID].sort((a, b) => a - b),
  );
  assert.deepStrictEqual(result.cldbidByMemberId.get("m-1"), "42");
  assert.deepStrictEqual(result.needsProbe, []);
  assert.deepStrictEqual(result.notLookedUp, []);
});

test("a member absent from every owned group holds none of them, positively", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER] })],
    holders({
      [OFFICER_SGID]: [{ cldbid: "99", uid: "somebody-else" }],
      [RECRUIT_SGID]: [],
      [MEDIC_SGID]: [],
    }),
    mapping,
  );

  // `[]`, not `null`: the lists are complete for the groups this pass will
  // touch, so "not in any of them" is an answer, not a gap.
  assert.deepStrictEqual(result.inputs[0].currentSgids, []);
  // No cldbid yet, and Discord says they should have Officer, so they must be
  // looked up before that add can be applied.
  assert.deepStrictEqual(result.needsProbe, [
    { memberId: "m-1", displayName: "Test Member", tsUid: "uid-1" },
  ]);
});

test("a member who holds nothing and should hold nothing costs no lookup", () => {
  const result = gatherSyncInputs(
    // Mission maker is mapped but has no TeamSpeak group; the other role is not
    // ours at all. Neither puts anything in the desired set.
    [member({ discordRoleIds: [MISSION_MAKER, UNMAPPED_ROLE] })],
    holders({ [OFFICER_SGID]: [], [RECRUIT_SGID]: [], [MEDIC_SGID]: [] }),
    mapping,
  );

  assert.deepStrictEqual(result.needsProbe, []);
  assert.deepStrictEqual(result.notLookedUp, [{
    displayName: "Test Member",
    tsUid: "uid-1",
  }]);
  assert.deepStrictEqual(result.inputs[0].currentSgids, []);
});

test("a leaver still loses their groups: removals need no lookup", () => {
  const result = gatherSyncInputs(
    // Not in the guild, so no roles: the leaver case the whole design hangs on.
    [member({ inGuild: false, discordRoleIds: [] })],
    holders({ [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }] }),
    mapping,
  );

  assert.deepStrictEqual(result.needsProbe, []);
  // The cldbid came free with the group list, which is why a removal never
  // needs the per-identity lookup that adds sometimes do.
  assert.deepStrictEqual(result.cldbidByMemberId.get("m-1"), "42");

  const plan = planSyncPass(result.inputs, mapping, { maxRemovals: 5 });
  assert.deepStrictEqual(plan.members[0].toRemove, [OFFICER_SGID]);
  assert.deepStrictEqual(plan.members[0].stampDisabled, true);
});

test("groups outside the owned set are ignored, even if handed to us", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER] })],
    holders({
      [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [MANUAL_SGID]: [{ cldbid: "42", uid: "uid-1" }],
    }),
    mapping,
  );

  // A manual grant must never reach `current`, or it would appear in toRemove.
  assert.deepStrictEqual(result.inputs[0].currentSgids, [OFFICER_SGID]);
});

test("a group the pass could not read is simply absent, and is not read as empty", () => {
  // The caller nulls an unreadable group's sgid out of the mapping and leaves it
  // out of the holder map. Both halves matter: with Officer out of `owned`, it
  // is neither desired nor current, so the pass plans nothing for it either way.
  const withoutOfficer: AssignableMapping = new Map(
    entries.map(([roleId, a]) =>
      a.tsSgid === OFFICER_SGID ? [roleId, { ...a, tsSgid: null }] : [roleId, a]
    ),
  );

  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER, MEDIC] })],
    holders({
      [MEDIC_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [RECRUIT_SGID]: [],
    }),
    withoutOfficer,
  );

  assert.deepStrictEqual(result.inputs[0].currentSgids, [MEDIC_SGID]);

  const plan = planSyncPass(result.inputs, withoutOfficer, { maxRemovals: 5 });
  assert.deepStrictEqual(plan.members[0].toAdd, []);
  assert.deepStrictEqual(plan.members[0].toRemove, []);
});

test("uids are matched byte for byte, and a real match still joins alongside a near miss", () => {
  const result = gatherSyncInputs(
    [
      member({ memberId: "m-1", tsUid: "AbC=", discordRoleIds: [OFFICER] }),
      member({ memberId: "m-2", tsUid: "xyz=", discordRoleIds: [OFFICER] }),
    ],
    holders({
      [OFFICER_SGID]: [
        // TeamSpeak uids are base64 and case-sensitive, so this is a different
        // identity, not the same one written differently.
        { cldbid: "42", uid: "abc=" },
        { cldbid: "43", uid: "xyz=" },
      ],
    }),
    mapping,
  );

  assert.deepStrictEqual(result.inputs[0].currentSgids, []);
  assert.deepStrictEqual(result.needsProbe.map((p) => p.memberId), ["m-1"]);
  assert.deepStrictEqual(result.inputs[1].currentSgids, [OFFICER_SGID]);
  assert.deepStrictEqual(result.cldbidByMemberId.get("m-2"), "43");
});

test("one identity reported under two client ids is dropped, not guessed at", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER] })],
    holders({
      [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [MEDIC_SGID]: [{ cldbid: "43", uid: "uid-1" }],
    }),
    mapping,
  );

  assert.deepStrictEqual(result.inputs[0].currentSgids, null);
  assert.deepStrictEqual(result.unresolved.length, 1);
  assert.deepStrictEqual(result.cldbidByMemberId.has("m-1"), false);
});

test("one client id reported under two identities within a group condemns the group", () => {
  // The shape a response-parsing slip takes: an entry missing its own cldbid
  // inherits the previous one's, which would otherwise write groups to the
  // wrong person. Inside a single group a repeated client id is impossible, so
  // the whole list is suspect and the caller drops that group from the pass.
  const result = gatherSyncInputs(
    [
      member({ memberId: "m-1", tsUid: "uid-1", discordRoleIds: [OFFICER] }),
      member({ memberId: "m-2", tsUid: "uid-2", discordRoleIds: [OFFICER] }),
    ],
    holders({
      [OFFICER_SGID]: [
        { cldbid: "42", uid: "uid-1" },
        { cldbid: "42", uid: "uid-2" },
      ],
    }),
    mapping,
  );

  assert.deepStrictEqual([...result.malformedBySgid], [[OFFICER_SGID, 1]]);
});

test("one client id reported under two identities across groups drops both members", () => {
  // Across groups a repeat is legitimate (one client holds several), so the
  // cross-check is on the pairing rather than the repeat. Two identities
  // claiming one client id means we cannot tell which member a write would
  // reach, so neither is touched.
  const result = gatherSyncInputs(
    [
      member({ memberId: "m-1", tsUid: "uid-1", discordRoleIds: [OFFICER] }),
      member({ memberId: "m-2", tsUid: "uid-2", discordRoleIds: [MEDIC] }),
    ],
    holders({
      [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [MEDIC_SGID]: [{ cldbid: "42", uid: "uid-2" }],
    }),
    mapping,
  );

  assert.deepStrictEqual(result.malformedBySgid.size, 0);
  assert.deepStrictEqual(result.inputs[0].currentSgids, null);
  assert.deepStrictEqual(result.inputs[1].currentSgids, null);
  assert.deepStrictEqual(result.unresolved.length, 2);
});

test("entries with no uid or no cldbid are counted against their group", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER] })],
    holders({
      [OFFICER_SGID]: [
        { cldbid: "42", uid: "" },
        { cldbid: "", uid: "uid-1" },
      ],
      [MEDIC_SGID]: [{ cldbid: "42", uid: "uid-1" }],
    }),
    mapping,
  );

  // Per group, so the caller can drop exactly the group it cannot trust rather
  // than the whole pass. Medic joined fine and is not implicated.
  assert.deepStrictEqual([...result.malformedBySgid], [[OFFICER_SGID, 2]]);
  assert.deepStrictEqual(result.inputs[0].currentSgids, [MEDIC_SGID]);
});

test("the same client listed twice in one group is malformed, not a free no-op", () => {
  // The one shape the uid/cldbid cross-checks cannot see: a response entry that
  // inherited BOTH fields from the first entry is byte-identical to a real
  // holder, so it would be absorbed silently and whoever that entry was really
  // about would read as holding nothing, losing their removal.
  const result = gatherSyncInputs(
    [
      member({ memberId: "m-1", tsUid: "uid-1", discordRoleIds: [OFFICER] }),
      member({ memberId: "m-2", tsUid: "uid-2", discordRoleIds: [] }),
    ],
    holders({
      [OFFICER_SGID]: [
        { cldbid: "42", uid: "uid-1" },
        { cldbid: "42", uid: "uid-1" },
      ],
    }),
    mapping,
  );

  assert.deepStrictEqual([...result.malformedBySgid], [[OFFICER_SGID, 1]]);
});

test("an empty ts_uid is unreadable, not empty-handed", () => {
  const result = gatherSyncInputs(
    [member({ tsUid: "", discordRoleIds: [OFFICER] })],
    holders({ [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }] }),
    mapping,
  );

  assert.deepStrictEqual(result.inputs[0].currentSgids, null);
  assert.deepStrictEqual(result.needsProbe, []);
  assert.deepStrictEqual(result.unresolved[0].reason, "member has an empty ts_uid");
});

test("the gather composes with the plan: a converged member is a no-op", () => {
  const result = gatherSyncInputs(
    [member({ discordRoleIds: [OFFICER, MEDIC] })],
    holders({
      [OFFICER_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [MEDIC_SGID]: [{ cldbid: "42", uid: "uid-1" }],
      [RECRUIT_SGID]: [],
    }),
    mapping,
  );

  const plan = planSyncPass(result.inputs, mapping, { maxRemovals: 5 });
  assert.deepStrictEqual(plan.changed, []);
  assert.deepStrictEqual(plan.removalMemberCount, 0);
});
