/**
 * Scheduling the weekly Saturday Operation (ARCHITECTURE §4.2, IMPLEMENTATION §7).
 *
 * All of this is pure, and deliberately so: `packages/domain` does no I/O, and
 * the time arithmetic is exactly the part that is easy to get wrong and worth
 * testing without a clock or a live Discord. The worker (apps/worker) reads the
 * environment, calls Discord and writes the database; it hands plain data in and
 * gets plain data out of here.
 *
 * **Times are computed DST-correct in a real IANA timezone, never as a fixed UTC
 * hour.** The op is defined as a wall-clock time in Europe/Amsterdam (20:00), and
 * that wall clock lands on a different UTC instant in summer (CEST, UTC+2) than in
 * winter (CET, UTC+1). A hardcoded UTC hour would silently misplace the op by an
 * hour twice a year, which the docs call out specifically.
 */

/** A wall-clock instant broken into a timezone's local fields. */
export interface ZonedParts {
  year: number;
  /** 1-12, not 0-11: this reads as a calendar month everywhere it is used. */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday .. 6 = Saturday, matching `Date.prototype.getUTCDay`. */
  weekday: number;
}

/**
 * What a UTC instant looks like on the wall clock in `timeZone`.
 *
 * `Intl.DateTimeFormat` is the only dependency-free way to read a timezone's
 * local time, and it is pure (no I/O), so it belongs here. The weekday is derived
 * from the local calendar date rather than asked of `Intl`, because the day of the
 * week of a Y-M-D is the same in every timezone and a number is easier to reason
 * about than a localized short name.
 */
export function utcToZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    // `h23`, not `hour12: false`: the latter renders midnight as "24" under an
    // `h24` cycle in some engines, which pushes the date forward a day on every
    // conversion. `h23` runs 00-23 and never produces 24.
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)?.value);

  const year = get("year");
  const month = get("month");
  const day = get("day");

  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    // Day-of-week of a calendar date is timezone-independent, so build it in UTC.
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
  };
}

/** A local wall clock, with no timezone of its own until one is applied. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * The UTC instant a wall clock refers to in `timeZone`.
 *
 * The inverse of `utcToZonedParts`, and there is no direct API for it, so it is
 * solved by search: guess the instant as if the wall clock were UTC, ask what
 * wall clock that instant actually shows in the zone, and the difference is the
 * offset to subtract. A second pass covers the case where the first guess lands on
 * the far side of a DST change from the target (the offset there differs from the
 * offset here); our op times (18:00, 20:00, 23:00, 23:30) never sit in the
 * 02:00-03:00 transition hour, but the refinement costs nothing and removes the
 * caveat.
 */
export function zonedWallClockToUtc(wall: WallClock, timeZone: string): Date {
  const target = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
  );

  const offsetAt = (utcMs: number): number => {
    const shown = utcToZonedParts(new Date(utcMs), timeZone);
    const shownAsUtc = Date.UTC(
      shown.year,
      shown.month - 1,
      shown.day,
      shown.hour,
      shown.minute,
      shown.second,
    );
    return shownAsUtc - utcMs;
  };

  const firstOffset = offsetAt(target);
  let result = target - firstOffset;
  const secondOffset = offsetAt(result);
  if (secondOffset !== firstOffset) result = target - secondOffset;
  return new Date(result);
}

