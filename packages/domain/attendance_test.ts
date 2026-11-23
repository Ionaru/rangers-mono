import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applySample,
  type AttendanceWindow,
  type Attendee,
  type AttendeeRow,
  type ChannelSample,
  closeOpenSpans,
  compareRsvpToTurnout,
  creditedMinutes,
  isCredited,
  reconstructSessions,
  rollUpMemberActivity,
  type SessionSpan,
  summariseOperation,
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

test("no sessions credits no minutes", () => {
  assert.deepStrictEqual(creditedMinutes([], WINDOW), 0);
});

test("a session inside the window credits its full length", () => {
  const spans = [span("2026-07-11T18:30:00Z", "2026-07-11T19:45:00Z")];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 75);
});

test("present throughout credits the whole window", () => {
  const spans = [span("2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z")];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 180);
});

test("a session straddling the window start is clamped to it", () => {
  // Joined 30 minutes early; only the in-window half counts.
  const spans = [span("2026-07-11T17:30:00Z", "2026-07-11T18:30:00Z")];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 30);
});

test("a session straddling the window end is clamped to it", () => {
  // Stayed for the debrief, past 23:00. Overtime is not attendance.
  const spans = [span("2026-07-11T20:30:00Z", "2026-07-11T21:45:00Z")];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 30);
});

test("a session entirely outside the window credits nothing", () => {
  const spans = [span("2026-07-11T21:30:00Z", "2026-07-11T22:00:00Z")];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 0);
});

test("a dangling session is closed at the window end", () => {
  const spans = [span("2026-07-11T20:00:00Z", null)];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 60);
});

test("rejoins are summed", () => {
  // Left for dinner, came back. 40 + 25 = 65.
  const spans = [
    span("2026-07-11T18:00:00Z", "2026-07-11T18:40:00Z"),
    span("2026-07-11T19:10:00Z", "2026-07-11T19:35:00Z"),
  ];
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 65);
});

test("credit is inclusive at exactly the threshold", () => {
  assert.strictEqual(isCredited(59), false);
  assert.ok(isCredited(60));
  assert.ok(isCredited(61));
});

test("several sessions summing to exactly the threshold are credited", () => {
  const spans = [
    span("2026-07-11T18:00:00Z", "2026-07-11T18:30:00Z"),
    span("2026-07-11T19:00:00Z", "2026-07-11T19:30:00Z"),
  ];
  const minutes = creditedMinutes(spans, WINDOW);
  assert.deepStrictEqual(minutes, 60);
  assert.ok(isCredited(minutes));
});

test("the threshold is configurable", () => {
  assert.ok(isCredited(30, 30));
  assert.strictEqual(isCredited(30, 31), false);
});

// ------------------------------------------------- sample-to-session reconstruction

function sample(at: string, ...present: string[]): ChannelSample {
  return {
    at: new Date(at),
    present: present.map((entry) => {
      const [uid, nickname] = entry.split("/");
      return { uid, nickname: nickname ?? uid };
    }),
  };
}

test("no samples reconstructs no sessions", () => {
  assert.deepStrictEqual(reconstructSessions([], WINDOW.end), []);
});

test("a join and a leave reconstruct one span", () => {
  const spans = reconstructSessions([
    sample("2026-07-11T18:00:00Z"),
    sample("2026-07-11T18:01:30Z", "uid-a"),
    sample("2026-07-11T18:03:00Z", "uid-a"),
    sample("2026-07-11T18:04:30Z"),
  ], WINDOW.end);

  assert.deepStrictEqual(spans.length, 1);
  assert.deepStrictEqual(spans[0].tsUid, "uid-a");
  assert.deepStrictEqual(spans[0].joinedAt, new Date("2026-07-11T18:01:30Z"));
  assert.deepStrictEqual(spans[0].leftAt, new Date("2026-07-11T18:04:30Z"));
});

test("present throughout is closed at the window end", () => {
  const spans = reconstructSessions([
    sample("2026-07-11T18:00:00Z", "uid-a"),
    sample("2026-07-11T20:00:00Z", "uid-a"),
  ], WINDOW.end);

  assert.deepStrictEqual(spans.length, 1);
  assert.deepStrictEqual(spans[0].joinedAt, WINDOW.start);
  assert.deepStrictEqual(spans[0].leftAt, WINDOW.end);
  // And the credit rule sees the whole window.
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 180);
});

