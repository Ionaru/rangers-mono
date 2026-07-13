import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  CODE_LENGTH,
  generateLinkCode,
  type LinkCodeChallenge,
  MAX_ATTEMPTS,
  normalizeLinkCode,
  verifyLinkCode,
} from "./link-code.ts";

const NOW = new Date("2026-07-11T20:00:00Z");
const LATER = new Date("2026-07-11T20:04:00Z");
const TOO_LATE = new Date("2026-07-11T20:06:00Z");

function challenge(over: Partial<LinkCodeChallenge> = {}): LinkCodeChallenge {
  return {
    code: "ABC234",
    targetTsUid: "eFGeAn6ewo8wGEj57HCzzz31X0w=",
    expiresAt: new Date("2026-07-11T20:05:00Z"),
    consumedAt: null,
    attempts: 0,
    ...over,
  };
}

Deno.test("a generated code is the right length and avoids look-alike characters", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateLinkCode();
    assertEquals(code.length, CODE_LENGTH);
    // No O/0, no I/1: someone is reading this out of a poke dialog and typing it.
    assertMatch(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
  }
});

Deno.test("generated codes are not all the same", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateLinkCode()));
  // A stuck generator (Math.random misused, a zeroed buffer) shows up here.
  assert(seen.size > 40, `only ${seen.size} distinct codes in 50 draws`);
});

Deno.test("the right code, typed as the member typed it, links", () => {
  assertEquals(verifyLinkCode(challenge(), "ABC234", NOW), { ok: true });
  // They will paste spaces, type lowercase, and hyphenate it.
  assertEquals(verifyLinkCode(challenge(), " abc234 ", NOW), { ok: true });
  assertEquals(verifyLinkCode(challenge(), "ABC-234", NOW), { ok: true });
});

Deno.test("a wrong code is refused and counts against the attempt cap", () => {
  assertEquals(verifyLinkCode(challenge(), "ZZZZZZ", NOW), {
    ok: false,
    reason: "wrong_code",
    attemptsLeft: MAX_ATTEMPTS - 1,
  });

  assertEquals(verifyLinkCode(challenge({ attempts: 3 }), "ZZZZZZ", NOW), {
    ok: false,
    reason: "wrong_code",
    attemptsLeft: 1,
  });
});

Deno.test("the last wrong guess kills the challenge rather than inviting another", () => {
  // On the final permitted attempt, a wrong code must not come back as
  // "wrong_code, 0 left": that reads as "try again" to a caller that only checks
  // the reason.
  assertEquals(
    verifyLinkCode(challenge({ attempts: MAX_ATTEMPTS - 1 }), "ZZZZZZ", NOW),
    { ok: false, reason: "too_many_attempts" },
  );
});

Deno.test("a challenge that is out of attempts refuses even the correct code", () => {
  assertEquals(
    verifyLinkCode(challenge({ attempts: MAX_ATTEMPTS }), "ABC234", NOW),
    { ok: false, reason: "too_many_attempts" },
  );
});

Deno.test("an expired challenge refuses even the correct code", () => {
  assertEquals(verifyLinkCode(challenge(), "ABC234", TOO_LATE), {
    ok: false,
    reason: "expired",
  });
  // Right up to the boundary it still works.
  assertEquals(verifyLinkCode(challenge(), "ABC234", LATER), { ok: true });
});

Deno.test("expiry is exclusive at the boundary", () => {
  const expiresAt = new Date("2026-07-11T20:05:00Z");
  assertEquals(verifyLinkCode(challenge({ expiresAt }), "ABC234", expiresAt), {
    ok: false,
    reason: "expired",
  });
});

Deno.test("a consumed challenge cannot be replayed", () => {
  assertEquals(
    verifyLinkCode(challenge({ consumedAt: NOW }), "ABC234", NOW),
    { ok: false, reason: "already_used" },
  );
});

Deno.test("a dead challenge is not a free oracle for guessing", () => {
  // Consumed and expired challenges must report *that*, not "wrong_code", or a
  // caller could use a dead challenge to test guesses without burning attempts.
  const used = verifyLinkCode(challenge({ consumedAt: NOW }), "ZZZZZZ", NOW);
  assertEquals(used, { ok: false, reason: "already_used" });

  const expired = verifyLinkCode(challenge(), "ZZZZZZ", TOO_LATE);
  assertEquals(expired, { ok: false, reason: "expired" });
});

Deno.test("normalising a code is idempotent", () => {
  assertEquals(normalizeLinkCode(" ab-c2 34 "), "ABC234");
  assertEquals(normalizeLinkCode(normalizeLinkCode(" ab-c2 34 ")), "ABC234");
});
