/**
 * Reading the legacy MySQL dump (`data/Dump20260711.sql`).
 *
 * Pure: text in, rows out. No database, no filesystem. That is deliberate, and
 * it is the only reason any of the import is testable at all, in a project with
 * no live test environment (ARCHITECTURE §9). The script that writes to Postgres
 * (import-legacy.ts) does nothing this file cannot be tested without.
 *
 * We parse rather than restore because the source is MySQL and the target is
 * Postgres, and standing up a MySQL to `mysqldump | psql` through would be more
 * moving parts than the ~60 lines below. We only need two of its twenty tables.
 */

/** One row, as a list of raw column values. `null` is SQL NULL. */
export type DumpRow = (string | null)[];

/**
 * Pull the rows out of `INSERT INTO \`table\` VALUES (...),(...);`
 *
 * mysqldump writes one enormous INSERT per table with every row as a tuple, so
 * this is a small state machine over that, and not something a regex can do:
 * the values contain commas, brackets, and escaped quotes. One legacy member is
 * called `Zi'mer`, which the dump writes as `'Zi\'mer'`, and a parser that
 * splits on `','` truncates their name and shifts every subsequent column of
 * that row by one. That is the bug this function exists to not have.
 *
 * Returns an empty array if the table has no INSERT (an empty table in the
 * dump), which is not an error.
 */
export function parseInsertRows(sql: string, table: string): DumpRow[] {
  const marker = `INSERT INTO \`${table}\` VALUES `;
  const start = sql.indexOf(marker);
  if (start === -1) return [];

  const rows: DumpRow[] = [];
  let row: DumpRow = [];
  let field = "";
  let inString = false;
  let inRow = false;

  for (let i = start + marker.length; i < sql.length; i++) {
    const char = sql[i];

    if (inString) {
      if (char === "\\") {
        // A MySQL escape. Consume both characters, and translate the ones that
        // actually mean something other than themselves.
        const next = sql[i + 1];
        field += next === "n"
          ? "\n"
          : next === "r"
          ? "\r"
          : next === "t"
          ? "\t"
          : next === "0"
          ? "\0"
          : next;
        i++;
        continue;
      }
      if (char === "'") {
        // A doubled '' is an escaped quote, not the end of the string.
        if (sql[i + 1] === "'") {
          field += "'";
          i++;
          continue;
        }
        inString = false;
        continue;
      }
      field += char;
      continue;
    }

    if (char === "'") {
      inString = true;
      continue;
    }

    if (char === "(") {
      inRow = true;
      row = [];
      field = "";
      continue;
    }

    if (!inRow) {
      // Between tuples. The statement ends at the semicolon, and anything after
      // it belongs to another table.
      if (char === ";") break;
      continue;
    }

    if (char === ",") {
      row.push(toValue(field));
      field = "";
      continue;
    }

    if (char === ")") {
      row.push(toValue(field));
      rows.push(row);
      inRow = false;
      field = "";
      continue;
    }

    field += char;
  }

  return rows;
}

/**
 * An unquoted field. Only two of these matter to us: NULL, and numbers.
 *
 * A quoted field arrives here with its quotes already stripped by the state
 * machine, so it can never be confused with the literal `NULL`: a member whose
 * name is the four characters N-U-L-L is a string, and this is not asked about
 * them.
 */
function toValue(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "NULL" ? null : trimmed;
}

/** A legacy `user` row, reduced to the columns MIGRATION.md says to carry over. */
export interface LegacyUser {
  discordId: string;
  displayName: string;
  steamId: string | null;
  tsUserId: string | null;
}

/** A legacy `teamspeakUser` row: the join target for a member's TeamSpeak link. */
export interface LegacyTeamspeakUser {
  uid: string;
  nickname: string;
}

/**
 * The columns of `user`, in the order mysqldump writes them:
 *
 *   id, createdOn, updatedOn, uuid, name, discordUser, steamUser, rankId,
 *   ts3UserId, disabled
 *
 * Positional, because that is all a VALUES tuple gives us. If the dump is ever
 * regenerated from a schema that has changed, this is the line that breaks, and
 * `parseLegacyUsers` sanity-checks the shape below so that it breaks loudly.
 */
const USER_COLUMNS = 10;
const USER_NAME = 4;
const USER_DISCORD = 5;
const USER_STEAM = 6;
const USER_TS3 = 8;

