import { assert, assertFalse } from "@std/assert";
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

Deno.test("holding a configured admin role is admin", () => {
  assert(isAdminRole(["role-nco"], ADMINS));
});

Deno.test("holding one of several roles is enough", () => {
  assert(isAdminRole(["role-member", "role-medic", "role-officer"], ADMINS));
});

Deno.test("holding no configured role is not admin", () => {
  assertFalse(isAdminRole(["role-member", "role-medic"], ADMINS));
});

Deno.test("holding no roles at all is not admin", () => {
  // An interaction from outside a guild carries no member, so the caller passes
  // []. That must never read as "allowed".
  assertFalse(isAdminRole([], ADMINS));
});

Deno.test("an empty admin set admits nobody", () => {
  // Fails closed rather than open: a misconfigured DISCORD_ADMIN_ROLE_IDS locks
  // admins out of a read-only page, which is the safe direction to be wrong in.
  assertFalse(isAdminRole(["role-officer"], []));
});

Deno.test("role ids are matched exactly, not by prefix", () => {
  assertFalse(isAdminRole(["role-nco-trainee"], ADMINS));
  assertFalse(isAdminRole(["role-nc"], ADMINS));
});
