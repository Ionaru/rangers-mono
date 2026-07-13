import { assert, assertFalse } from "@std/assert";
import { isUniqueViolation } from "./queries.ts";

/**
 * Drizzle 1.0 wraps every driver error in a `DrizzleQueryError`, so the Postgres
 * SQLSTATE that used to sit on the error itself now sits on its `cause`. A check
 * that only looks at the top level still compiles, still passes review, and
 * quietly turns "somebody else linked that identity first" (a thing we handle
 * and explain) into a 500 (a thing we do not).
 *
 * It cost a real 500 in local testing to find. This is the test that stops it
 * coming back.
 */

/** What Drizzle 1.0 + postgres.js actually throw. Shape confirmed against a live database. */
function drizzleWrapped(pgCode: string): Error {
  const pg = Object.assign(
    new Error("duplicate key value violates unique constraint"),
    {
      name: "PostgresError",
      code: pgCode,
      constraint_name: "member_ts_uid_unique",
    },
  );
  return Object.assign(new Error("Failed query"), {
    name: "DrizzleQueryError",
    cause: pg,
  });
}

Deno.test("a unique violation is recognised through Drizzle 1.0's wrapper", () => {
  assert(isUniqueViolation(drizzleWrapped("23505")));
});

Deno.test("a unique violation is still recognised when it is not wrapped", () => {
  // Belt and braces: the driver may hand it over bare, and 0.45 used to.
  assert(
    isUniqueViolation(Object.assign(new Error("dupe"), { code: "23505" })),
  );
});

Deno.test("some other database error is not mistaken for a unique violation", () => {
  // 23503 is a foreign-key violation, and swallowing it as "already linked"
  // would hide a real bug behind a friendly message.
  assertFalse(isUniqueViolation(drizzleWrapped("23503")));
  assertFalse(isUniqueViolation(new Error("connection refused")));
  assertFalse(isUniqueViolation(null));
  assertFalse(isUniqueViolation(undefined));
  assertFalse(isUniqueViolation("23505"));
});

Deno.test("a cause chain that loops does not hang", () => {
  const looped = new Error("a") as Error & { cause?: unknown };
  looped.cause = looped;
  // Guards against the obvious naive `while (e.cause)` walk.
  assertFalse(isUniqueViolation(looped));
});
