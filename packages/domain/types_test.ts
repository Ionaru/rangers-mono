import { assert, assertEquals } from "@std/assert";
import { badgeDisplayName, badgeFromDisplayName, BADGES } from "./types.ts";

Deno.test("every badge has an emoji and a display name that round-trips", () => {
  for (const badge of BADGES) {
    const display = badgeDisplayName(badge);
    // The emoji is a prefix, the canonical name survives intact at the end.
    assert(display.endsWith(badge), `${display} should end with ${badge}`);
    assert(display.length > badge.length, `${display} should carry an emoji`);
    // And it maps back.
    assertEquals(badgeFromDisplayName(display), badge);
  }
});

Deno.test("the bare canonical name still resolves, for roles made before the emoji", () => {
  // The backfill must not create a duplicate of a plain "Medic" role.
  for (const badge of BADGES) {
    assertEquals(badgeFromDisplayName(badge), badge);
  }
});

Deno.test("a non-badge role name resolves to undefined", () => {
  assertEquals(badgeFromDisplayName("Officer"), undefined);
  assertEquals(badgeFromDisplayName("🎖️ Officer"), undefined);
  assertEquals(badgeFromDisplayName(""), undefined);
  // A near-miss must not match: emoji without the space, wrong emoji.
  assertEquals(badgeFromDisplayName("Medic!"), undefined);
});

Deno.test("every badge wears the same medal prefix", () => {
  const prefixes = new Set(
    BADGES.map((b) => badgeDisplayName(b).split(" ")[0]),
  );
  assertEquals(prefixes.size, 1);
  assertEquals([...prefixes][0], "🎖️");
});
