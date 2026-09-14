import { getAttendanceCreditConfig } from "@7r/config";
import {
  type AttendanceRow,
  getDb,
  listAttendanceForMember,
  listAttendanceForOperations,
  listRecentOperations,
  listRosterMembers,
  listRsvpOperationsForDiscordId,
  listRsvpsForOperations,
  type Operation,
  type RosterMember,
  type RsvpRow,
} from "@7r/db";
import {
  type Attendee,
  compareRsvpToTurnout,
  type MemberActivity,
  type OperationSummary,
  rollUpMemberActivity,
  type RsvpEntry,
  summariseOperation,
  type TurnoutComparison,
} from "@7r/domain";

/**
 * How many ops back the read-only views look by default: about a quarter of
 * Saturdays.
 *
 * A constant here rather than config: it is a display window, and putting it in
 * the environment would mean a deploy to answer "what about the last six
 * months?" (the attendance page takes `?ops=N` instead). Here rather than in
 * `@7r/domain`, too: that package is types and pure rules, and how many rows a
 * page shows is neither.
 */
export const DEFAULT_ATTENDANCE_RECENT_OPS = 12;

/**
 * Everything the two read-only attendance views render, loaded once and rolled
 * up by the pure functions in `@7r/domain`.
 *
 * The rules live in the domain package and the SQL lives in `@7r/db`; this is
 * only the join between them. In particular the credit rule is applied in
 * exactly one place (`summariseOperation`), so the profile card and the
 * unit-wide view can never disagree about who was credited for an op.
 *
 * Attendance is a statistic and nothing else (ADR 0010). Nothing here decides
 * anything; it renders numbers.
 */

/** One op, with its turnout and its RSVP cross-tab already computed. */
export interface OperationView {
  id: string;
  date: string;
  summary: OperationSummary;
  rsvp: TurnoutComparison;
  /**
   * Whether the sampler ever recorded a sample for this op.
   *
   * Shown, not hidden. An op with no samples is indistinguishable from an op
   * nobody attended, and ADR 0007 accepts that nobody will notice quickly if
   * sampling silently stops, so the one place that *can* say so should.
   */
  sampled: boolean;
}

export interface AttendanceOverview {
  /** Newest first. */
  operations: OperationView[];
  /** Per-member totals across `operations`, best-attended first. */
  activity: MemberActivity[];
  roster: RosterMember[];
  /** memberId -> display name, for everything the rollups return by id. */
  names: Map<string, string>;
  minMinutes: number;
}

/** The name to show for one attendee: the member's, or the bare TeamSpeak nickname. */
export function attendeeName(
  attendee: Attendee,
  names: Map<string, string>,
): string {
  if (attendee.memberId !== null) {
    return names.get(attendee.memberId) ?? "(unknown member)";
  }
  return attendee.tsNickname ?? attendee.tsUid;
}

function toRsvpEntry(row: RsvpRow): RsvpEntry {
  return {
    discordId: row.discordId,
    memberId: row.memberId,
    // A member's current display name beats the snapshot taken during the op:
    // the snapshot is only there for responders who are not members at all.
    name: row.displayName ?? row.username ?? row.discordId,
  };
}

function groupBy<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const existing = grouped.get(key(row));
    if (existing) existing.push(row);
    else grouped.set(key(row), [row]);
  }
  return grouped;
}

/**
 * Load and roll up the last `limit` ops.
 *
 * Three queries whatever the span: the ops, every session across them, and every
 * captured RSVP across them. A year of Saturdays at this unit's size is a few
 * hundred rows, which is why the window clamping and the credit rule are folded
 * in TypeScript rather than expressed in SQL: one rule, in one place, tested.
 */
