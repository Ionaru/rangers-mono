import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

/** Run `fn`, require it to throw `cls` (and a message with `msg`), return it. */
function throws<E extends Error>(
  fn: () => unknown,
  cls: new (...args: never[]) => E,
  msg?: string,
): E {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (e) {
    caught = e;
    threw = true;
  }
  assert.ok(threw, "expected the function to throw");
  assert.ok(caught instanceof cls, `expected ${cls.name}, got ${String(caught)}`);
  if (msg !== undefined) {
    assert.ok(
      (caught as Error).message.includes(msg),
      `expected message ${JSON.stringify((caught as Error).message)} to include ${JSON.stringify(msg)}`,
    );
  }
  return caught as E;
}

const DATABASE_URL = "postgres://7r:pw@postgres:5432/7r";

test("a valid environment parses, with defaults applied", () => {
  const config = loadConfig(coreSchema, { DATABASE_URL });
  assert.deepStrictEqual(config.DATABASE_URL, DATABASE_URL);
  assert.deepStrictEqual(config.LOG_LEVEL, "info");
});

test("a missing variable fails loud", () => {
  const error = throws(() => loadConfig(coreSchema, {}), ConfigError);
  assert.ok(error.message.includes("DATABASE_URL"));
});

test("every problem is reported at once, not just the first", () => {
  // Fixing config one restart at a time is the failure mode this prevents.
  const error = throws(
    () => loadConfig(webSchema, { LOG_LEVEL: "chatty" }),
    ConfigError,
  );
  assert.deepStrictEqual(error.problems.length, 3);
  assert.ok(error.problems.some((p) => p.startsWith("DATABASE_URL:")));
  assert.ok(error.problems.some((p) => p.startsWith("LOG_LEVEL:")));
  assert.ok(error.problems.some((p) => p.startsWith("PUBLIC_BASE_URL:")));
});

test("a service only has to supply what it reads", () => {
  // The migrator opens a connection and applies SQL. Making it demand a
  // PUBLIC_BASE_URL it never reads is how people learn to fill config with junk.
  const config = loadConfig(databaseSchema, { DATABASE_URL });
  assert.deepStrictEqual(config.DATABASE_URL, DATABASE_URL);
});

test("a malformed value is rejected, not coerced", () => {
  const error = throws(
    () => loadConfig(syncSchema, { SYNC_MAX_REMOVALS: "five" }),
    ConfigError,
  );
  assert.ok(error.problems.some((p) => p.includes("whole number")));
});

test("a non-postgres DATABASE_URL is rejected", () => {
  throws(
    () => loadConfig(coreSchema, { DATABASE_URL: "mysql://localhost/7r" }),
    ConfigError,
  );
});

test("SYNC_DRY_RUN defaults to true", () => {
  // It stays true until a preview has been reviewed (ADR 0009).
  assert.deepStrictEqual(loadConfig(syncSchema, {}).SYNC_DRY_RUN, true);
  assert.deepStrictEqual(
    loadConfig(syncSchema, { SYNC_DRY_RUN: "false" }).SYNC_DRY_RUN,
    false,
  );
});

test("loadAll reports problems from every group, not just the first", () => {
  // The worker needs four groups of config. One group per restart is how setting
  // a box up becomes an afternoon: fix the token, redeploy, be told about the
  // TeamSpeak host, redeploy, be told about the password.
  const error = throws(
    () =>
      loadAll([
        () => loadConfig(databaseSchema, {}),
        () => loadConfig(steamSchema, {}),
      ]),
    ConfigError,
  );

  assert.deepStrictEqual(error.problems.length, 2);
  assert.ok(error.problems.some((p) => p.startsWith("DATABASE_URL")));
  assert.ok(error.problems.some((p) => p.startsWith("STEAM_REALM")));
});