test("a rejoin reconstructs two spans, not one", () => {
  const spans = reconstructSessions([
    sample("2026-07-11T18:00:00Z", "uid-a"),
    sample("2026-07-11T18:30:00Z"),
    sample("2026-07-11T19:00:00Z", "uid-a"),
    sample("2026-07-11T19:30:00Z"),
  ], WINDOW.end);

  assert.deepStrictEqual(spans.length, 2);
  assert.deepStrictEqual(spans[0].leftAt, new Date("2026-07-11T18:30:00Z"));
  assert.deepStrictEqual(spans[1].joinedAt, new Date("2026-07-11T19:00:00Z"));
  // 30 + 30, which is what the credit rule should see.
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 60);
});

test("several identities are tracked independently", () => {
  const spans = reconstructSessions([
    sample("2026-07-11T18:00:00Z", "uid-a", "uid-b"),
    sample("2026-07-11T19:00:00Z", "uid-b", "uid-c"),
    sample("2026-07-11T20:00:00Z", "uid-c"),
  ], WINDOW.end);

  const byUid = new Map(spans.map((s) => [s.tsUid, s]));
  assert.deepStrictEqual(spans.length, 3);
  assert.deepStrictEqual(byUid.get("uid-a")!.leftAt, new Date("2026-07-11T19:00:00Z"));
  assert.deepStrictEqual(byUid.get("uid-b")!.leftAt, new Date("2026-07-11T20:00:00Z"));
  assert.deepStrictEqual(byUid.get("uid-c")!.leftAt, WINDOW.end);
});

test("a rename keeps the span and reports the new nickname", () => {
  const first = applySample([], sample("2026-07-11T18:00:00Z", "uid-a/Alice"));
  assert.deepStrictEqual(first.opened.length, 1);
  assert.deepStrictEqual(first.renamed, []);

  const second = applySample(
    first.open,
    sample("2026-07-11T18:01:30Z", "uid-a/Alice [AFK]"),
  );
  assert.deepStrictEqual(second.opened, []);
  assert.deepStrictEqual(second.closed, []);
  // The rename carries the whole span, not just the new name: the worker needs
  // the row's own identity to update it (see SampleDiff).
  assert.deepStrictEqual(second.renamed.length, 1);
  assert.deepStrictEqual(second.renamed[0].tsUid, "uid-a");
  assert.deepStrictEqual(second.renamed[0].tsNickname, "Alice [AFK]");
  assert.deepStrictEqual(second.renamed[0].joinedAt, new Date("2026-07-11T18:00:00Z"));
  // The span survives: a rename is not a leave and a rejoin.
  assert.deepStrictEqual(second.open.length, 1);
  assert.deepStrictEqual(second.open[0].joinedAt, new Date("2026-07-11T18:00:00Z"));
  assert.deepStrictEqual(second.open[0].tsNickname, "Alice [AFK]");
});

test("an identity connected twice counts once", () => {
  // Same person, two clients, both in the channel. One span, not two, or their
  // minutes double.
  const spans = reconstructSessions([
    sample("2026-07-11T18:00:00Z", "uid-a/Desktop", "uid-a/Laptop"),
    sample("2026-07-11T19:00:00Z", "uid-a/Desktop"),
  ], WINDOW.end);

  assert.deepStrictEqual(spans.length, 1);
  assert.deepStrictEqual(creditedMinutes(spans, WINDOW), 180);
});

test("an empty sample closes everything that was open", () => {
  const opened = applySample([], sample("2026-07-11T18:00:00Z", "uid-a"));
  const emptied = applySample(opened.open, sample("2026-07-11T18:01:30Z"));

  assert.deepStrictEqual(emptied.closed.length, 1);
  assert.deepStrictEqual(emptied.open, []);
});

