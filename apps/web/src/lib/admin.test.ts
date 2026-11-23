import assert from "node:assert/strict";
import { test } from "node:test";
import { isAdminRole } from "./admin.ts";

/**
 * The one piece of authorisation logic in the platform (ADR 0009: admin is a
 * single boolean derived from a configured set of role ids, no RBAC).
 *
 * Only the pure half is tested. `hasAdminRole` and `isAdminDiscordUser` are the
 * config read and the Discord round trip wrapped around this, and neither is
 * reachable without an environment or a socket.
 */

const ADMINS = ["role-officer", "role-nco"];

test("holding a configured admin role is admin", () => {
  assert.ok(isAdminRole(["role-nco"], ADMINS));
});

test("holding one of several roles is enough", () => {
  assert.ok(isAdminRole(["role-member", "role-medic", "role-officer"], ADMINS));
});

test("holding no configured role is not admin", () => {
  assert.strictEqual(isAdminRole(["role-member", "role-medic"], ADMINS), false);
});

test("holding no roles at all is not admin", () => {
  // An interaction from outside a guild carries no member, so the caller passes
  // []. That must never read as "allowed".
  assert.strictEqual(isAdminRole([], ADMINS), false);
});

test("an empty admin set admits nobody", () => {
  // Fails closed rather than open: a misconfigured DISCORD_ADMIN_ROLE_IDS locks
  // admins out of a read-only page, which is the safe direction to be wrong in.
  assert.strictEqual(isAdminRole(["role-officer"], []), false);
});

test("role ids are matched exactly, not by prefix", () => {
  assert.strictEqual(isAdminRole(["role-nco-trainee"], ADMINS), false);
  assert.strictEqual(isAdminRole(["role-nc"], ADMINS), false);
});
