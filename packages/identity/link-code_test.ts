import assert from "node:assert/strict";
import { test } from "node:test";
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

test("a generated code is the right length and avoids look-alike characters", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateLinkCode();
    assert.deepStrictEqual(code.length, CODE_LENGTH);
    // No O/0, no I/1: someone is reading this out of a poke dialog and typing it.
    assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/);
  }
});

test("generated codes are not all the same", () => {
  const seen = new Set(Array.from({ length: 50 }, () => generateLinkCode()));
  // A stuck generator (Math.random misused, a zeroed buffer) shows up here.
  assert.ok(seen.size > 40, `only ${seen.size} distinct codes in 50 draws`);
});

test("the right code, typed as the member typed it, links", () => {
  assert.deepStrictEqual(verifyLinkCode(challenge(), "ABC234", NOW), { ok: true });
  // They will paste spaces, type lowercase, and hyphenate it.
  assert.deepStrictEqual(verifyLinkCode(challenge(), " abc234 ", NOW), { ok: true });
  assert.deepStrictEqual(verifyLinkCode(challenge(), "ABC-234", NOW), { ok: true });
});

test("a wrong code is refused and counts against the attempt cap", () => {
  assert.deepStrictEqual(verifyLinkCode(challenge(), "ZZZZZZ", NOW), {
    ok: false,
    reason: "wrong_code",
    attemptsLeft: MAX_ATTEMPTS - 1,
  });

  assert.deepStrictEqual(verifyLinkCode(challenge({ attempts: 3 }), "ZZZZZZ", NOW), {
    ok: false,
    reason: "wrong_code",
    attemptsLeft: 1,
  });
});

test("the last wrong guess kills the challenge rather than inviting another", () => {
  // On the final permitted attempt, a wrong code must not come back as
  // "wrong_code, 0 left": that reads as "try again" to a caller that only checks
  // the reason.
  assert.deepStrictEqual(
    verifyLinkCode(challenge({ attempts: MAX_ATTEMPTS - 1 }), "ZZZZZZ", NOW),
    { ok: false, reason: "too_many_attempts" },
  );
});

test("a challenge that is out of attempts refuses even the correct code", () => {
  assert.deepStrictEqual(
    verifyLinkCode(challenge({ attempts: MAX_ATTEMPTS }), "ABC234", NOW),
    { ok: false, reason: "too_many_attempts" },
  );
});

test("an expired challenge refuses even the correct code", () => {
  assert.deepStrictEqual(verifyLinkCode(challenge(), "ABC234", TOO_LATE), {
    ok: false,
    reason: "expired",
  });
  // Right up to the boundary it still works.
  assert.deepStrictEqual(verifyLinkCode(challenge(), "ABC234", LATER), { ok: true });
});

test("expiry is exclusive at the boundary", () => {
  const expiresAt = new Date("2026-07-11T20:05:00Z");
  assert.deepStrictEqual(verifyLinkCode(challenge({ expiresAt }), "ABC234", expiresAt), {
    ok: false,
    reason: "expired",
  });
});

test("a consumed challenge cannot be replayed", () => {
  assert.deepStrictEqual(
    verifyLinkCode(challenge({ consumedAt: NOW }), "ABC234", NOW),
    { ok: false, reason: "already_used" },
  );
});

test("a dead challenge is not a free oracle for guessing", () => {
  // Consumed and expired challenges must report *that*, not "wrong_code", or a
  // caller could use a dead challenge to test guesses without burning attempts.
  const used = verifyLinkCode(challenge({ consumedAt: NOW }), "ZZZZZZ", NOW);
  assert.deepStrictEqual(used, { ok: false, reason: "already_used" });

  const expired = verifyLinkCode(challenge(), "ZZZZZZ", TOO_LATE);
  assert.deepStrictEqual(expired, { ok: false, reason: "expired" });
});

test("normalising a code is idempotent", () => {
  assert.deepStrictEqual(normalizeLinkCode(" ab-c2 34 "), "ABC234");
  assert.deepStrictEqual(normalizeLinkCode(normalizeLinkCode(" ab-c2 34 ")), "ABC234");
});
