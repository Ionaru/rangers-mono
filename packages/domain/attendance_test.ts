import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type AttendanceWindow,
  creditedMinutes,
  isCredited,
  type SessionSpan,
} from "./attendance.ts";

// 20:00-23:00 Europe/Amsterdam on a Saturday, in UTC (CEST = UTC+2).
const WINDOW: AttendanceWindow = {
  start: new Date("2026-07-11T18:00:00Z"),
  end: new Date("2026-07-11T21:00:00Z"),
};

function span(joined: string, left: string | null): SessionSpan {
  return {
    joinedAt: new Date(joined),
    leftAt: left === null ? null : new Date(left),
  };
}

Deno.test("no sessions credits no minutes", () => {
  assertEquals(creditedMinutes([], WINDOW), 0);
});

Deno.test("a session inside the window credits its full length", () => {
  const spans = [span("2026-07-11T18:30:00Z", "2026-07-11T19:45:00Z")];
  assertEquals(creditedMinutes(spans, WINDOW), 75);
});

Deno.test("present throughout credits the whole window", () => {
  const spans = [span("2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z")];
  assertEquals(creditedMinutes(spans, WINDOW), 180);
});

Deno.test("a session straddling the window start is clamped to it", () => {
  // Joined 30 minutes early; only the in-window half counts.
  const spans = [span("2026-07-11T17:30:00Z", "2026-07-11T18:30:00Z")];
  assertEquals(creditedMinutes(spans, WINDOW), 30);
});

Deno.test("a session straddling the window end is clamped to it", () => {
  // Stayed for the debrief, past 23:00. Overtime is not attendance.
  const spans = [span("2026-07-11T20:30:00Z", "2026-07-11T21:45:00Z")];
  assertEquals(creditedMinutes(spans, WINDOW), 30);
});

Deno.test("a session entirely outside the window credits nothing", () => {
  const spans = [span("2026-07-11T21:30:00Z", "2026-07-11T22:00:00Z")];
  assertEquals(creditedMinutes(spans, WINDOW), 0);
});

Deno.test("a dangling session is closed at the window end", () => {
  const spans = [span("2026-07-11T20:00:00Z", null)];
  assertEquals(creditedMinutes(spans, WINDOW), 60);
});

Deno.test("rejoins are summed", () => {
  // Left for dinner, came back. 40 + 25 = 65.
  const spans = [
    span("2026-07-11T18:00:00Z", "2026-07-11T18:40:00Z"),
    span("2026-07-11T19:10:00Z", "2026-07-11T19:35:00Z"),
  ];
  assertEquals(creditedMinutes(spans, WINDOW), 65);
});

Deno.test("credit is inclusive at exactly the threshold", () => {
  assertFalse(isCredited(59));
  assert(isCredited(60));
  assert(isCredited(61));
});

Deno.test("several sessions summing to exactly the threshold are credited", () => {
  const spans = [
    span("2026-07-11T18:00:00Z", "2026-07-11T18:30:00Z"),
    span("2026-07-11T19:00:00Z", "2026-07-11T19:30:00Z"),
  ];
  const minutes = creditedMinutes(spans, WINDOW);
  assertEquals(minutes, 60);
  assert(isCredited(minutes));
});

Deno.test("the threshold is configurable", () => {
  assert(isCredited(30, 30));
  assertFalse(isCredited(30, 31));
});
