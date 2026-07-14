import { discordFetch, discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * Writing Discord roles.
 *
 * Two rules govern every call in here, and both fail as a 403 that looks like
 * nothing else:
 *
 * 1. **`MANAGE_ROLES`**, which `7R_Bot` has.
 * 2. **Role hierarchy**, which Administrator does not exempt you from: a bot may
 *    only grant, edit or sort roles *below* its own highest role. `7R_Bot` sits
 *    at position 28, under Officer (30) and NCO (29), so it cannot write those
 *    two. That is deliberate, not a defect: the top of the rank ladder is
 *    hand-assigned by people who hold it (ARCHITECTURE §7). Everything this
 *    project actually writes (the badges, the staff roles, the lower ranks) sits
 *    below the bot, and newly created roles land at the bottom of the list, so
 *    they are below it by construction.
 */

export interface Role {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

/** Every role in the guild. The only way to find a role by name: Discord has no lookup. */
export async function listGuildRoles(
  options: DiscordRestOptions,
  guildId: string,
): Promise<Role[]> {
  return await discordJson<Role[]>(options, `/guilds/${guildId}/roles`);
}

/**
 * Create a role.
 *
 * Deliberately no permissions (`"0"`), not hoisted, not mentionable: a badge is a
 * label, and a label that grants power or pings a dozen people is a different
 * thing. It is created at the bottom of the role list, which is exactly where we
 * want it, because that puts it below `7R_Bot` and therefore assignable.
 */
export async function createGuildRole(
  options: DiscordRestOptions,
  guildId: string,
  role: { name: string; reason: string },
): Promise<Role> {
  return await discordJson<Role>(options, `/guilds/${guildId}/roles`, {
    method: "POST",
    headers: { "X-Audit-Log-Reason": role.reason },
    body: JSON.stringify({
      name: role.name,
      permissions: "0",
      hoist: false,
      mentionable: false,
    }),
  });
}

/**
 * Give a member a role.
 *
 * `PUT`, which is idempotent: adding a role somebody already has is a 204 and not
 * an error, so this is safe to re-run. And it is the single-role endpoint, so it
 * cannot clobber the rest of their roles the way a `PATCH` of the whole array
 * would if two of these raced.
 */
export async function addMemberRole(
  options: DiscordRestOptions,
  guildId: string,
  userId: string,
  roleId: string,
  reason: string,
): Promise<void> {
  const response = await discordFetch(
    options,
    `/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    { method: "PUT", headers: { "X-Audit-Log-Reason": reason } },
  );

  if (!response.ok) {
    throw new Error(
      `could not give ${userId} role ${roleId}: ${response.status} ${await response
        .text()}`,
    );
  }
}
