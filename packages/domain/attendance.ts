/**
 * Attendance is a statistic and nothing else (ADR 0010). It gates no promotion
 * and triggers no removal. It shows on a member's own profile and in a
 * read-only site view. That is the whole feature.
 */

/** The window an Operation's attendance is measured over (20:00-23:00 local). */
export interface AttendanceWindow {
  start: Date;
  end: Date;
}

/** One continuous presence span in the Operations channel. */
export interface SessionSpan {
  joinedAt: Date;
  /** null = still open. A session open at the window's end is closed there. */
  leftAt: Date | null;
}

const MS_PER_MINUTE = 60_000;

/**
 * Minutes of a single span that fall inside the window, clamped to it.
 * Never negative: a span entirely outside the window contributes nothing.
 */
function overlapMinutes(span: SessionSpan, window: AttendanceWindow): number {
  const joined = Math.max(span.joinedAt.getTime(), window.start.getTime());
  const left = Math.min(
    (span.leftAt ?? window.end).getTime(),
    window.end.getTime(),
  );
  return Math.max(0, (left - joined) / MS_PER_MINUTE);
}

/**
 * Total in-window minutes across a member's spans for one Operation.
 *
 * Spans are summed, not merged. A TeamSpeak identity is in exactly one channel
 * at a time, so its spans cannot overlap; if they ever do, that is a bug in the
 * reconstruction (Phase 6) and should be fixed there rather than papered over
 * here.
 */
export function creditedMinutes(
  spans: readonly SessionSpan[],
  window: AttendanceWindow,
): number {
  return spans.reduce((total, span) => total + overlapMinutes(span, window), 0);
}

/**
 * The credit threshold (CONTEXT.md: "at least 60 minutes"). The only home for
 * the number: `packages/config` imports it as the default for the
 * ATTENDANCE_MIN_MINUTES override, rather than repeating the literal.
 */
export const DEFAULT_ATTENDANCE_MIN_MINUTES = 60;

/** A member is credited for an op if their in-window presence is at least the threshold. */
export function isCredited(
  minutes: number,
  minMinutes: number = DEFAULT_ATTENDANCE_MIN_MINUTES,
): boolean {
  return minutes >= minMinutes;
}

// ------------------------------------------------- sample-to-session reconstruction

/**
 * One poll of the Operations channel: who was in it, and when we looked.
 *
 * `nickname` is a snapshot. People rename themselves mid-op, so it is carried
 * on the span and updated rather than treated as part of the identity: `uid` is
 * the identity.
 */
export interface ChannelSample {
  at: Date;
  present: readonly { uid: string; nickname: string }[];
}

/** A presence span that has been opened and not yet closed. */
export interface OpenSpan {
  tsUid: string;
  tsNickname: string;
  joinedAt: Date;
}

/** A presence span the sampler has finished with. */
export interface ClosedSpan extends OpenSpan {
  leftAt: Date;
}

/**
 * What one sample changed, plus the state the next call must be given.
 *
 * Returned rather than mutated because this is the whole of the reconstruction
 * and it has to stay a pure function of (previous open spans, this sample). The
 * worker persists `opened` / `closed` / `renamed` and hands `open` back on the
 * next tick (it reads that state from the database, so a restart mid-op resumes
 * rather than double-counting).
 */
export interface SampleDiff<T extends OpenSpan = OpenSpan> {
  /** Arrivals. New spans, so they carry nothing but the shape above. */
  opened: OpenSpan[];
  /**
   * Departures, carrying whatever the caller's spans carried.
   *
   * Generic on purpose: the worker's spans are database rows and carry their
   * `id`, and keeping it attached through the diff is what lets it close *that
   * row* rather than re-deriving a row id from the identity. Re-deriving would
   * collapse two open spans for one identity onto a single id and leave one of
   * them open forever.
   */
  closed: (T & { leftAt: Date })[];
  renamed: (T & { tsNickname: string })[];
  /**
   * The carried state: every span still open after this sample.
   *
   * `T | OpenSpan` rather than `T[]`, and that is honest rather than loose: the
   * arrivals in `opened` are also still open, and they are brand new, so they
   * cannot carry whatever `T` adds (a database row's `id` does not exist until
   * it is inserted). The worker never reads this, because it re-reads the open
   * spans from the database each tick; the pure fold in `reconstructSessions`
   * does, and for it `T` is `OpenSpan` and the union collapses.
   */
  open: (T | OpenSpan)[];
}

/**
 * Collapse a sample's entries to one per identity.
 *
 * A TeamSpeak *identity* can be connected more than once (same uid, two clients,
 * two `clid`s), and both copies sit in the channel and both come back from
 * `clientlist`. That is one person present once, so the duplicate is dropped
 * rather than opening a second span that would double their credited minutes.
 * First entry wins; which one is arbitrary and does not matter, because they
 * differ only in nickname.
 */
function dedupeByUid(
  present: readonly { uid: string; nickname: string }[],
): Map<string, string> {
  const byUid = new Map<string, string>();
  for (const client of present) {
    if (!byUid.has(client.uid)) byUid.set(client.uid, client.nickname);
  }
  return byUid;
}

