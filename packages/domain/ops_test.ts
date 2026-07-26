import { assertEquals } from "@std/assert";
import {
  type OpScheduleConfig,
  opTitle,
  pickRandom,
  planWeeklyOp,
  utcToZonedParts,
  zonedWallClockToUtc,
} from "./ops.ts";

const TZ = "Europe/Amsterdam";

const CONFIG: OpScheduleConfig = {
  timeZone: TZ,
  opStart: "20:00",
  attendanceEnd: "23:00",
  eventEnd: "23:30",
  announceWeekday: 3, // Wednesday
  announceTime: "18:00",
};

// A concrete summer week: the op is Saturday 2026-07-25. CEST is UTC+2, so the
// 20:00 wall clock is 18:00Z, and Wednesday 18:00 local is 16:00Z.
// A concrete winter week: the op is Saturday 2026-01-24. CET is UTC+1, so 20:00
// local is 19:00Z, and Wednesday 18:00 local is 17:00Z.

// ---------------------------------------------------------------- local <-> UTC

Deno.test("utcToZonedParts reads summer wall clock (CEST = UTC+2)", () => {
  const p = utcToZonedParts(new Date("2026-07-25T18:00:00Z"), TZ);
  assertEquals(
    {
      y: p.year,
      mo: p.month,
      d: p.day,
      h: p.hour,
      mi: p.minute,
      wd: p.weekday,
    },
    { y: 2026, mo: 7, d: 25, h: 20, mi: 0, wd: 6 },
  );
});

Deno.test("utcToZonedParts reads winter wall clock (CET = UTC+1)", () => {
  const p = utcToZonedParts(new Date("2026-01-24T19:00:00Z"), TZ);
  assertEquals({ h: p.hour, mi: p.minute, wd: p.weekday }, {
    h: 20,
    mi: 0,
    wd: 6,
  });
});

Deno.test("zonedWallClockToUtc inverts, in both seasons", () => {
  assertEquals(
    zonedWallClockToUtc(
      { year: 2026, month: 7, day: 25, hour: 20, minute: 0 },
      TZ,
    ),
    new Date("2026-07-25T18:00:00Z"),
  );
  assertEquals(
    zonedWallClockToUtc(
      { year: 2026, month: 1, day: 24, hour: 20, minute: 0 },
      TZ,
    ),
    new Date("2026-01-24T19:00:00Z"),
  );
});

Deno.test("zonedWallClockToUtc is correct on both sides of the spring DST jump", () => {
  // Europe springs forward at 02:00 CET -> 03:00 CEST on 2026-03-29.
  // 01:30 local is still CET (UTC+1); 03:30 local is CEST (UTC+2).
  assertEquals(
    zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 1, minute: 30 },
      TZ,
    ),
    new Date("2026-03-29T00:30:00Z"),
  );
  assertEquals(
    zonedWallClockToUtc(
      { year: 2026, month: 3, day: 29, hour: 3, minute: 30 },
      TZ,
    ),
    new Date("2026-03-29T01:30:00Z"),
  );
});

// ---------------------------------------------------------------- planWeeklyOp

Deno.test("planWeeklyOp computes the summer op's instants DST-correct", () => {
  // Thursday of the op week, well inside the window.
  const plan = planWeeklyOp(new Date("2026-07-23T07:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.attendanceStart, new Date("2026-07-25T18:00:00Z"));
  assertEquals(plan.attendanceEnd, new Date("2026-07-25T21:00:00Z"));
  assertEquals(plan.eventEnd, new Date("2026-07-25T21:30:00Z"));
  assertEquals(plan.announceAt, new Date("2026-07-22T16:00:00Z"));
  assertEquals(plan.withinWindow, true);
});

Deno.test("planWeeklyOp computes the winter op's instants DST-correct", () => {
  // Thursday 2026-01-22 09:00 local = 08:00Z.
  const plan = planWeeklyOp(new Date("2026-01-22T08:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-01-24");
  assertEquals(plan.attendanceStart, new Date("2026-01-24T19:00:00Z"));
  assertEquals(plan.attendanceEnd, new Date("2026-01-24T22:00:00Z"));
  assertEquals(plan.eventEnd, new Date("2026-01-24T22:30:00Z"));
  assertEquals(plan.announceAt, new Date("2026-01-21T17:00:00Z"));
  assertEquals(plan.withinWindow, true);
});

Deno.test("planWeeklyOp: Sunday before the op is out of the window", () => {
  // Sunday 2026-07-19 12:00 local = 10:00Z. Coming Saturday is 2026-07-25,
  // but Wednesday's announce moment is still days away.
  const plan = planWeeklyOp(new Date("2026-07-19T10:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, false);
});

Deno.test("planWeeklyOp: Wednesday just before 18:00 has not opened yet", () => {
  // Wednesday 2026-07-22 17:00 local = 15:00Z, one hour before announceAt.
  const plan = planWeeklyOp(new Date("2026-07-22T15:00:00Z"), CONFIG);
  assertEquals(plan.withinWindow, false);
});

Deno.test("planWeeklyOp: Wednesday at 18:30 has opened", () => {
  // Wednesday 2026-07-22 18:30 local = 16:30Z, past announceAt (16:00Z).
  const plan = planWeeklyOp(new Date("2026-07-22T16:30:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, true);
});

Deno.test("planWeeklyOp: Saturday before the op starts still opens (late catch-up)", () => {
  // Saturday 2026-07-25 19:00 local = 17:00Z, an hour before the 20:00 op start.
  const plan = planWeeklyOp(new Date("2026-07-25T17:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, true);
});

Deno.test("planWeeklyOp: once the op has started, the window is shut", () => {
  // Saturday 2026-07-25 20:30 local = 18:30Z: the op is underway (past 20:00) but
  // before the 23:30 event end. The event's start is now in the past, so Discord
  // could not create it; withinWindow must be false, not true.
  const plan = planWeeklyOp(new Date("2026-07-25T18:30:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, false);
});

Deno.test("planWeeklyOp: after the event ends, the window is still shut", () => {
  // Saturday 2026-07-25 23:45 local = 21:45Z, past the 21:30Z event end.
  const plan = planWeeklyOp(new Date("2026-07-25T21:45:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, false);
});

Deno.test("planWeeklyOp: after midnight the target rolls to next Saturday", () => {
  // Sunday 2026-07-26 01:00 local = 2026-07-25T23:00Z.
  const plan = planWeeklyOp(new Date("2026-07-25T23:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-08-01");
  assertEquals(plan.withinWindow, false);
});

// ---------------------------------------------------------------- opTitle

Deno.test("opTitle labels the summer op CEST", () => {
  assertEquals(
    opTitle(new Date("2026-07-25T18:00:00Z"), TZ),
    "20:00 CEST - Saturday Operation",
  );
});

Deno.test("opTitle labels the winter op CET", () => {
  assertEquals(
    opTitle(new Date("2026-01-24T19:00:00Z"), TZ),
    "20:00 CET - Saturday Operation",
  );
});

// ---------------------------------------------------------------- pickRandom

Deno.test("pickRandom returns undefined for an empty list", () => {
  assertEquals(pickRandom([], () => 0), undefined);
});

Deno.test("pickRandom indexes by the injected rng", () => {
  const items = ["a", "b", "c"];
  assertEquals(pickRandom(items, () => 0), "a");
  assertEquals(pickRandom(items, () => 0.5), "b");
  assertEquals(pickRandom(items, () => 0.99), "c");
});
