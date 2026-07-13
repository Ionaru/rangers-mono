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
  // Two files, one migration history. auth-schema.ts holds Better Auth's tables,
  // which we do not own the shape of; keeping them out of schema.ts keeps the
  // diff confined when Better Auth changes them. They still have to be listed
  // here, or drizzle-kit would not see them, CI's drift gate would pass, and the
  // tables would simply never be created.
  schema: ["./schema.ts", "./auth-schema.ts"],
  // Relative on purpose: 1.0's snapshot validator reads `./${path}`, so an
  // absolute path here becomes `./absolute/path` and nothing is found.
  out: "./drizzle",
  dbCredentials: { url: Deno.env.get("DATABASE_URL") ?? "" },
});