export async function loadAttendanceOverview(
  limit: number = DEFAULT_ATTENDANCE_RECENT_OPS,
): Promise<AttendanceOverview> {
  const db = getDb();
  const { ATTENDANCE_MIN_MINUTES } = getAttendanceCreditConfig();

  // The roster needs nothing from the ops, so it does not wait behind them.
  const [operations, roster]: [Operation[], RosterMember[]] = await Promise.all(
    [
      listRecentOperations(db, limit),
      listRosterMembers(db),
    ],
  );
  const ids = operations.map((op) => op.id);

  const [sessions, rsvps] = await Promise.all([
    listAttendanceForOperations(db, ids),
    listRsvpsForOperations(db, ids),
  ]);

  const names = new Map<string, string>(
    roster.map((member) => [member.id, member.displayName]),
  );

  const sessionsByOp = groupBy(
    sessions,
    (row: AttendanceRow) => row.operationId,
  );
  const rsvpsByOp = groupBy(rsvps, (row: RsvpRow) => row.operationId);

  const views: OperationView[] = operations.map((op) => {
    const summary = summariseOperation(
      sessionsByOp.get(op.id) ?? [],
      { start: op.attendanceStart, end: op.attendanceEnd },
      ATTENDANCE_MIN_MINUTES,
    );
    return {
      id: op.id,
      date: op.date,
      summary,
      rsvp: compareRsvpToTurnout(
        (rsvpsByOp.get(op.id) ?? []).map(toRsvpEntry),
        summary.attendees,
      ),
      sampled: op.lastSampleAt !== null,
    };
  });

  return {
    operations: views,
    activity: rollUpMemberActivity(
      views.map((view) => ({
        date: view.date,
        attendees: view.summary.attendees,
      })),
    ),
    roster,
    names,
    minMinutes: ATTENDANCE_MIN_MINUTES,
  };
}

/** One op as it appears on a member's own profile. */
export interface MemberOperationView {
  date: string;
  minutes: number;
  credited: boolean;
  /** Whether they were on the event's Interested list while the op ran. */
  responded: boolean;
  sampled: boolean;
}

export interface MemberAttendance {
  operations: MemberOperationView[];
  creditedOps: number;
  attendedOps: number;
  consideredOps: number;
  lastAttended: string | null;
  minMinutes: number;
}

/**
 * One member's own attendance, for `/me`.
 *
 * Two narrow, indexed lookups rather than the unit-wide overview: this is the
 * most-visited page in the app, and loading every member's sessions, every
 * captured RSVP and the whole roster to render twelve rows would make the
 * busiest page the most expensive one.
 *
 * The credit rule is still applied in exactly one place. `summariseOperation`
 * does the window clamp and the threshold here as it does for the unit-wide
 * view, so a profile and the roster can never disagree about an op; only the
 * rows fed to it are narrowed.
 */
export async function loadMemberAttendance(
  memberId: string,
  discordId: string,
  limit: number = DEFAULT_ATTENDANCE_RECENT_OPS,
): Promise<MemberAttendance> {
  const db = getDb();
  const { ATTENDANCE_MIN_MINUTES } = getAttendanceCreditConfig();

  const operations = await listRecentOperations(db, limit);
  const ids = operations.map((op) => op.id);

  const [sessions, respondedTo] = await Promise.all([
    listAttendanceForMember(db, memberId, ids),
    listRsvpOperationsForDiscordId(db, discordId, ids),
  ]);

  const sessionsByOp = groupBy(
    sessions,
    (row: AttendanceRow) => row.operationId,
  );
  const responded = new Set(respondedTo);

  let creditedOps = 0;
  let attendedOps = 0;
  let lastAttended: string | null = null;

  const views: MemberOperationView[] = operations.map((op) => {
    const { attendees } = summariseOperation(
      sessionsByOp.get(op.id) ?? [],
      { start: op.attendanceStart, end: op.attendanceEnd },
      ATTENDANCE_MIN_MINUTES,
    );
    const mine = attendees[0];
    if (mine) {
      attendedOps += 1;
      if (mine.credited) creditedOps += 1;
      // Newest first, so the first one seen is the most recent.
      lastAttended ??= op.date;
    }
    return {
      date: op.date,
      minutes: mine?.minutes ?? 0,
      credited: mine?.credited ?? false,
      responded: responded.has(op.id),
      sampled: op.lastSampleAt !== null,
    };
  });

  return {
    operations: views,
    creditedOps,
    attendedOps,
    consideredOps: operations.length,
    lastAttended,
    minMinutes: ATTENDANCE_MIN_MINUTES,
  };
}