/**
 * Diff one sample against the spans currently open.
 *
 * Newly present: open a span at the sample time. No longer present: close theirs
 * at the sample time. Still present under a different nickname: keep the span,
 * record the rename.
 *
 * The sample time is used for both edges, so a join is credited from the first
 * sample that saw it rather than from the moment it actually happened. At a
 * 90-second cadence that is at most 90 seconds of error per edge on a
 * 60-minute threshold, which is the trade the sampling approach is (ADR 0007).
 */
export function applySample<T extends OpenSpan>(
  open: readonly T[],
  sample: ChannelSample,
): SampleDiff<T> {
  const present = dedupeByUid(sample.present);

  const opened: OpenSpan[] = [];
  const closed: (T & { leftAt: Date })[] = [];
  const renamed: (T & { tsNickname: string })[] = [];
  const stillOpen: (T | OpenSpan)[] = [];

  for (const span of open) {
    const nickname = present.get(span.tsUid);
    if (nickname === undefined) {
      closed.push({ ...span, leftAt: sample.at });
      continue;
    }
    const carried = { ...span, tsNickname: nickname };
    if (nickname !== span.tsNickname) renamed.push(carried);
    stillOpen.push(carried);
    present.delete(span.tsUid);
  }

  // Whatever is left in `present` was not open: these are the arrivals.
  for (const [uid, nickname] of present) {
    const span: OpenSpan = {
      tsUid: uid,
      tsNickname: nickname,
      joinedAt: sample.at,
    };
    opened.push(span);
    stillOpen.push(span);
  }

  return { opened, closed, renamed, open: stillOpen };
}

/**
 * Close every open span at one instant.
 *
 * Two callers: the window's end (23:00, so nobody is credited for the debrief),
 * and the restart path, where the worker was away and closes at the last sample
 * it actually took rather than crediting the blind stretch.
 */
export function closeOpenSpans<T extends OpenSpan>(
  open: readonly T[],
  at: Date,
): (T & { leftAt: Date })[] {
  return open.map((span) => ({ ...span, leftAt: at }));
}

/**
 * The whole reconstruction as one fold, which is what the tests drive.
 *
 * The worker never calls this: it applies one sample per tick and persists as it
 * goes. This exists so the rule is exercised end to end over an ordered run of
 * samples, which is the pure function IMPLEMENTATION §11.2 asks for.
 */
export function reconstructSessions(
  samples: readonly ChannelSample[],
  closeAt: Date,
): ClosedSpan[] {
  let open: readonly OpenSpan[] = [];
  const closed: ClosedSpan[] = [];

  for (const sample of samples) {
    const diff = applySample(open, sample);
    closed.push(...diff.closed);
    open = diff.open;
  }

  closed.push(...closeOpenSpans(open, closeAt));
  return closed;
}

// --------------------------------------------------------------- rollups for the views

/**
 * One persisted `attendance_session` row, as the read queries hand it over.
 *
 * `memberId` null is a Guest: a TeamSpeak identity that resolved to nobody when
 * it was sampled and has not been claimed since (CONTEXT.md). Linking backfills
 * these automatically, so a guest row is either somebody who has never linked or
 * somebody who has left.
 */
export interface AttendeeRow {
  memberId: string | null;
  tsUid: string;
  tsNickname: string | null;
  joinedAt: Date;
  leftAt: Date | null;
}

/** One person's whole presence at one op, after their spans are summed. */
export interface Attendee {
  memberId: string | null;
  tsUid: string;
  tsNickname: string | null;
  minutes: number;
  credited: boolean;
}

/** What one op's rows add up to. */
export interface OperationSummary {
  /** Credited first, then by minutes. Guests sort among the members, not after. */
  attendees: Attendee[];
  /** Attendees over the credit threshold. */
  credited: number;
  /** Everyone with any recorded presence, credited or not. */
  present: number;
  /** Of those, the ones that resolve to no member. */
  guests: number;
}

/**
 * Sum an op's session rows per person and apply the credit rule.
 *
 * Grouped by `memberId` where there is one, and by `tsUid` otherwise. Grouping
 * on the member rather than the identity matters for one real case: a member who
 * re-linked to a new TeamSpeak identity mid-history has rows under two uids, and
 * both are theirs. Guests have no member to group on, so they stay per-identity,
 * which is the only thing we know about them.
 */
export function summariseOperation(
  rows: readonly AttendeeRow[],
  window: AttendanceWindow,
  minMinutes: number = DEFAULT_ATTENDANCE_MIN_MINUTES,
): OperationSummary {
  const groups = new Map<string, { row: AttendeeRow; spans: SessionSpan[] }>();

  for (const row of rows) {
    const key = row.memberId ?? `uid:${row.tsUid}`;
    const group = groups.get(key) ?? { row, spans: [] };
    // Keep the latest nickname we have rather than the first: it is the one the
    // reader is likeliest to recognise.
    group.row = row;
    group.spans.push({ joinedAt: row.joinedAt, leftAt: row.leftAt });
    groups.set(key, group);
  }

  const attendees: Attendee[] = [];
  for (const { row, spans } of groups.values()) {
    const minutes = creditedMinutes(spans, window);
    attendees.push({
      memberId: row.memberId,
      tsUid: row.tsUid,
      tsNickname: row.tsNickname,
      minutes,
      credited: isCredited(minutes, minMinutes),
    });
  }

  attendees.sort((a, b) => b.minutes - a.minutes);

  return {
    attendees,
    credited: attendees.filter((a) => a.credited).length,
    present: attendees.length,
    guests: attendees.filter((a) => a.memberId === null).length,
  };
}

