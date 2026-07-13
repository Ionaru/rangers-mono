import { getDatabaseConfig } from "@7r/config";
import { createDb } from "./client.ts";
import { buildLegacyImport, type LegacyMemberImport } from "./legacy-dump.ts";
import { upsertLegacyMember } from "./queries.ts";

/**
 * The legacy identity import (MIGRATION.md). A one-shot, run by hand, once.
 *
 * What it carries over, and nothing else:
 *   - the 150 members, keyed by Discord id, which every one of them has;
 *   - the 99 TeamSpeak links, marked `legacy_import` and left UNVERIFIED
 *     (`ts_verified_at` stays null), because a link copied out of a 2020
 *     database is a claim, not a proof. Re-linking through the poke flow is
 *     what upgrades it to `poke` with a real timestamp.
 *   - the 23 Steam ids, marked `manual` for the same reason.
 *
 * What it deliberately does not carry: ranks, roles and badges (Discord is the
 * truth for those, ADR 0002), attendance and operations (they start from zero,
 * ADR 0010), LOA (which is not a concept here), and the 7-permission model.
 *
 * Idempotent, and it has to be: a one-shot script you cannot safely run twice is
 * a one-shot script you are afraid of. Re-running it changes nothing, and it
 * will never overwrite an identity a member has since verified for real
 * (see `upsertLegacyMember`).
 *
 *   deno task import:legacy -- --dry-run
 *   deno task import:legacy
 *
 * Or, on the box, where the dump has to be mounted because it is deliberately
 * kept out of every image (it is 150 people's personal data):
 *
 *   docker compose --profile import run --rm import --dry-run
 *   docker compose --profile import run --rm import
 */

const DEFAULT_DUMP_PATH = "data/Dump20260711.sql";

async function main() {
  const dryRun = Deno.args.includes("--dry-run");
  const pathArg = Deno.args.find((arg) => arg.startsWith("--dump="));
  const dumpPath = pathArg?.slice("--dump=".length) ?? DEFAULT_DUMP_PATH;

  let sql: string;
  try {
    sql = await Deno.readTextFile(dumpPath);
  } catch (cause) {
    console.error(
      `cannot read the legacy dump at ${dumpPath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    console.error(
      "\nThe dump is git-ignored and docker-ignored on purpose: it holds 150 members'",
      "\nDiscord, TeamSpeak and Steam ids. Put it at data/ on the host, or pass --dump=<path>.",
    );
    Deno.exit(1);
  }

  // Everything that can fail on the data itself fails here, before a single row
  // is written: a duplicate TeamSpeak identity, a member with no Discord id, a
  // dump whose columns are not the ones this was written for.
  const rows = buildLegacyImport(sql);
  summarise(rows, dumpPath);

  if (dryRun) {
    console.log("\n--dry-run: nothing was written.");
    return;
  }

  const { DATABASE_URL } = getDatabaseConfig();
  const { db, sql: connection } = createDb(DATABASE_URL, { max: 1 });

  let inserted = 0;
  let updated = 0;

  try {
    for (const row of rows) {
      const result = await upsertLegacyMember(db, row);
      if (result.inserted) inserted++;
      else updated++;
    }
  } finally {
    await connection.end();
  }

  console.log(`\ninserted ${inserted}, updated ${updated}`);
  console.log(
    "The TeamSpeak links are flagged `legacy_import` and unverified. Members re-link",
    "\nthrough the poke flow to prove them, which is what turns them into `poke`.",
  );
}

function summarise(rows: LegacyMemberImport[], dumpPath: string) {
  const withTs = rows.filter((row) => row.tsUid).length;
  const withSteam = rows.filter((row) => row.steamId).length;

  console.log(`read ${dumpPath}`);
  console.log(`  members:         ${rows.length}`);
  console.log(`  TeamSpeak links: ${withTs}  (legacy_import, unverified)`);
  console.log(`  Steam ids:       ${withSteam}  (manual, unverified)`);
}

if (import.meta.main) {
  await main();
}