test("loadAll returns every value when the environment is complete", () => {
  const [database, steam] = loadAll<[DatabaseConfig, SteamConfig]>([
    () =>
      loadConfig(databaseSchema, {
        DATABASE_URL: "postgres://7r:pw@localhost:5432/7r",
      }),
    () => loadConfig(steamSchema, { STEAM_REALM: "https://7th-ranger.com" }),
  ]);

  assert.deepStrictEqual(database.DATABASE_URL, "postgres://7r:pw@localhost:5432/7r");
  assert.deepStrictEqual(steam.STEAM_REALM, "https://7th-ranger.com");
});

test("loadAll rethrows anything that is not a config problem", () => {
  // A ConfigError is "the operator has not filled this in yet". A TypeError is a
  // bug, and swallowing it into a list of missing variables would hide it.
  throws(
    () =>
      loadAll([() => {
        throw new TypeError("this is a bug, not a missing variable");
      }]),
    TypeError,
  );
});

test("the TeamSpeak query port may never be 10011", () => {
  // Raw ServerQuery is cleartext and the host is on the public internet.
  const base = {
    TS_QUERY_HOST: "ts.7th-ranger.com",
    TS_QUERY_USER: "bot",
    TS_QUERY_PASS: "pw",
    TS_VIRTUALSERVER_ID: "1",
  };
  assert.deepStrictEqual(
    loadConfig(teamspeakSchema, { ...base, TS_QUERY_PORT: "10022" })
      .TS_QUERY_PORT,
    10022,
  );
  const error = throws(
    () => loadConfig(teamspeakSchema, { ...base, TS_QUERY_PORT: "10011" }),
    ConfigError,
  );
  assert.ok(error.message.includes("cleartext"));
});

test("a secret is read from the file Compose mounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "7r-"));
  const path = join(dir, "secret");
  // The trailing newline is what `echo secret > file` leaves behind.
  await writeFile(path, `${DATABASE_URL}\n`);

  try {
    const config = loadConfig(coreSchema, { DATABASE_URL_FILE: path });
    assert.deepStrictEqual(config.DATABASE_URL, DATABASE_URL);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mounted secret file wins over a directly-set value", async () => {
  // Compose loads the same .env into `web` and `worker` that a developer uses
  // on the host, and that file carries a localhost DATABASE_URL for `pnpm
  // migrate`. If the plain value won, both services would dial localhost:5432
  // inside their own container instead of reading the secret Compose mounted.
  const dir = await mkdtemp(join(tmpdir(), "7r-"));
  const path = join(dir, "secret");
  const fromFile = "postgres://7r:from-the-file@postgres:5432/7r";
  await writeFile(path, fromFile);

  try {
    const config = loadConfig(coreSchema, {
      DATABASE_URL,
      DATABASE_URL_FILE: path,
    });
    assert.deepStrictEqual(config.DATABASE_URL, fromFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a plain .env works when nothing is mounted", () => {
  // The other half of that: local development sets no _FILE at all.
  const config = loadConfig(coreSchema, { DATABASE_URL });
  assert.deepStrictEqual(config.DATABASE_URL, DATABASE_URL);
});

test("a blank value reads as absent, not as an empty string", () => {
  // Compose's `env_file:` turns `LOG_LEVEL=` into "", and "" is defined, so
  // without this it would beat the default and fail the parse. A key someone
  // left blank to fill in later must not crash the service that reads it.
  assert.deepStrictEqual(
    loadConfig(coreSchema, { DATABASE_URL, LOG_LEVEL: "" }).LOG_LEVEL,
    "info",
  );
  assert.deepStrictEqual(loadConfig(syncSchema, { SYNC_DRY_RUN: "" }).SYNC_DRY_RUN, true);
});

test("an unreadable secret file fails loud rather than silently missing", () => {
  // A secret Compose failed to mount must not read as "not configured".
  const error = throws(
    () => loadConfig(coreSchema, { DATABASE_URL_FILE: "/run/secrets/nope" }),
    ConfigError,
  );
  assert.ok(error.message.includes("/run/secrets/nope"));
});

test("memoize parses once", () => {
  let calls = 0;
  const load = memoize(() => {
    calls++;
    return loadConfig(coreSchema, { DATABASE_URL });
  });
  load();
  load();
  assert.deepStrictEqual(calls, 1);
});
