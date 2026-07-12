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
 * reconstruction (Phase 5) and should be fixed there rather than papered over
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
