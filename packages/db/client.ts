import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getDatabaseConfig } from "@7r/config";

export type Db = ReturnType<typeof createDb>["db"];

/**
 * An explicit connection, for callers that own the lifecycle (the migrator, tests).
 *
 * `{ client: sql }`, never `drizzle(sql)`. Drizzle 1.0 dropped the bare-client
 * overload, and it does not fail cleanly: it destructures its first argument
 * looking for `client` / `connection`, finds neither on a postgres.js `Sql`
 * (which is a function, not an options object), and falls through to opening a
 * *new* connection from the PGHOST/PGDATABASE environment defaults. Our client
 * would be silently discarded, and with it the `max: 1` and the lock/statement
 * timeouts migrate.ts sets and ADR 0013 leans on. A migrator quietly pointed at
 * a different database is about the worst failure this file could have, so it
 * is worth a comment: the types catch it today, and this says why not to
 * "simplify" it back.
 *
 * Deliberately no `{ schema }` argument either: its only effect is to populate
 * the `db.query.<table>` relational surface, which ADR 0008 says not to adopt.
 * Leaving it off means the forbidden surface is not reachable from `Db` at all,
 * which is also what keeps better-auth's Drizzle adapter on its plain-query path
 * (it only reaches for `db.query` under `experimental.joins`, which stays off).
 */
export function createDb(
  url: string,
  options: postgres.Options<Record<string, never>> = {},
) {
  const sql = postgres(url, options);
  return { db: drizzle({ client: sql }), sql };
}

let shared: ReturnType<typeof createDb> | undefined;

/**
 * The shared connection for a long-running service.
 *
 * Lazy for the same reason the config is: `astro build` executes module code,
 * and a connection opened at module scope would be opened during the build.
 */
export function getDb(): Db {
  shared ??= createDb(getDatabaseConfig().DATABASE_URL);
  return shared.db;
}

/**
 * Close the shared pool. A long-running service must call this when it shuts
 * down: postgres.js keeps idle sockets open, and an open socket keeps Deno's
 * event loop alive, so a worker that skips this never exits at all. Compose
 * then waits out its kill timeout on every single deploy.
 *
 * A no-op if nothing ever connected.
 */
export async function closeDb(): Promise<void> {
  if (!shared) return;
  const { sql } = shared;
  shared = undefined;
  await sql.end();
}
