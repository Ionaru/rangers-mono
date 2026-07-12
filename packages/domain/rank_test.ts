import { assertEquals } from "@std/assert";
import { RANK_SORT_ORDER, ranksOf, resolveRank } from "./rank.ts";
import type { AssignableRef } from "./types.ts";

const officer: AssignableRef = { kind: "rank", name: "Officer" };
const member: AssignableRef = { kind: "rank", name: "Member" };
const reserve: AssignableRef = { kind: "rank", name: "Reserve" };
const recruiter: AssignableRef = { kind: "role", name: "Recruiter" };
const medic: AssignableRef = { kind: "badge", name: "Medic" };

Deno.test("Reserve sorts last among ranks", () => {
  const sorted = [...Object.entries(RANK_SORT_ORDER)]
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => name);
  assertEquals(sorted, ["Officer", "NCO", "Member", "Recruit", "Reserve"]);
});

Deno.test("ranksOf ignores roles and badges", () => {
  assertEquals(ranksOf([recruiter, member, medic]), [member]);
});

Deno.test("exactly one rank resolves to it, with no conflict", () => {
  assertEquals(resolveRank([recruiter, member, medic]), {
    rank: member,
    conflicting: [],
  });
});

Deno.test("no rank resolves to null", () => {
  // A leaver has no Discord roles at all, so this is the shape the sync sees.
  assertEquals(resolveRank([]), { rank: null, conflicting: [] });
  assertEquals(resolveRank([recruiter, medic]), {
    rank: null,
    conflicting: [],
  });
});

Deno.test("more than one rank keeps the most senior and reports the rest", () => {
  // Rank is exclusive, but Discord is the source of truth: we report the state,
  // we do not silently fix it. The fix belongs in Discord.
  assertEquals(resolveRank([reserve, officer, member]), {
    rank: officer,
    conflicting: [member, reserve],
  });
});
