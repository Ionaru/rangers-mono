import { assert, assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadConfig, memoize } from "./load.ts";
import {
  coreSchema,
  databaseSchema,
  syncSchema,
  teamspeakSchema,
  webSchema,
} from "./schemas.ts";

const DATABASE_URL = "postgres://7r:pw@postgres:5432/7r";

Deno.test("a valid environment parses, with defaults applied", () => {
  const config = loadConfig(coreSchema, { DATABASE_URL });
  assertEquals(config.DATABASE_URL, DATABASE_URL);
  assertEquals(config.LOG_LEVEL, "info");
});

Deno.test("a missing variable fails loud", () => {
  const error = assertThrows(() => loadConfig(coreSchema, {}), ConfigError);
  assert(error.message.includes("DATABASE_URL"));
});

Deno.test("every problem is reported at once, not just the first", () => {
  // Fixing config one restart at a time is the failure mode this prevents.
  const error = assertThrows(
    () => loadConfig(webSchema, { LOG_LEVEL: "chatty" }),
    ConfigError,
  );
  assertEquals(error.problems.length, 3);
  assert(error.problems.some((p) => p.startsWith("DATABASE_URL:")));
  assert(error.problems.some((p) => p.startsWith("LOG_LEVEL:")));
  assert(error.problems.some((p) => p.startsWith("PUBLIC_BASE_URL:")));
});

Deno.test("a service only has to supply what it reads", () => {
  // The migrator opens a connection and applies SQL. Making it demand a
  // PUBLIC_BASE_URL it never reads is how people learn to fill config with junk.
  const config = loadConfig(databaseSchema, { DATABASE_URL });
  assertEquals(config.DATABASE_URL, DATABASE_URL);
});

Deno.test("a malformed value is rejected, not coerced", () => {
  const error = assertThrows(
    () => loadConfig(syncSchema, { SYNC_MAX_REMOVALS: "five" }),
    ConfigError,
  );
  assert(error.problems.some((p) => p.includes("whole number")));
});

Deno.test("a non-postgres DATABASE_URL is rejected", () => {
  assertThrows(
    () => loadConfig(coreSchema, { DATABASE_URL: "mysql://localhost/7r" }),
    ConfigError,
  );
});

Deno.test("SYNC_DRY_RUN defaults to true", () => {
  // It stays true until a preview has been reviewed (ADR 0009).
  assertEquals(loadConfig(syncSchema, {}).SYNC_DRY_RUN, true);
  assertEquals(
    loadConfig(syncSchema, { SYNC_DRY_RUN: "false" }).SYNC_DRY_RUN,
    false,
  );
});

Deno.test("the TeamSpeak query port may never be 10011", () => {
  // Raw ServerQuery is cleartext and the host is on the public internet.
  const base = {
    TS_QUERY_HOST: "ts.7th-ranger.com",
    TS_QUERY_USER: "bot",
    TS_QUERY_PASS: "pw",
    TS_VIRTUALSERVER_ID: "1",
    TS_OPERATIONS_CHANNEL_CID: "42",
  };
  assertEquals(
    loadConfig(teamspeakSchema, { ...base, TS_QUERY_PORT: "10022" })
      .TS_QUERY_PORT,
    10022,
  );
  const error = assertThrows(
    () => loadConfig(teamspeakSchema, { ...base, TS_QUERY_PORT: "10011" }),
    ConfigError,
  );
  assert(error.message.includes("cleartext"));
});

Deno.test("a secret is read from the file Compose mounts", async () => {
  const path = await Deno.makeTempFile();
  // The trailing newline is what `echo secret > file` leaves behind.
  await Deno.writeTextFile(path, `${DATABASE_URL}\n`);

  try {
    const config = loadConfig(coreSchema, { DATABASE_URL_FILE: path });
    assertEquals(config.DATABASE_URL, DATABASE_URL);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("a directly-set value wins over its _FILE counterpart", async () => {
  // This is what keeps a plain .env working in local development.
  const path = await Deno.makeTempFile();
  await Deno.writeTextFile(
    path,
    "postgres://7r:from-the-file@postgres:5432/7r",
  );

  try {
    const config = loadConfig(coreSchema, {
      DATABASE_URL,
      DATABASE_URL_FILE: path,
    });
    assertEquals(config.DATABASE_URL, DATABASE_URL);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("an unreadable secret file fails loud rather than silently missing", () => {
  // A secret Compose failed to mount must not read as "not configured".
  const error = assertThrows(
    () => loadConfig(coreSchema, { DATABASE_URL_FILE: "/run/secrets/nope" }),
    ConfigError,
  );
  assert(error.message.includes("/run/secrets/nope"));
});

Deno.test("memoize parses once", () => {
  let calls = 0;
  const load = memoize(() => {
    calls++;
    return loadConfig(coreSchema, { DATABASE_URL });
  });
  load();
  load();
  assertEquals(calls, 1);
});
