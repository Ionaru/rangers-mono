import { assert, assertEquals, assertThrows } from "@std/assert";
import { ConfigError, loadAll, loadConfig, memoize } from "./load.ts";
import {
  coreSchema,
  type DatabaseConfig,
  databaseSchema,
  type SteamConfig,
  steamSchema,
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

Deno.test("loadAll reports problems from every group, not just the first", () => {
  // The worker needs four groups of config. One group per restart is how setting
  // a box up becomes an afternoon: fix the token, redeploy, be told about the
  // TeamSpeak host, redeploy, be told about the password.
  const error = assertThrows(
    () =>
      loadAll([
        () => loadConfig(databaseSchema, {}),
        () => loadConfig(steamSchema, {}),
      ]),
    ConfigError,
  );

  assertEquals(error.problems.length, 2);
  assert(error.problems.some((p) => p.startsWith("DATABASE_URL")));
  assert(error.problems.some((p) => p.startsWith("STEAM_REALM")));
});

Deno.test("loadAll returns every value when the environment is complete", () => {
  const [database, steam] = loadAll<[DatabaseConfig, SteamConfig]>([
    () =>
      loadConfig(databaseSchema, {
        DATABASE_URL: "postgres://7r:pw@localhost:5432/7r",
      }),
    () => loadConfig(steamSchema, { STEAM_REALM: "https://7th-ranger.com" }),
  ]);

  assertEquals(database.DATABASE_URL, "postgres://7r:pw@localhost:5432/7r");
  assertEquals(steam.STEAM_REALM, "https://7th-ranger.com");
});

Deno.test("loadAll rethrows anything that is not a config problem", () => {
  // A ConfigError is "the operator has not filled this in yet". A TypeError is a
  // bug, and swallowing it into a list of missing variables would hide it.
  assertThrows(
    () =>
      loadAll([() => {
        throw new TypeError("this is a bug, not a missing variable");
      }]),
    TypeError,
  );
});

Deno.test("the TeamSpeak query port may never be 10011", () => {
  // Raw ServerQuery is cleartext and the host is on the public internet.
  const base = {
    TS_QUERY_HOST: "ts.7th-ranger.com",
    TS_QUERY_USER: "bot",
    TS_QUERY_PASS: "pw",
    TS_VIRTUALSERVER_ID: "1",
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

Deno.test("a mounted secret file wins over a directly-set value", async () => {
  // Compose loads the same .env into `web` and `worker` that a developer uses
  // on the host, and that file carries a localhost DATABASE_URL for `deno task
  // migrate`. If the plain value won, both services would dial localhost:5432
  // inside their own container instead of reading the secret Compose mounted.
  const path = await Deno.makeTempFile();
  const fromFile = "postgres://7r:from-the-file@postgres:5432/7r";
  await Deno.writeTextFile(path, fromFile);

  try {
    const config = loadConfig(coreSchema, {
      DATABASE_URL,
      DATABASE_URL_FILE: path,
    });
    assertEquals(config.DATABASE_URL, fromFile);
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("a plain .env works when nothing is mounted", () => {
  // The other half of that: local development sets no _FILE at all.
  const config = loadConfig(coreSchema, { DATABASE_URL });
  assertEquals(config.DATABASE_URL, DATABASE_URL);
});

Deno.test("a blank value reads as absent, not as an empty string", () => {
  // Compose's `env_file:` turns `LOG_LEVEL=` into "", and "" is defined, so
  // without this it would beat the default and fail the parse. A key someone
  // left blank to fill in later must not crash the service that reads it.
  assertEquals(
    loadConfig(coreSchema, { DATABASE_URL, LOG_LEVEL: "" }).LOG_LEVEL,
    "info",
  );
  assertEquals(loadConfig(syncSchema, { SYNC_DRY_RUN: "" }).SYNC_DRY_RUN, true);
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
