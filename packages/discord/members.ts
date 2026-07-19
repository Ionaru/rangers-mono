import { discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * A guild member from the *list* endpoint, where (unlike the single-member
 * fetch in guild.ts) `user` is documented to always be present: the missing
 * case only exists for interaction payloads. The reconcile keys the whole poll
 * on `user.id`, so the type says so.
 */
export interface ListedGuildMember {
  user: { id: string; username: string; global_name: string | null };
  nick: string | null;
  roles: string[];
}

/**
 * Every member of the guild, paginated. Phase 4's poll: the reconcile indexes
 * this once per pass as `discordId -> roles[]` (IMPLEMENTATION §6).
 *
 * **`limit=1000` is explicit and load-bearing.** `GET /guilds/{id}/members`
 * defaults to `limit=1`, which does not error: it silently returns one member,
 * and the sync would process exactly one person and present as "sync mostly
 * doesn't work" (IMPLEMENTATION §5). Pagination is by `after` = the highest
 * user id of the previous page.
 *
 * A 403 here is almost certainly the **GUILD_MEMBERS privileged intent**, not
 * a permission: the intent is an application toggle in the developer portal,
 * off by default, and no guild permission (Administrator included) substitutes
 * for it. `deno task phase0:check` verifies it against the live application.
 */
export async function listGuildMembers(
  options: DiscordRestOptions,
  guildId: string,
): Promise<ListedGuildMember[]> {
  const members: ListedGuildMember[] = [];
  let after = "0";

  while (true) {
    const page = await discordJson<ListedGuildMember[]>(
      options,
      `/guilds/${guildId}/members?limit=1000&after=${after}`,
    );
    members.push(...page);
    if (page.length < 1000) return members;
    // Snowflakes are 64-bit and exceed Number range: compare as BigInt.
    after = page
      .map((m) => m.user.id)
      .reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  }
}
