import assert from "node:assert/strict";
import { test } from "node:test";
import { badgeDisplayName, badgeFromDisplayName, BADGES } from "./types.ts";

test("every badge has an emoji and a display name that round-trips", () => {
  for (const badge of BADGES) {
    const display = badgeDisplayName(badge);
    // The emoji is a prefix, the canonical name survives intact at the end.
    assert.ok(display.endsWith(badge), `${display} should end with ${badge}`);
    assert.ok(
      display.length > badge.length,
      `${display} should carry an emoji`,
    );
    // And it maps back.
    assert.deepStrictEqual(badgeFromDisplayName(display), badge);
  }
});

test("the bare canonical name still resolves, for roles made before the emoji", () => {
  // The backfill must not create a duplicate of a plain "Medic" role.
  for (const badge of BADGES) {
    assert.deepStrictEqual(badgeFromDisplayName(badge), badge);
  }
});

test("a non-badge role name resolves to undefined", () => {
  assert.deepStrictEqual(badgeFromDisplayName("Officer"), undefined);
  assert.deepStrictEqual(badgeFromDisplayName("🎖️ Officer"), undefined);
  assert.deepStrictEqual(badgeFromDisplayName(""), undefined);
  // A near-miss must not match: emoji without the space, wrong emoji.
  assert.deepStrictEqual(badgeFromDisplayName("Medic!"), undefined);
});

test("every badge wears the same medal prefix", () => {
  const prefixes = new Set(
    BADGES.map((b) => badgeDisplayName(b).split(" ")[0]),
  );
  assert.deepStrictEqual(prefixes.size, 1);
  assert.deepStrictEqual([...prefixes][0], "🎖️");
});