test("closeOpenSpans closes at the instant it is given", () => {
  const opened = applySample([], sample("2026-07-11T20:00:00Z", "uid-a"));
  // The restart path: close at the last sample actually taken, not at `now`.
  const closed = closeOpenSpans(opened.open, new Date("2026-07-11T20:10:00Z"));

  assert.deepStrictEqual(closed.length, 1);
  assert.deepStrictEqual(closed[0].leftAt, new Date("2026-07-11T20:10:00Z"));
  // 10 minutes, not the 60 a dangling span would have been credited.
  assert.deepStrictEqual(creditedMinutes(closed, WINDOW), 10);
});

// --------------------------------------------------------------- rollups for the views

function row(
  memberId: string | null,
  tsUid: string,
  joined: string,
  left: string | null,
): AttendeeRow {
  return {
    memberId,
    tsUid,
    tsNickname: tsUid,
    joinedAt: new Date(joined),
    leftAt: left === null ? null : new Date(left),
  };
}

test("an op with no rows summarises to zeroes", () => {
  const summary = summariseOperation([], WINDOW);
  assert.deepStrictEqual(summary.attendees, []);
  assert.deepStrictEqual(summary.credited, 0);
  assert.deepStrictEqual(summary.present, 0);
  assert.deepStrictEqual(summary.guests, 0);
});

test("a member's spans are summed into one attendee", () => {
  const summary = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T18:40:00Z"),
    row("m1", "uid-a", "2026-07-11T19:10:00Z", "2026-07-11T19:35:00Z"),
  ], WINDOW);

  assert.deepStrictEqual(summary.attendees.length, 1);
  assert.deepStrictEqual(summary.attendees[0].minutes, 65);
  assert.ok(summary.attendees[0].credited);
  assert.deepStrictEqual(summary.present, 1);
});

test("a member who re-linked is grouped by member, not by identity", () => {
  // Two TeamSpeak identities, one person. 40 + 30 = 70, over the threshold;
  // grouped per-identity they would be 40 and 30 and neither would be credited.
  const summary = summariseOperation([
    row("m1", "uid-old", "2026-07-11T18:00:00Z", "2026-07-11T18:40:00Z"),
    row("m1", "uid-new", "2026-07-11T19:00:00Z", "2026-07-11T19:30:00Z"),
  ], WINDOW);

  assert.deepStrictEqual(summary.attendees.length, 1);
  assert.deepStrictEqual(summary.attendees[0].minutes, 70);
  assert.ok(summary.attendees[0].credited);
});

test("guests stay separate per identity and are counted", () => {
  const summary = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
    row(null, "uid-g1", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
    row(null, "uid-g2", "2026-07-11T18:00:00Z", "2026-07-11T18:20:00Z"),
  ], WINDOW);

  assert.deepStrictEqual(summary.present, 3);
  assert.deepStrictEqual(summary.guests, 2);
  // The 20-minute guest is present but not credited.
  assert.deepStrictEqual(summary.credited, 2);
});

test("presence under the threshold is present but not credited", () => {
  const summary = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T18:30:00Z"),
  ], WINDOW);

  assert.deepStrictEqual(summary.present, 1);
  assert.deepStrictEqual(summary.credited, 0);
  assert.strictEqual(summary.attendees[0].credited, false);
});

test("summarising clamps to the window", () => {
  // Arrived an hour early and stayed an hour late; only the 180 in-window
  // minutes count.
  const summary = summariseOperation([
    row("m1", "uid-a", "2026-07-11T17:00:00Z", "2026-07-11T22:00:00Z"),
  ], WINDOW);

  assert.deepStrictEqual(summary.attendees[0].minutes, 180);
});

test("the credit threshold is honoured when summarising", () => {
  const rows = [
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T18:30:00Z"),
  ];
  assert.deepStrictEqual(summariseOperation(rows, WINDOW, 30).credited, 1);
  assert.deepStrictEqual(summariseOperation(rows, WINDOW, 31).credited, 0);
});