const TS_COLUMNS = 5;
const TS_ID = 0;
const TS_UID = 3;
const TS_NICKNAME = 4;

/**
 * The 150 members, of whom all have a Discord id (MIGRATION.md).
 *
 * A row with no Discord id cannot become a Member at all: `member.discord_id` is
 * required, because Discord is the hub and the login (ADR 0001). None exist in
 * this dump, so rather than silently dropping such a row, this throws: it would
 * mean the dump is not the one this was written against.
 */
export function parseLegacyUsers(sql: string): LegacyUser[] {
  return parseInsertRows(sql, "user").map((row, index) => {
    if (row.length !== USER_COLUMNS) {
      throw new Error(
        `legacy user row ${index} has ${row.length} columns, expected ${USER_COLUMNS}. The dump's schema is not the one this importer was written for.`,
      );
    }

    const discordId = row[USER_DISCORD];
    const displayName = row[USER_NAME];

    if (!discordId) {
      throw new Error(
        `legacy user row ${index} (${displayName}) has no Discord id. Every one of the 150 in this dump has one, and a Member cannot exist without it (ADR 0001).`,
      );
    }

    return {
      discordId,
      displayName: displayName ?? discordId,
      steamId: row[USER_STEAM],
      tsUserId: row[USER_TS3],
    };
  });
}

/** `teamspeakUser.id` -> its identity. Only a join source; these are not imported as rows. */
export function parseLegacyTeamspeakUsers(
  sql: string,
): Map<string, LegacyTeamspeakUser> {
  const byId = new Map<string, LegacyTeamspeakUser>();

  for (const row of parseInsertRows(sql, "teamspeakUser")) {
    if (row.length !== TS_COLUMNS) {
      throw new Error(
        `legacy teamspeakUser row has ${row.length} columns, expected ${TS_COLUMNS}. The dump's schema is not the one this importer was written for.`,
      );
    }

    const id = row[TS_ID];
    const uid = row[TS_UID];
    if (!id || !uid) continue;

    byId.set(id, { uid, nickname: row[TS_NICKNAME] ?? uid });
  }

  return byId;
}

/** What the importer will write for one member. */
export interface LegacyMemberImport {
  discordId: string;
  displayName: string;
  tsUid: string | null;
  tsNickname: string | null;
  steamId: string | null;
}

/**
 * Join the two tables into the rows to upsert.
 *
 * The one thing worth being careful about: `member.ts_uid` is UNIQUE, and the
 * legacy `teamspeakUser` table has no unique constraint on `uid`. If two members
 * point at two different `teamspeakUser` rows holding the *same* uid, the import
 * would fail halfway through on a constraint violation, having already written
 * everything before it. So find that here, before writing anything, and say who.
 *
 * (In the actual dump this does not happen: the 99 links resolve to 99 distinct
 * uids. This exists so that a *different* dump cannot corrupt an import halfway.)
 */
export function buildLegacyImport(sql: string): LegacyMemberImport[] {
  const teamspeakUsers = parseLegacyTeamspeakUsers(sql);
  const rows: LegacyMemberImport[] = [];
  const seenUids = new Map<string, string>();

  for (const user of parseLegacyUsers(sql)) {
    let tsUid: string | null = null;
    let tsNickname: string | null = null;

    if (user.tsUserId) {
      const teamspeakUser = teamspeakUsers.get(user.tsUserId);
      if (!teamspeakUser) {
        throw new Error(
          `${user.displayName} points at teamspeakUser ${user.tsUserId}, which is not in the dump.`,
        );
      }

      const owner = seenUids.get(teamspeakUser.uid);
      if (owner) {
        throw new Error(
          `TeamSpeak identity ${teamspeakUser.uid} is claimed by both ${owner} and ${user.displayName}. member.ts_uid is unique, so this import would fail halfway. Resolve it in the dump first.`,
        );
      }
      seenUids.set(teamspeakUser.uid, user.displayName);

      tsUid = teamspeakUser.uid;
      tsNickname = teamspeakUser.nickname;
    }

    rows.push({
      discordId: user.discordId,
      displayName: user.displayName,
      tsUid,
      tsNickname,
      steamId: user.steamId,
    });
  }

  return rows;
}
