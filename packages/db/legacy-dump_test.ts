import { assertEquals, assertThrows } from "@std/assert";
import {
  buildLegacyImport,
  parseInsertRows,
  parseLegacyTeamspeakUsers,
  parseLegacyUsers,
} from "./legacy-dump.ts";

/**
 * A miniature of the real dump. Same column order, same quirks:
 * `Zi'mer` (an escaped quote), NULLs in every optional column, and a member with
 * no TeamSpeak link.
 */
const DUMP = `
CREATE TABLE \`teamspeakUser\` (...);
INSERT INTO \`teamspeakUser\` VALUES (1,'2020-01-18 19:20:35.000000','2020-01-18 19:20:35.000000','4zKOQm6NNMgAP2BEM4Kn8/dzk6g=','IAlexander'),(20,'2020-01-18 19:20:35.000000','2020-01-18 19:20:35.000000','eFGeAn6ewo8wGEj57HCzzz31X0w=','Ionaru');
CREATE TABLE \`user\` (...);
INSERT INTO \`user\` VALUES (1,'2020-01-25 23:11:02.025527','2023-09-03 18:50:47.000000','1032f3a7-ed8a-4f5e-bf7c-7782640e076e','ionaru','96746840958959616','76561198009917136',2,20,0),(2,'2020-02-03 18:44:00.492838','2022-04-11 00:40:08.000000','4edd6212-3b1e-4ecf-9f94-2163da8d8cbb','Zi\\'mer','262172487809368064',NULL,1,1,0),(3,'2020-02-05 22:47:08.798715','2022-04-11 00:52:03.000000','cad33699-e858-4167-b9a7-000000000000','NoTeamSpeak','305471712546390017',NULL,NULL,NULL,0);
`;

Deno.test("an escaped quote does not truncate the name or shift the row", () => {
  // The bug this parser exists to not have: splitting on `','` turns Zi'mer into
  // "Zi" and shifts every subsequent column of that row by one, so their Discord
  // id silently becomes someone else's data.
  const users = parseLegacyUsers(DUMP);
  assertEquals(users[1].displayName, "Zi'mer");
  assertEquals(users[1].discordId, "262172487809368064");
  assertEquals(users[1].steamId, null);
  assertEquals(users[1].tsUserId, "1");
});

Deno.test("NULL is null, and is not the string 'NULL'", () => {
  const users = parseLegacyUsers(DUMP);
  assertEquals(users[2].steamId, null);
  assertEquals(users[2].tsUserId, null);
});

Deno.test("every user row is parsed, with the right columns", () => {
  const users = parseLegacyUsers(DUMP);
  assertEquals(users.length, 3);
  assertEquals(users[0], {
    discordId: "96746840958959616",
    displayName: "ionaru",
    steamId: "76561198009917136",
    tsUserId: "20",
  });
});

Deno.test("teamspeak users are indexed by their legacy id", () => {
  const byId = parseLegacyTeamspeakUsers(DUMP);
  assertEquals(byId.size, 2);
  assertEquals(byId.get("20"), {
    uid: "eFGeAn6ewo8wGEj57HCzzz31X0w=",
    nickname: "Ionaru",
  });
  // A base64 uid contains '/' and '=', which must survive the parser untouched.
  assertEquals(byId.get("1")?.uid, "4zKOQm6NNMgAP2BEM4Kn8/dzk6g=");
});

Deno.test("the join produces exactly what the importer writes", () => {
  const rows = buildLegacyImport(DUMP);

  assertEquals(rows.length, 3);
  assertEquals(rows[0], {
    discordId: "96746840958959616",
    displayName: "ionaru",
    tsUid: "eFGeAn6ewo8wGEj57HCzzz31X0w=",
    tsNickname: "Ionaru",
    steamId: "76561198009917136",
  });
  // A member with no TeamSpeak link is still a member.
  assertEquals(rows[2], {
    discordId: "305471712546390017",
    displayName: "NoTeamSpeak",
    tsUid: null,
    tsNickname: null,
    steamId: null,
  });
});

Deno.test("a missing table is empty, not an error", () => {
  assertEquals(parseInsertRows(DUMP, "loa"), []);
});

Deno.test("two members claiming one TeamSpeak identity is caught BEFORE any write", () => {
  // member.ts_uid is UNIQUE and the legacy table's uid is not, so this would
  // otherwise fail halfway through the import, with half the rows written.
  const clashing = DUMP.replace(
    "(2,'2020-02-03 18:44:00.492838','2022-04-11 00:40:08.000000','4edd6212-3b1e-4ecf-9f94-2163da8d8cbb','Zi\\'mer','262172487809368064',NULL,1,1,0)",
    "(2,'2020-02-03 18:44:00.492838','2022-04-11 00:40:08.000000','4edd6212-3b1e-4ecf-9f94-2163da8d8cbb','Zi\\'mer','262172487809368064',NULL,1,20,0)",
  );

  const error = assertThrows(() => buildLegacyImport(clashing), Error);
  // It names both of them, because the point is to be able to go and fix it.
  assertEquals(error.message.includes("ionaru"), true);
  assertEquals(error.message.includes("Zi'mer"), true);
});

Deno.test("a user with no Discord id is refused, loudly", () => {
  // A Member cannot exist without one (ADR 0001). None exist in the real dump,
  // so hitting this means the dump is not the one we were written against.
  const noDiscord = DUMP.replace(
    "'305471712546390017',NULL,NULL,NULL,0",
    "NULL,NULL,NULL,NULL,0",
  );
  assertThrows(() => parseLegacyUsers(noDiscord), Error, "no Discord id");
});

Deno.test("an unexpected column count is refused rather than mis-mapped", () => {
  const extraColumn = DUMP.replace(
    "'ionaru','96746840958959616','76561198009917136',2,20,0)",
    "'ionaru','96746840958959616','76561198009917136',2,20,0,'surprise')",
  );
  assertThrows(() => parseLegacyUsers(extraColumn), Error, "columns");
});
