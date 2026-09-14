import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "@std/assert";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { isUniqueViolation } from "./queries.ts";
import { attendanceSession, operation, operationRsvp } from "./schema.ts";

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

/**
 * The two attendance statements that are not plain Drizzle, rendered to SQL.
 *
 * There is no database in the test suite and there is not going to be one
 * (ARCHITECTURE §9), but rendering is not querying: `toSQL()` is pure, and a
 * `postgres.js` client does not dial anything until a query actually runs. So
 * the two statements whose shape could silently be wrong are checked here.
 *
 * They earn it. `closeDanglingSessions` is an `UPDATE ... FROM`, which is the
 * one statement in the file that reads a *second* table's column while writing
 * the first, and getting it wrong would stamp the wrong instant onto every
 * dangling span. The RSVP upsert has to land on the composite unique index, and
 * a conflict target that does not match an index is a runtime error Postgres
 * only raises when a row actually collides, which is to say on the second
 * refresh of the first real op.
 */
const renderDb = drizzle({ client: postgres("postgres://u:p@127.0.0.1:1/x") });

Deno.test("closing dangling spans reads the op's own window end", () => {
  const { sql: rendered } = renderDb
    .update(attendanceSession)
    .set({ leftAt: sql`${operation.attendanceEnd}` })
    .from(operation)
    .where(
      and(
        eq(attendanceSession.operationId, operation.id),
        isNull(attendanceSession.leftAt),
        lt(operation.attendanceEnd, new Date()),
      ),
    )
    .returning({ id: attendanceSession.id })
    .toSQL();

  // left_at takes the OP's attendance_end, not `now()` and not a bound
  // parameter: that is what stops a worker that woke up on Sunday crediting
  // everybody until Sunday.
  assertStringIncludes(
    rendered,
    `set "left_at" = "operation"."attendance_end"`,
  );
  assertStringIncludes(rendered, `from "operation"`);
  assertStringIncludes(rendered, `"attendance_session"."left_at" is null`);
});

Deno.test("the RSVP upsert conflicts on the op-and-person unique index", () => {
  const now = new Date();
  const { sql: rendered } = renderDb
    .insert(operationRsvp)
    .values([{
      operationId: "op",
      discordId: "d1",
      username: "u",
      firstSeenAt: now,
      lastSeenAt: now,
    }])
    .onConflictDoUpdate({
      target: [operationRsvp.operationId, operationRsvp.discordId],
      set: { lastSeenAt: now, username: sql`excluded.username` },
    })
    .toSQL();

  assertStringIncludes(rendered, `on conflict ("operation_id","discord_id")`);
  // first_seen_at is NOT in the update set: a re-read must not reset when we
  // first saw somebody on the list.
  assertStringIncludes(rendered, `do update set`);
  assertEquals(rendered.includes(`do update set "first_seen_at"`), false);
  assertEquals(
    rendered.slice(rendered.indexOf("do update set")).includes("first_seen_at"),
    false,
  );
});
