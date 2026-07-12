import { fromFileUrl } from "@std/path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getDatabaseConfig } from "@7r/config";
import { createDb } from "./client.ts";

/**
 * Apply migrations. One-shot, never on boot (ADR 0008: the legacy coupled
 * entity discovery to startup and paid for it).
 *
 * This is the *runtime* migrator, not `drizzle-kit migrate`, which drags tsx
 * and three copies of esbuild into the image. drizzle-kit is a dev-time
 * generator and nothing else.
 *
 * The folder is resolved relative to this file, not to the working directory,
 * so `deno task migrate` and the migrate container behave identically. It must
 * contain both the .sql files and meta/_journal.json; the Dockerfile copies the
 * whole directory for exactly that reason.
 */
if (import.meta.main) {
  // A database and nothing else: the migrator has no use for a base URL.
  const { DATABASE_URL } = getDatabaseConfig();
  const migrationsFolder = fromFileUrl(new URL("./drizzle", import.meta.url));

  // The migrator requires a single connection.
  const { db, sql } = createDb(DATABASE_URL, { max: 1 });

  try {
    console.log(`applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log("migrations applied");
  } finally {
    await sql.end();
  }
}