/** The signed offset of `timeZone` from UTC at `date`, in minutes. */
function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = utcToZonedParts(date, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "HH:MM" -> { hour, minute }. */
function parseHhMm(value: string): { hour: number; minute: number } {
  const [h, m] = value.split(":");
  return { hour: Number(h), minute: Number(m) };
}

/** A calendar date as `YYYY-MM-DD`, which is what the `operation.date` column stores. */
function isoDate(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** The knobs that define when an op happens and when it is announced. */
export interface OpScheduleConfig {
  timeZone: string;
  /**
   * Event start / attendance start, "HH:MM" local (20:00). Named for what it is
   * in the plan it produces (`WeeklyOpPlan.attendanceStart`), so the same instant
   * does not travel under two names between the config and the plan.
   */
  attendanceStart: string;
  /** Attendance window end, "HH:MM" local (23:00). Stored on the op row for Phase 6. */
  attendanceEnd: string;
  /** Discord event end, "HH:MM" local (23:30). */
  eventEnd: string;
  /** The weekday the event is created and announced. 0 = Sunday .. 6 = Saturday (3 = Wednesday). */
  announceWeekday: number;
  /** The local time on that weekday to announce, "HH:MM" (18:00). */
  announceTime: string;
}

/** The computed schedule for one week's Saturday op. */
export interface WeeklyOpPlan {
  /** The Saturday's calendar date, `YYYY-MM-DD`: the unique `operation.date`. */
  saturdayDate: string;
  /** 20:00 local as a UTC instant. */
  attendanceStart: Date;
  /** 23:00 local as a UTC instant. */
  attendanceEnd: Date;
  /** 23:30 local as a UTC instant; the Discord event's end. */
  eventEnd: Date;
  /** The moment the event should be created and @everyone posted (Wed 18:00 local). */
  announceAt: Date;
  /**
   * Whether `now` is inside the acting window: at or past `announceAt`, and before
   * the op **starts** (`attendanceStart`). Outside it, the worker does nothing this
   * tick.
   *
   * The upper bound is the op start, not the event end, and that is load-bearing:
   * Discord refuses to create a scheduled event whose `scheduled_start_time` is
   * already in the past, so once the op has begun the event can no longer be
   * created at all (and announcing an op that is already underway is moot). Late
   * catch-up therefore works right up until the op starts, not until it ends.
   */
  withinWindow: boolean;
}

/**
 * The schedule for the Saturday op that `now` belongs to.
 *
 * "The Saturday that `now` belongs to" is the next Saturday on or after today's
 * local date: on Sunday through Friday it is the coming Saturday; on Saturday it is
 * today (so a week the worker was down all along still gets its event created late,
 * right up until the op starts). Once the op has started, `withinWindow` is false
 * (a past start cannot be scheduled), and the target rolls to next week on the
 * following midnight.
 *
 * The whole reason the worker can be a simple reconciler rather than a
 * fire-exactly-once cron is that this is a pure function of `now`: recompute it
 * every tick, and the answer is stable across restarts and missed ticks.
 */
export function planWeeklyOp(
  now: Date,
  config: OpScheduleConfig,
): WeeklyOpPlan {
  const local = utcToZonedParts(now, config.timeZone);

  // Days from today's local weekday forward to Saturday (0 when today is Saturday).
  const daysUntilSaturday = (6 - local.weekday + 7) % 7;
  // Calendar arithmetic only: adding days to a Y-M-D is timezone-independent.
  const saturday = new Date(
    Date.UTC(local.year, local.month - 1, local.day + daysUntilSaturday),
  );
  const satY = saturday.getUTCFullYear();
  const satM = saturday.getUTCMonth() + 1;
  const satD = saturday.getUTCDate();

  const at = (time: string): Date => {
    const { hour, minute } = parseHhMm(time);
    return zonedWallClockToUtc(
      { year: satY, month: satM, day: satD, hour, minute },
      config.timeZone,
    );
  };

  const attendanceStart = at(config.attendanceStart);
  const attendanceEnd = at(config.attendanceEnd);
  const eventEnd = at(config.eventEnd);

  // The announce weekday within the same week, counted back from Saturday. For
  // Wednesday (3) that is 3 days before; the modulo keeps it correct for any
  // configured weekday.
  const daysBeforeSaturday = (6 - config.announceWeekday + 7) % 7;
  const announceDay = new Date(
    Date.UTC(satY, satM - 1, satD - daysBeforeSaturday),
  );
  const announce = parseHhMm(config.announceTime);
  const announceAt = zonedWallClockToUtc(
    {
      year: announceDay.getUTCFullYear(),
      month: announceDay.getUTCMonth() + 1,
      day: announceDay.getUTCDate(),
      hour: announce.hour,
      minute: announce.minute,
    },
    config.timeZone,
  );

  // Upper bound is the op start, not the event end: Discord will not schedule an
  // event whose start is already past, so the window has to close when the op does.
  const withinWindow = now.getTime() >= announceAt.getTime() &&
    now.getTime() < attendanceStart.getTime();

  return {
    saturdayDate: isoDate(satY, satM, satD),
    attendanceStart,
    attendanceEnd,
    eventEnd,
    announceAt,
    withinWindow,
  };
}

/**
 * The event title: the op's local start time, its timezone abbreviation, and a
 * fixed suffix, e.g. `"20:00 CEST - Saturday Operation"`.
 *
 * The abbreviation is derived from the DST offset rather than hardcoded, so it
 * reads "CEST" in summer and "CET" in winter automatically. It is
 * Central-European by construction (the unit is on Europe/Amsterdam); for any
 * other offset it falls back to a plain `UTC±H` label rather than inventing a
 * name it cannot know.
 */
export function opTitle(eventStart: Date, timeZone: string): string {
  const p = utcToZonedParts(eventStart, timeZone);
  const time = `${pad2(p.hour)}:${pad2(p.minute)}`;
  return `${time} ${zoneAbbrev(eventStart, timeZone)} - Saturday Operation`;
}

/** CEST/CET for Central European offsets; a neutral `UTC±H` for anything else. */
function zoneAbbrev(date: Date, timeZone: string): string {
  const offset = tzOffsetMinutes(date, timeZone);
  if (offset === 120) return "CEST";
  if (offset === 60) return "CET";
  const hours = offset / 60;
  const sign = hours >= 0 ? "+" : "-";
  return `UTC${sign}${Math.abs(hours)}`;
}

/**
 * One item chosen uniformly at random, or `undefined` for an empty list.
 *
 * The randomness is injected, and deliberately has **no default**: this package is
 * pure, and a `Math.random` default would leave every production call implicitly
 * non-deterministic while the tests quietly passed a stub, so the one caller that
 * wants real randomness (the worker) says so at the call site. Kept here rather
 * than in the worker so the one branch worth testing (empty list -> undefined, so
 * the announcement degrades to no image or no witty line rather than throwing) is
 * covered without touching the filesystem.
 */
export function pickRandom<T>(
  items: readonly T[],
  rng: () => number,
): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}
