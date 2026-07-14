import { getDiscordConfig, getTeamspeakConfig, loadAll } from "@7r/config";
import type { DiscordConfig, TeamspeakConfig } from "@7r/config";
import {
  closeDb,
  getDb,
  type LinkedMemberLite,
  listLinkedMembers,
  membersByTsUid,
} from "@7r/db";
import { BADGES } from "@7r/domain";
import {
  addMemberRole,
  createGuildRole,
  type DiscordRestOptions,
  listGuildRoles,
} from "@7r/discord";
import {
  connectTeamspeak,
  listServerGroupMembers,
  listServerGroups,
} from "@7r/teamspeak";

/**
 * Phase 0's badge backfill, sourced from TeamSpeak.
 *
 *   deno task badges:backfill            # prints the plan, writes nothing
 *   deno task badges:backfill -- --apply # does it
 *
 * **Why TeamSpeak and not the legacy database.** MIGRATION.md says to backfill
 * the 83 grants in `user_badges_badge`. That was wrong, and it is the kind of
 * wrong that would have been invisible: the legacy table is years out of date,
 * and the *current* record of who has earned which badge is the live TeamSpeak
 * server groups. Badges are the one Assignable that never existed as a Discord
 * role, so TeamSpeak is the only place the truth has been kept.
 *
 * So this runs the arrow backwards, exactly once: TeamSpeak -> Discord. After it,
 * Discord is authoritative for badges like every other Assignable (ADR 0002) and
 * the sync only ever writes TeamSpeak. This script is not part of the steady
 * state and should never need running twice.
 *
 * It is idempotent anyway (`PUT` on a role somebody already has is a 204), so a
 * re-run is safe.
 *
 * **The unmapped are the point, and the hazard is subtler than "they get
 * stripped".** A TeamSpeak identity holding a badge that resolves to no member
 * cannot be given a Discord role. It is NOT stripped by the sync: the reconcile
 * iterates members that have a linked `ts_uid` and operates on each one's own
 * identity, and an unmapped identity is nobody's `ts_uid`, so it is never
 * iterated and never touched. It simply sits there, its qualification absent from
 * the source of truth.
 *
 * The trap springs later, and only for the ones who are real members: if such a
 * person LINKS this exact TeamSpeak identity while it lacks the Discord badge,
 * they become a member-with-that-`ts_uid`, the reconcile sees a badge on
 * TeamSpeak that Discord does not have, and removes it. They lose the badge by
 * the act of linking. So the fix is to get the Discord role onto the real people
 * here BEFORE Phase 3 leaves dry-run: have them link and re-run this (idempotent),
 * or an admin grants the role by hand. The ones who have left the unit never link,
 * so their badge lingers harmlessly on a dead identity.
 */

const REASON = "7R Platform: Phase 0 badge backfill, sourced from TeamSpeak";

interface Grant {
  badge: string;
  uid: string;
  nickname: string;
}

