import assert from "node:assert/strict";
import { test } from "node:test";
import { RANK_SORT_ORDER, ranksOf, resolveRank } from "./rank.ts";
import type { AssignableRef } from "./types.ts";

const officer: AssignableRef = { kind: "rank", name: "Officer" };
const member: AssignableRef = { kind: "rank", name: "Member" };
const reserve: AssignableRef = { kind: "rank", name: "Reserve" };
const recruiter: AssignableRef = { kind: "role", name: "Recruiter" };
const medic: AssignableRef = { kind: "badge", name: "Medic" };

test("Reserve sorts last among ranks", () => {
  const sorted = [...Object.entries(RANK_SORT_ORDER)]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  assert.deepStrictEqual(sorted, ["Officer", "NCO", "Member", "Recruit", "Reserve"]);
});

test("ranksOf ignores roles and badges", () => {
  assert.deepStrictEqual(ranksOf([recruiter, member, medic]), [member]);
});

test("exactly one rank resolves to it, with no conflict", () => {
  assert.deepStrictEqual(resolveRank([recruiter, member, medic]), {
    rank: member,
    conflicting: [],
  });
});

test("no rank resolves to null", () => {
  // A leaver has no Discord roles at all, so this is the shape the sync sees.
  assert.deepStrictEqual(resolveRank([]), { rank: null, conflicting: [] });
  assert.deepStrictEqual(resolveRank([recruiter, medic]), {
    rank: null,
    conflicting: [],
  });
});

test("more than one rank keeps the most senior and reports the rest", () => {
  // Rank is exclusive, but Discord is the source of truth: we report the state,
  // we do not silently fix it. The fix belongs in Discord.
  assert.deepStrictEqual(resolveRank([reserve, officer, member]), {
    rank: officer,
    conflicting: [member, reserve],
  });
});