test("the RSVP comparison splits into its three buckets", () => {
  const attendees = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
    row("m3", "uid-c", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
  ], WINDOW).attendees;

  const comparison = compareRsvpToTurnout([
    { discordId: "d1", memberId: "m1", name: "Came as promised" },
    { discordId: "d2", memberId: "m2", name: "Said yes, no-showed" },
  ], attendees);

  assert.deepStrictEqual(comparison.respondedAndCame.map((r) => r.memberId), ["m1"]);
  assert.deepStrictEqual(comparison.respondedAndDidNot.map((r) => r.memberId), ["m2"]);
  assert.deepStrictEqual(
    comparison.cameWithoutResponding.map((a) => a.memberId),
    ["m3"],
  );
});

test("a responder who is not a member cannot be matched", () => {
  const attendees = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
  ], WINDOW).attendees;

  const comparison = compareRsvpToTurnout([
    { discordId: "d9", memberId: null, name: "Never logged in" },
  ], attendees);

  assert.deepStrictEqual(comparison.respondedAndCame, []);
  assert.deepStrictEqual(comparison.respondedAndDidNot.map((r) => r.discordId), ["d9"]);
});

test("a guest always counts as having turned up without responding", () => {
  const attendees = summariseOperation([
    row(null, "uid-g", "2026-07-11T18:00:00Z", "2026-07-11T21:00:00Z"),
  ], WINDOW).attendees;

  const comparison = compareRsvpToTurnout([], attendees);
  assert.deepStrictEqual(comparison.cameWithoutResponding.map((a) => a.tsUid), ["uid-g"]);
});

test("turning up at all counts, even under the credit threshold", () => {
  // 20 minutes: not credited, but they did answer their RSVP.
  const attendees = summariseOperation([
    row("m1", "uid-a", "2026-07-11T18:00:00Z", "2026-07-11T18:20:00Z"),
  ], WINDOW).attendees;

  const comparison = compareRsvpToTurnout([
    { discordId: "d1", memberId: "m1", name: "Dropped in" },
  ], attendees);

  assert.strictEqual(attendees[0].credited, false);
  assert.deepStrictEqual(comparison.respondedAndCame.map((r) => r.memberId), ["m1"]);
  assert.deepStrictEqual(comparison.respondedAndDidNot, []);
});

test("member activity totals credited and attended ops separately", () => {
  const full = (memberId: string): Attendee => ({
    memberId,
    tsUid: `uid-${memberId}`,
    tsNickname: memberId,
    minutes: 180,
    credited: true,
  });
  const brief = (memberId: string): Attendee => ({
    memberId,
    tsUid: `uid-${memberId}`,
    tsNickname: memberId,
    minutes: 20,
    credited: false,
  });

  const activity = rollUpMemberActivity([
    { date: "2026-07-04", attendees: [full("m1"), full("m2")] },
    { date: "2026-07-11", attendees: [full("m1"), brief("m2")] },
    { date: "2026-07-18", attendees: [full("m1")] },
  ]);

  const byMember = new Map(activity.map((a) => [a.memberId, a]));
  assert.deepStrictEqual(byMember.get("m1")!.creditedOps, 3);
  assert.deepStrictEqual(byMember.get("m1")!.attendedOps, 3);
  assert.deepStrictEqual(byMember.get("m1")!.lastAttended, "2026-07-18");
  assert.deepStrictEqual(byMember.get("m2")!.creditedOps, 1);
  assert.deepStrictEqual(byMember.get("m2")!.attendedOps, 2);
  assert.deepStrictEqual(byMember.get("m2")!.lastAttended, "2026-07-11");
  // Sorted by credited ops, descending.
  assert.deepStrictEqual(activity.map((a) => a.memberId), ["m1", "m2"]);
});

test("member activity ignores guests", () => {
  const guest: Attendee = {
    memberId: null,
    tsUid: "uid-g",
    tsNickname: "Someone",
    minutes: 180,
    credited: true,
  };
  assert.deepStrictEqual(
    rollUpMemberActivity([{ date: "2026-07-11", attendees: [guest] }]),
    [],
  );
});

test("a member absent from every op does not appear at all", () => {
  // Absence is the lack of a row, so the roster page joins this onto the member
  // list rather than expecting a zero entry here.
  assert.deepStrictEqual(
    rollUpMemberActivity([{ date: "2026-07-11", attendees: [] }]),
    [],
  );
});
