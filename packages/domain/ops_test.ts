import { assertEquals } from "@std/assert";
import {
  type OpScheduleConfig,
  opTitle,
  pickRandom,
  planWeeklyOp,
  splitMessages,
  utcToZonedParts,
  zonedWallClockToUtc,
} from "./ops.ts";

const TZ = "Europe/Amsterdam";

const CONFIG: OpScheduleConfig = {
  timeZone: TZ,
  attendanceStart: "20:00",
  attendanceEnd: "23:00",
  eventEnd: "23:30",
  announceWeekday: 3, // Wednesday
  announceTime: "18:00",
  prepLeadDays: 1, // Tuesday 18:00: the mission makers' day with the event
};

/** The lead switched off: prep and announce collapse onto the same moment. */
const NO_PREP: OpScheduleConfig = { ...CONFIG, prepLeadDays: 0 };

// A concrete summer week: the op is Saturday 2026-07-25. CEST is UTC+2, so the
// 20:00 wall clock is 18:00Z, and 18:00 local is 16:00Z on Wednesday (announce)
// and on Tuesday (prep) alike.
// A concrete winter week: the op is Saturday 2026-01-24. CET is UTC+1, so 20:00
// local is 19:00Z and 18:00 local is 17:00Z, on Wednesday and Tuesday alike.

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
  assertEquals(plan.prepareAt, new Date("2026-07-21T16:00:00Z"));
  assertEquals(plan.announceAt, new Date("2026-07-22T16:00:00Z"));
  assertEquals(plan.withinWindow, true);
  assertEquals(plan.withinAnnounceWindow, true);
});

Deno.test("planWeeklyOp computes the winter op's instants DST-correct", () => {
  // Thursday 2026-01-22 09:00 local = 08:00Z.
  const plan = planWeeklyOp(new Date("2026-01-22T08:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-01-24");
  assertEquals(plan.attendanceStart, new Date("2026-01-24T19:00:00Z"));
  assertEquals(plan.attendanceEnd, new Date("2026-01-24T22:00:00Z"));
  assertEquals(plan.eventEnd, new Date("2026-01-24T22:30:00Z"));
  assertEquals(plan.prepareAt, new Date("2026-01-20T17:00:00Z"));
  assertEquals(plan.announceAt, new Date("2026-01-21T17:00:00Z"));
  assertEquals(plan.withinWindow, true);
  assertEquals(plan.withinAnnounceWindow, true);
});

Deno.test("planWeeklyOp: Sunday before the op is out of the window", () => {
  // Sunday 2026-07-19 12:00 local = 10:00Z. Coming Saturday is 2026-07-25,
  // but Tuesday's prep moment is still days away.
  const plan = planWeeklyOp(new Date("2026-07-19T10:00:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, false);
  assertEquals(plan.withinAnnounceWindow, false);
});

Deno.test("planWeeklyOp: Tuesday just before 18:00 has not opened yet", () => {
  // Tuesday 2026-07-21 17:00 local = 15:00Z, one hour before prepareAt (16:00Z).
  const plan = planWeeklyOp(new Date("2026-07-21T15:00:00Z"), CONFIG);
  assertEquals(plan.withinWindow, false);
  assertEquals(plan.withinAnnounceWindow, false);
});

Deno.test("planWeeklyOp: Tuesday at 18:30 opens the prep window, not the announcement", () => {
  // Tuesday 2026-07-21 18:30 local = 16:30Z, past prepareAt (16:00Z) and a day
  // short of announceAt (Wednesday 16:00Z). This is the whole point of the lead:
  // the event gets created and the mission makers pinged, and the guild does not.
  const plan = planWeeklyOp(new Date("2026-07-21T16:30:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, true);
  assertEquals(plan.withinAnnounceWindow, false);
});

Deno.test("planWeeklyOp: Wednesday just before 18:00 still holds the announcement back", () => {
  // Wednesday 2026-07-22 17:00 local = 15:00Z, one hour before announceAt: the
  // last tick of the mission makers' window.
  const plan = planWeeklyOp(new Date("2026-07-22T15:00:00Z"), CONFIG);
  assertEquals(plan.withinWindow, true);
  assertEquals(plan.withinAnnounceWindow, false);
});

Deno.test("planWeeklyOp: Wednesday at 18:30 has opened", () => {
  // Wednesday 2026-07-22 18:30 local = 16:30Z, past announceAt (16:00Z).
  const plan = planWeeklyOp(new Date("2026-07-22T16:30:00Z"), CONFIG);
  assertEquals(plan.saturdayDate, "2026-07-25");
  assertEquals(plan.withinWindow, true);
  assertEquals(plan.withinAnnounceWindow, true);
});

Deno.test("planWeeklyOp: no lead collapses prep onto the announce moment", () => {
  // Tuesday 2026-07-21 18:30 local: inside the prep window with a lead, outside
  // every window without one. This is what an unset OP_PREP_CHANNEL_ID buys: the
  // behaviour that shipped first, unchanged.
  const plan = planWeeklyOp(new Date("2026-07-21T16:30:00Z"), NO_PREP);
  assertEquals(plan.prepareAt, plan.announceAt);
  assertEquals(plan.withinWindow, false);
  assertEquals(plan.withinAnnounceWindow, false);
});

Deno.test("planWeeklyOp: the lead is a calendar day at the same wall clock, not 24 hours", () => {
  // The one week where the difference is visible: Europe/Amsterdam springs forward
  // on Sunday 2026-03-29, so with a Sunday announce weekday the prep moment
  // (Saturday 18:00 CET = 17:00Z) and the announce moment (Sunday 18:00 CEST =
  // 16:00Z) are 23 hours apart, not 24. Both must still read 18:00 locally; a lead
  // subtracted in fixed hours would put the prep ping out at 19:00 local.
  const sundayAnnounce: OpScheduleConfig = { ...CONFIG, announceWeekday: 0 };
  const plan = planWeeklyOp(new Date("2026-03-30T10:00:00Z"), sundayAnnounce);
  assertEquals(plan.saturdayDate, "2026-04-04");
  assertEquals(plan.prepareAt, new Date("2026-03-28T17:00:00Z"));
  assertEquals(plan.announceAt, new Date("2026-03-29T16:00:00Z"));
  assertEquals(plan.attendanceStart, new Date("2026-04-04T18:00:00Z"));
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

// ---------------------------------------------------------------- splitMessages

Deno.test("splitMessages splits on blank lines and keeps single lines intact", () => {
  assertEquals(
    splitMessages("first message\n\nsecond message\n\nthird"),
    ["first message", "second message", "third"],
  );
});

Deno.test("splitMessages keeps line breaks WITHIN a message", () => {
  const text = "line one\nline two\n\nsecond message";
  assertEquals(splitMessages(text), ["line one\nline two", "second message"]);
});

Deno.test("splitMessages collapses runs of blank lines and trims", () => {
  const text = "\n\n  a\n\n\n\n  b  \n\n";
  assertEquals(splitMessages(text), ["a", "b"]);
});

Deno.test("splitMessages is CRLF-safe (Windows box), normalizing breaks to LF", () => {
  const text = "a line\r\nand more\r\n \t \r\nnext one";
  assertEquals(splitMessages(text), ["a line\nand more", "next one"]);
});

Deno.test("splitMessages returns [] for empty or whitespace-only input", () => {
  assertEquals(splitMessages(""), []);
  assertEquals(splitMessages("\n\n   \n"), []);
});
