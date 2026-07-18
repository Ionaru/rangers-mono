import { getTeamspeakConfig, loadAll, type TeamspeakConfig } from "@7r/config";
import {
  type Assignable,
  closeDb,
  getDb,
  listAssignables,
  upsertAssignable,
} from "@7r/db";
import { connectTeamspeak, listServerGroups } from "@7r/teamspeak";
import {
  ASSIGNABLE_CONFIG,
  type AssignableConfigEntry,
} from "./assignable-config.ts";

/**
 * Phase 4's seed: apply the git-tracked Assignable mapping to the database.
 *
 *   deno task assignables:seed            # prints the plan, writes nothing
 *   deno task assignables:seed -- --apply # asks for confirmation, then writes
 *
 * Sgids are resolved LIVE, by TeamSpeak group name, against `servergrouplist`,
 * and never taken from the config or the legacy dump: the dump's numbers come
 * in two families because the server was rebuilt, and any stored sgid is a
 * number nobody can trust (MIGRATION.md, gotcha 1). The proposed name-to-sgid
 * mapping is printed and confirmed at the terminal before any write, which is
 * where confirmation happens in a system with no admin UI (ADR 0009).
 *
 * A name with no live match seeds with `tsSgid: null`: the Discord half of the
 * row is still true, it simply is not mirrored to TeamSpeak until the group
 * name is fixed (there or here) and the seed re-run. The upsert overwrites, so
 * a re-run corrects rather than preserves a wrong number.
 *
 * Sequencing: run after Phase 0's `badges:backfill` has created the badge
 * roles (their ids are already in the config), and before the first
 * `sync:preview`. Idempotent by `discordRoleId`; re-run it freely.
 */

async function main(): Promise<number> {
  const apply = Deno.args.includes("--apply");

  const [ts] = loadAll<[TeamspeakConfig]>([getTeamspeakConfig]);
  const db = getDb();

  // ------------------------------------------------ resolve sgids, live

  const teamspeak = await connectTeamspeak({
    host: ts.TS_QUERY_HOST,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
    virtualServerId: ts.TS_VIRTUALSERVER_ID,
    nickname: ts.TS_BOT_NICKNAME,
  });

  let liveByName: Map<string, string>;
  try {
    const groups = await listServerGroups(teamspeak);
    liveByName = new Map(groups.map((g) => [g.name, g.sgid]));
  } finally {
    teamspeak.forceQuit();
  }

  const resolved: {
    entry: AssignableConfigEntry;
    tsSgid: number | null;
  }[] = ASSIGNABLE_CONFIG.map((entry) => {
    if (entry.tsGroupName === null) return { entry, tsSgid: null };
    const sgid = liveByName.get(entry.tsGroupName);
    return { entry, tsSgid: sgid === undefined ? null : Number(sgid) };
  });

  const unresolved = resolved.filter(
    (r) => r.entry.tsGroupName !== null && r.tsSgid === null,
  );

  // ------------------------------------------------ the proposed mapping

  const current: Assignable[] = await listAssignables(db);
  const currentByRoleId = new Map(current.map((a) => [a.discordRoleId, a]));

  console.log("proposed assignable mapping (sgids resolved live, by name):\n");
  console.log(
    `  ${"kind".padEnd(6)} ${"name".padEnd(20)} ${"discord role".padEnd(20)} ${
      "ts group".padEnd(20)
    } sgid`,
  );
  for (const { entry, tsSgid } of resolved) {
    const existing = currentByRoleId.get(entry.discordRoleId);
    const changed = existing !== undefined && existing.tsSgid !== tsSgid;
    console.log(
      `  ${entry.kind.padEnd(6)} ${entry.name.padEnd(20)} ${
        entry.discordRoleId.padEnd(20)
      } ${(entry.tsGroupName ?? "(none)").padEnd(20)} ${
        tsSgid === null
          ? (entry.tsGroupName === null ? "-" : "NO MATCH")
          : tsSgid
      }${changed ? `   (db has ${existing.tsSgid ?? "null"})` : ""}`,
    );
  }
  console.log(
    `\n${resolved.length} entries; ${current.length} currently in the database.`,
  );

  if (unresolved.length > 0) {
    console.log(
      `\nWARNING: ${unresolved.length} group name(s) have NO live TeamSpeak match:`,
    );
    for (const { entry } of unresolved) {
      console.log(`  ${entry.name} (expected group "${entry.tsGroupName}")`);
    }
    console.log(
      "  These seed with tsSgid = null and will NOT be mirrored to TeamSpeak.\n" +
        "  Fix the group name (on the server or in assignable-config.ts) and re-run.",
    );
  }

  if (!apply) {
    console.log(
      "\n--- dry run. Nothing was written. Pass --apply to do it. ---",
    );
    return 0;
  }

  // ------------------------------------------------ confirm, then write

  // The terminal confirmation MIGRATION.md demands before any write. confirm()
  // needs a TTY; a headless run (echo | or CI) answers "no" and writes nothing,
  // which is the right default for a tool whose output the docs say a human
  // reviews.
  const confirmed = confirm(
    `\nWrite these ${resolved.length} assignable rows?`,
  );
  if (!confirmed) {
    console.log("Not confirmed. Nothing was written.");
    return 0;
  }

  for (const { entry, tsSgid } of resolved) {
    await upsertAssignable(db, {
      kind: entry.kind,
      name: entry.name,
      discordRoleId: entry.discordRoleId,
      tsSgid,
      sortOrder: entry.sortOrder,
    });
  }

  console.log(
    `\nSeeded ${resolved.length} assignable(s) (${current.length} existed before).` +
      `\nNext: deno task sync:preview, and review the diff before flipping SYNC_DRY_RUN.`,
  );
  return 0;
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