/**
 * One entry on the Discord event's "Interested" list, as captured during the op.
 *
 * `memberId` is resolved at read time by joining `member.discord_id`, so it is
 * null for somebody who is on the list but has never logged in to the site.
 */
export interface RsvpEntry {
  discordId: string;
  memberId: string | null;
  name: string;
}

/**
 * Said they were coming against actually turning up.
 *
 * "Turned up" means **any** recorded presence, not credited presence: somebody
 * who dropped in for twenty minutes did answer the RSVP they gave, and calling
 * them a no-show because they missed the 60-minute threshold would be reading
 * the credit rule as an attendance rule. Credit is reported separately.
 */
export interface TurnoutComparison {
  respondedAndCame: RsvpEntry[];
  respondedAndDidNot: RsvpEntry[];
  cameWithoutResponding: Attendee[];
}

/**
 * Cross-tabulate the Interested list against who was actually in the channel.
 *
 * Matching is on `memberId`, the only identifier the two sides share: an RSVP
 * carries a Discord id, a session carries a TeamSpeak uid, and `member` is the
 * hub that joins them (ADR 0001). Two consequences, both correct and both worth
 * naming rather than discovering:
 *
 *  - A responder who resolves to no member can never match an attendee, so they
 *    land in `respondedAndDidNot`. That is somebody on the Interested list who
 *    has never logged in; they may well have been there, under a TeamSpeak
 *    identity nobody can tie to them.
 *  - A Guest always lands in `cameWithoutResponding`, because an unlinked
 *    identity cannot be matched to a Discord id either.
 *
 * Both shrink to nothing as people link, which is the same pressure the guest
 * backfill applies.
 */
export function compareRsvpToTurnout(
  rsvps: readonly RsvpEntry[],
  attendees: readonly Attendee[],
): TurnoutComparison {
  const cameMemberIds = new Set(
    attendees.map((a) => a.memberId).filter((id): id is string => id !== null),
  );
  const respondedMemberIds = new Set(
    rsvps.map((r) => r.memberId).filter((id): id is string => id !== null),
  );

  return {
    respondedAndCame: rsvps.filter((r) =>
      r.memberId !== null && cameMemberIds.has(r.memberId)
    ),
    respondedAndDidNot: rsvps.filter((r) =>
      r.memberId === null || !cameMemberIds.has(r.memberId)
    ),
    cameWithoutResponding: attendees.filter((a) =>
      a.memberId === null || !respondedMemberIds.has(a.memberId)
    ),
  };
}

/**
 * How many of the recent ops a member showed up to, and when they last did.
 *
 * Deliberately **numbers, not a label**. Where the line between "active" and
 * "inactive" sits is arguable, nothing in the platform acts on the answer
 * (ADR 0010), and a binary flag invites somebody to start acting on it. The
 * roster shows the counts and lets a human read them.
 */
export interface MemberActivity {
  memberId: string;
  /** Ops over the credit threshold. */
  creditedOps: number;
  /** Ops with any presence at all. */
  attendedOps: number;
  /**
   * The date of the most recent op they were present at, or null.
   *
   * How many ops were *considered* is deliberately not here: it is the same
   * number for every member in one roll-up, so the caller already has it as the
   * length of what it passed in.
   */
  lastAttended: string | null;
}

/**
 * Per-member totals across a run of ops.
 *
 * Takes each op's already-summarised attendees, so the credit rule is applied in
 * exactly one place. Guests are skipped: they have no member to total against,
 * and they appear in their own list on the page instead.
 */
export function rollUpMemberActivity(
  ops: readonly { date: string; attendees: readonly Attendee[] }[],
): MemberActivity[] {
  const byMember = new Map<string, MemberActivity>();

  for (const op of ops) {
    for (const attendee of op.attendees) {
      if (attendee.memberId === null) continue;
      const current = byMember.get(attendee.memberId) ?? {
        memberId: attendee.memberId,
        creditedOps: 0,
        attendedOps: 0,
        lastAttended: null,
      };
      current.attendedOps += 1;
      if (attendee.credited) current.creditedOps += 1;
      // Dates are `YYYY-MM-DD`, so a string compare is a date compare.
      if (current.lastAttended === null || op.date > current.lastAttended) {
        current.lastAttended = op.date;
      }
      byMember.set(attendee.memberId, current);
    }
  }

  return [...byMember.values()].sort((a, b) =>
    b.creditedOps - a.creditedOps ||
    (b.lastAttended ?? "").localeCompare(a.lastAttended ?? "")
  );
}
