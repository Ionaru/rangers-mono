import {
  type DiscordBotConfig,
  getDiscordBotConfig,
  getSyncConfig,
  getTeamspeakConfig,
  loadAll,
  type SyncConfig,
  type TeamspeakConfig,
} from "@7r/config";
import { closeDb, getDb } from "@7r/db";
import { connectTeamspeak } from "@7r/teamspeak";
import { runSyncPass } from "./sync.ts";

/**
 * `deno task sync:preview`: the dry-run ADR 0009 promises, and the required
 * gate before the first real sync (IMPLEMENTATION §6). Computes a full
 * reconcile pass and prints the diff for a human at a terminal, which is where
 * admin review happens in a system with no admin UI. It writes NOTHING, ever:
 * it never passes `apply: true`, whatever SYNC_DRY_RUN says.
 *
 * A one-shot with its own ServerQuery connection: the worker's connection is
 * the worker's, and ServerQuery logins are not exclusive, so the two coexist.
 */

async function main(): Promise<number> {
  const [ts, bot, sync] = loadAll<
    [TeamspeakConfig, DiscordBotConfig, SyncConfig]
  >([getTeamspeakConfig, getDiscordBotConfig, getSyncConfig]);

  const db = getDb();
  const teamspeak = await connectTeamspeak({
    host: ts.TS_QUERY_HOST,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
    virtualServerId: ts.TS_VIRTUALSERVER_ID,
    nickname: `${ts.TS_BOT_NICKNAME} (preview)`,
  });

  try {
    const result = await runSyncPass(
      {
        db,
        teamspeak,
        discord: { botToken: bot.DISCORD_BOT_TOKEN },
        guildId: bot.DISCORD_GUILD_ID,
        maxRemovals: sync.SYNC_MAX_REMOVALS,
        log: () => {}, // the human-readable print below is the output
        alert: (summary, detail) =>
          console.error(`ALERT: ${summary}${detail ? `\n${detail}` : ""}`),
      },
      { apply: false },
    );

    if (result.outcome === "aborted") {
      console.error(`\nPreview aborted: ${result.abortReason}`);
      return 1;
    }

    const plan = result.plan!;
    const groupName = (sgid: number) =>
      `${result.groupNames.get(sgid) ?? "??"} (sgid ${sgid})`;

    console.log("\nsync preview: what a live pass would do\n");

    if (plan.changed.length === 0) {
      console.log("  nothing. Discord and TeamSpeak agree for every member.");
    }
    for (const m of plan.changed) {
      const flags = [
        m.stampDisabled ? "MISSING FROM GUILD - will stamp disabled_at" : "",
        m.clearDisabled ? "back in guild - will clear disabled_at" : "",
      ].filter(Boolean);
      console.log(
        `  ${m.displayName} (${m.tsUid})${
          flags.length ? `   [${flags.join("; ")}]` : ""
        }`,
      );
      for (const sgid of m.toAdd) console.log(`    + ${groupName(sgid)}`);
      for (const sgid of m.toRemove) console.log(`    - ${groupName(sgid)}`);
    }

    const warned = plan.members.filter((m) => m.warnings.length > 0);
    if (warned.length > 0) {
      console.log("\nwarnings (fix these in Discord):");
      for (const m of warned) {
        for (const w of m.warnings) console.log(`  ${m.displayName}: ${w}`);
      }
    }

    if (result.skipped.length > 0) {
      console.log(`\nskipped (${result.skipped.length}):`);
      for (const s of result.skipped) {
        console.log(`  ${s.displayName} (${s.tsUid}): ${s.reason}`);
      }
    }

    console.log(
      `\n${result.membersConsidered} linked member(s) considered, ` +
        `${plan.changed.length} with changes, removals touch ` +
        `${plan.removalMemberCount} member(s) (guard halts above ${plan.maxRemovals}).`,
    );

    if (plan.halted) {
      console.log(
        "\n*** THE BLAST-RADIUS GUARD WOULD HALT THIS PASS. ***\n" +
          "A live sync would apply NOTHING and alert. Do not flip SYNC_DRY_RUN " +
          "until this preview is clean: this many removals means a bad mapping, " +
          "a bad poll, or a decision a human has not made yet.",
      );
    } else {
      console.log(
        "\nIf this diff is what you expect, the sync is safe to run live " +
          "(SYNC_DRY_RUN=false). The blast-radius guard stays on regardless.",
      );
    }

    return 0;
  } finally {
    teamspeak.forceQuit();
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    await closeDb();
  }
  if (code > 0) Deno.exit(code);
}