async function main() {
  const apply = Deno.args.includes("--apply");

  const [discord, ts] = loadAll<[DiscordConfig, TeamspeakConfig]>([
    getDiscordConfig,
    getTeamspeakConfig,
  ]);

  const auth: DiscordRestOptions = { botToken: discord.DISCORD_BOT_TOKEN };
  const guildId = discord.DISCORD_GUILD_ID;
  const db = getDb();

  // ------------------------------------------------ what TeamSpeak says today

  const teamspeak = await connectTeamspeak({
    host: ts.TS_QUERY_HOST,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
    virtualServerId: ts.TS_VIRTUALSERVER_ID,
    nickname: ts.TS_BOT_NICKNAME,
  });

  const grants: Grant[] = [];
  const missingGroups: string[] = [];

  try {
    // By name, never by the ids in the dump: the server was rebuilt and those
    // numbers may be dead (MIGRATION.md).
    const groups = await listServerGroups(teamspeak);
    const byName = new Map(groups.map((g) => [g.name, g.sgid]));

    for (const badge of BADGES) {
      const sgid = byName.get(badge);
      if (!sgid) {
        missingGroups.push(badge);
        continue;
      }

      for (const holder of await listServerGroupMembers(teamspeak, sgid)) {
        grants.push({ badge, uid: holder.uid, nickname: holder.nickname });
      }
    }
  } finally {
    teamspeak.forceQuit();
  }

  if (missingGroups.length > 0) {
    console.log(
      `WARNING: no TeamSpeak server group named: ${missingGroups.join(", ")}`,
    );
    console.log(
      "  Either the group is named differently on the server, or that badge has no holders.\n",
    );
  }

  // ------------------------------------------------ resolve them to members

  const members = await membersByTsUid(db);

  const resolved: { badge: string; discordId: string; who: string }[] = [];
  const unmapped: Grant[] = [];

  for (const grant of grants) {
    const owner = members.get(grant.uid);
    if (!owner) {
      unmapped.push(grant);
      continue;
    }
    resolved.push({
      badge: grant.badge,
      discordId: owner.discordId,
      who: owner.displayName,
    });
  }

  // ------------------------------------------------ what Discord has

  const existing = await listGuildRoles(auth, guildId);
  const roleByName = new Map(
    existing.filter((r) => !r.managed).map((r) => [r.name, r]),
  );

  const toCreate = BADGES.filter((badge) => !roleByName.has(badge));

  // ------------------------------------------------ the plan

  console.log("badge holders, according to TeamSpeak:\n");
  for (const badge of BADGES) {
    const holders = resolved.filter((r) => r.badge === badge);
    const orphans = unmapped.filter((g) => g.badge === badge);
    const role = roleByName.get(badge);
    console.log(
      `  ${badge.padEnd(20)} ${String(holders.length).padStart(3)} to grant` +
        (orphans.length ? `, ${orphans.length} unmapped` : "") +
        (role ? "   (role exists)" : "   (role must be created)"),
    );
  }

  console.log(
    `\n${resolved.length} grant(s) across ${
      new Set(resolved.map((r) => r.discordId)).size
    } member(s).`,
  );

  if (toCreate.length > 0) {
    console.log(`\nroles to create: ${toCreate.join(", ")}`);
  }

  /**
   * The important half of the output.
   *
   * These hold a badge on TeamSpeak but resolve to no member, because that
   * TeamSpeak identity is not linked to any Discord account. They cannot be given
   * the Discord role now. Nothing strips their badge today (see the header): the
   * reconcile never touches an identity that is nobody's `ts_uid`. The trap is
   * that a real member here who later LINKS this identity loses the badge by
   * linking, because Discord will not carry it. So this is the list to reconcile
   * by hand before Phase 3 leaves dry-run.
   */
  if (unmapped.length > 0) {
    const distinct = [...new Set(unmapped.map((o) => o.uid))];

    /**
     * Triage each unmapped identity against the people we already know. A nickname
     * that matches a member who is linked under a DIFFERENT uid is almost
     * certainly that member on a reinstalled client: grant them the Discord role
     * and they keep the badge. A nickname that matches nobody is probably someone
     * who left. The match is a hint for a human, never an automatic grant: two
     * people can share a nickname, and a wrong grant is a wrong qualification.
     */
    const linked = await listLinkedMembers(db);
    const guess = (nickname: string): string => {
      const needle = nickname.trim().toLowerCase();
      const hit = linked.find((m: LinkedMemberLite) =>
        m.displayName.trim().toLowerCase() === needle ||
        (m.tsNickname ?? "").trim().toLowerCase() === needle
      );
      return hit
        ? `  <- looks like member "${hit.displayName}", linked under a DIFFERENT identity`
        : "  <- matches no linked member (left the unit?)";
    };

    console.log(
      `\n${unmapped.length} unmapped grant(s) across ${distinct.length} TeamSpeak identit(ies).`,
    );
    console.log(
      "Not linked to any member, so they get no Discord role. Nothing strips these today;",
    );
    console.log(
      "the risk is that a real member here LOSES the badge if they later link this exact",
    );
    console.log(
      "identity while Discord lacks it. Grant them the role by hand, or have them link and",
    );
    console.log("re-run this, before the sync leaves dry-run.\n");

    // Grouped by identity, not by badge, so a human sees one person at a time.
    for (const uid of distinct) {
      const held = unmapped.filter((o) => o.uid === uid);
      console.log(`  ${held[0].nickname}  (${uid})`);
      console.log(`    badges: ${held.map((o) => o.badge).join(", ")}`);
      console.log(`  ${guess(held[0].nickname)}\n`);
    }
  }

  if (!apply) {
    console.log(
      "\n--- dry run. Nothing was written. Pass --apply to do it. ---",
    );
    return;
  }

  // ------------------------------------------------ do it

  console.log("\napplying...\n");

  for (const badge of toCreate) {
    // Created at the bottom of the role list, which is what puts it below
    // 7R_Bot and therefore assignable at all.
    const role = await createGuildRole(auth, guildId, {
      name: badge,
      reason: REASON,
    });
    roleByName.set(badge, role);
    console.log(`  created role ${badge} (${role.id})`);
  }

  let granted = 0;
  for (const grant of resolved) {
    const role = roleByName.get(grant.badge)!;
    await addMemberRole(auth, guildId, grant.discordId, role.id, REASON);
    granted++;
  }

  console.log(`  granted ${granted} role(s)\n`);

  /**
   * Phase 3's seed needs these, and MIGRATION.md's badge table still says TODO in
   * all eight rows. Print them in the shape it wants, so nobody has to go and
   * copy sixteen snowflakes out of the Discord client by hand.
   */
  console.log("Paste these into the badge table in docs/MIGRATION.md:\n");
  for (const badge of BADGES) {
    const role = roleByName.get(badge);
    console.log(`| ${badge} | ${role?.id ?? "NOT CREATED"} | ... |`);
  }
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await closeDb();
  }
}
