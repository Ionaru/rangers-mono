import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is a dev-time generator only: it never runs in an image, and it
 * never applies a migration (that is migrate.ts, ADR 0008).
 *
 * Two things this file must not do:
 * - resolve its paths against anything but the working directory. drizzle-kit
 *   reads `schema` and `out` relative to process.cwd(), not to this file, so
 *   the `generate` task is defined in this package's deno.json and invoked with
 *   `deno task --cwd packages/db generate`. Run it from the repo root and it
 *   writes the migrations to the repo root.
 * - import @7r/config. Generating a migration needs no database, and a
 *   fail-loud config would make every schema tweak require a full production
 *   environment.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./schema.ts",
  out: "./drizzle",
  dbCredentials: { url: Deno.env.get("DATABASE_URL") ?? "" },
});
