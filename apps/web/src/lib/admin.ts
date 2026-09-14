import { getDiscordConfig } from "@7r/config";
import { getGuildMember } from "@7r/discord";

/**
 * Admin is a single boolean derived from a configured set of Discord role ids
 * (`DISCORD_ADMIN_ROLE_IDS`). No permission table, no tiers, no RBAC: the
 * legacy's seven-permission model is deliberately not ported (ADR 0009).
 *
 * This is the first admin gate in the codebase, and it exists in two halves
 * because the two surfaces know different things:
 *
 *  - a **Discord interaction** already carries the invoking member's role ids in
 *    its payload, so the check is free and offline;
 *  - a **web request** carries a session and nothing else, so the roles have to
 *    be fetched with the bot token. Roles come from the bot token and never from
 *    OAuth (IMPLEMENTATION §4): Better Auth only ever calls `/users/@me`, and no
 *    scope would change that.
 *
 * Both halves end in `hasAdminRole`, so there is exactly one definition of what
 * an admin is.
 */

/**
 * The rule itself: does this role set intersect the admin set?
 *
 * Takes the admin ids as data rather than reading them from the environment,
 * for the same reason `isCredited` takes its threshold (`@7r/domain`): it is the
 * one piece of authorisation logic in the system, and a rule that has to be
 * tested is a rule that must not need a configured environment to run.
 */
export function isAdminRole(
  roleIds: readonly string[],
  adminRoleIds: readonly string[],
): boolean {
  return roleIds.some((id) => adminRoleIds.includes(id));
}

/** `isAdminRole` against the configured admin set. */
export function hasAdminRole(roleIds: readonly string[]): boolean {
  return isAdminRole(roleIds, getDiscordConfig().DISCORD_ADMIN_ROLE_IDS);
}

/**
 * Is this Discord account an admin, asked of Discord itself?
 *
 * One REST call, on pages that are loaded rarely and by few people. It is not
 * cached: an admin role removed in Discord should stop working on the next page
 * load, and caching would be optimising the page nobody visits often.
 *
 * **Fails closed.** A Discord blip, a revoked token, a member who has left the
 * guild: all of them answer "not an admin" rather than throwing a 500 into a
 * rendering page or, worse, defaulting open. The caller redirects, and the
 * person tries again.
 */
export async function isAdminDiscordUser(discordId: string): Promise<boolean> {
  const { DISCORD_GUILD_ID, DISCORD_BOT_TOKEN } = getDiscordConfig();
  try {
    const guildMember = await getGuildMember(
      {
        botToken: DISCORD_BOT_TOKEN,
        // One try, and a short one, as the middleware's guild gate uses: a
        // person is watching a blank page, so a slow retry loop is worse than a
        // quick "no".
        retry: { transientAttempts: 1, timeoutMs: 5_000 },
      },
      DISCORD_GUILD_ID,
      discordId,
    );
    return guildMember === null ? false : hasAdminRole(guildMember.roles);
  } catch {
    return false;
  }
}
