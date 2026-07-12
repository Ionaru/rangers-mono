import { sql } from "drizzle-orm";
import type { Db } from "./client.ts";

/** Queries live beside the schema (ADR 0008), so callers never import drizzle themselves. */

/** Round-trips to Postgres. Throws if the database is unreachable. */
export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}
