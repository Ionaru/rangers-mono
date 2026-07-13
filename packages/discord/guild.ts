import {
  DiscordApiError,
  discordFetch,
  type DiscordRestOptions,
} from "./rest.ts";

/**
 * A guild member, as Discord returns it. Only the fields we read.
 *
 * Hand-written rather than pulled from `discord-api-types`, which would be a
 * dependency for one endpoint.
 */
export interface GuildMember {
  /** The Discord role ids they hold. Phase 3's reconcile is built on this. */
  roles: string[];
  /** Their per-guild nickname, if they set one. */
  nick: string | null;
  user?: {
    id: string;
    username: string;
    /** The display name Discord shows today. Null for accounts that never set one. */
    global_name: string | null;
  };
}

/**
 * Fetch one guild member, or `null` if they are not in the guild.
 *
 * This is the guild gate. A 404 here is not an error, it is the answer: this
 * person has a Discord account but is not one of us, so they get told so and no
 * Member row is written for them.
 *
 * `GET /guilds/{guild}/members/{user}` is the right endpoint for it and it is
 * worth saying why: it needs no OAuth scope (the login only ever asks for
 * `identify` and `email`, and Better Auth surfaces no guild data whatever the
 * scopes say), it 404s cleanly rather than 403ing, it works with the user
 * offline or absent, and it never expires. Guild membership and roles come from
 * the bot token, never from the login (IMPLEMENTATION §4).
 *
 * It does need the **GUILD_MEMBERS privileged intent** enabled on `7R_Bot`'s
 * application. That is a toggle in the developer portal, not a permission, so no
 * amount of permission substitutes for it, Administrator included, and it is off
 * by default (ARCHITECTURE §7). Without it this is refused and nobody can log
 * in. That is a Phase 0 task, and this is the function that discovers whether it
 * was done.
 */
export async function getGuildMember(
  options: DiscordRestOptions,
  guildId: string,
  userId: string,
): Promise<GuildMember | null> {
  const response = await discordFetch(
    options,
    `/guilds/${guildId}/members/${userId}`,
  );

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new DiscordApiError(
      response.status,
      `/guilds/${guildId}/members/${userId}`,
      await response.text(),
    );
  }

  return await response.json() as GuildMember;
}

/**
 * The name to show for a member, in the order Discord itself prefers: their
 * nickname in this guild, then their global display name, then the username.
 */
export function displayNameOf(
  guildMember: GuildMember,
  fallback: string,
): string {
  return guildMember.nick ??
    guildMember.user?.global_name ??
    guildMember.user?.username ??
    fallback;
}
