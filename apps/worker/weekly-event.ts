import { extname, join } from "@std/path";
import type { OpsConfig } from "@7r/config";
import type { Db } from "@7r/db";
import {
  getOrCreateWeeklyOperation,
  markOperationAnnounced,
  setOperationDiscordEvent,
} from "@7r/db";
import {
  type OpScheduleConfig,
  opTitle,
  pickRandom,
  planWeeklyOp,
  type WeeklyOpPlan,
} from "@7r/domain";
import {
  createGuildScheduledEvent,
  createMessage,
  DiscordApiError,
  type DiscordRestOptions,
  type EventCoverImage,
  guildScheduledEventUrl,
  listChannelMessages,
  listGuildScheduledEvents,
  type ScheduledEvent,
} from "@7r/discord";

/**
 * The weekly Saturday Operation: create the Discord scheduled event (with a random
 * in-game image as its cover banner) and its `operation` row, then ping @everyone
 * in #arma_general with the event link (ARCHITECTURE §4.2, IMPLEMENTATION §7).
 *
 * This is a reconciler, not a fire-once cron. Every tick it recomputes the coming
 * Saturday and this week's announce moment (pure, `@7r/domain` `planWeeklyOp`), and
 * inside the window it ensures three things exist. Each is guarded by a database
 * column AND reconciled against Discord's own state, so a pass that crashed between
 * a Discord write and the database write that records it resumes rather than
 * duplicates:
 *   - the `operation` row (unique `date`);
 *   - the scheduled event (`operation.discord_event_id`; before creating, the pass
 *     lists the guild's events and adopts a matching one, so a lost event id never
 *     spawns a second event: this reconcile fails closed, aborting the pass if the
 *     list cannot be read);
 *   - the announcement (`operation.announced_at`; before posting, the pass scans the
 *     channel for its own prior message so a crash between posting and recording
 *     does not re-ping the guild. This scan is best-effort: if the history cannot
 *     be read it posts anyway, so a double-ping is made unlikely, not impossible).
 * A fixed UTC cron was rejected on purpose: it would misplace the op by an hour
 * across a DST change, and it would not survive a missed tick.
 */

/**
 * The event's fixed copy. The title is dynamic (`opTitle`); these are not.
 *
 * `EVENT_LOCATION` is exported because `op:preview` prints it: the preview is the
 * gate before the job goes live, so every field it shows has to come from the code
 * that acts rather than from a literal of its own.
 */
export const EVENT_LOCATION = "7R Operations Server";
const EVENT_DESCRIPTION = [
  "Mission: TBD",
  "Location: TBD",
  'Mark yourself as "interested" if you plan on attending!',
].join("\n");

const EVENT_AUDIT_REASON = "Weekly Saturday Operation (auto-created)";

/**
 * Image extensions we will use as the event cover; anything else in the folder is
 * ignored. Limited to what Discord's "image data" accepts for a cover (PNG, JPG,
 * GIF: reference#image-data); a `.webp` would just be rejected and fall back to no
 * cover, so it is left out rather than offered.
 */
const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/**
 * A cover image picked from the folder, named but not yet read.
 *
 * Choosing and reading are separate because only the creating pass needs the
 * bytes: the dry-run log and `op:preview` report the filename, and pulling a
 * multi-megabyte image into memory to print its name is work with no reader.
 */
interface ChosenImage {
  filename: string;
  /** The full path, so reading it back needs no second `join` and no `imageDir`. */
  path: string;
  contentType: string;
}

/** A chosen cover image, read: its filename (for logs) and the bytes Discord encodes. */
interface PickedImage extends EventCoverImage {
  filename: string;
}

/**
 * The schedule the pure planner needs, read off the ops config.
 *
 * One place on purpose: the live loop (main.ts) and `op:preview` both need this
 * object built from the same six keys, and a preview computed from a schedule
 * that has drifted from the live one is precisely the bug the preview exists to
 * catch. A seventh knob is now one edit, not two.
 */
export function opScheduleFrom(ops: OpsConfig): OpScheduleConfig {
  return {
    timeZone: ops.OP_TIMEZONE,
    attendanceStart: ops.OP_ATTENDANCE_START,
    attendanceEnd: ops.OP_ATTENDANCE_END,
    eventEnd: ops.OP_EVENT_END,
    announceWeekday: ops.OP_ANNOUNCE_WEEKDAY,
    announceTime: ops.OP_ANNOUNCE_TIME,
  };
}

export interface WeeklyEventDeps {
  db: Db;
  discord: DiscordRestOptions;
  guildId: string;
  /** #arma_general. */
  announceChannelId: string;
  schedule: OpScheduleConfig;
  /** Optional path to a witty-lines file; unset -> no witty line. */
  textFile?: string;
  /** Optional path to an image folder; unset -> no image. */
  imageDir?: string;
  log: (message: string, extra?: Record<string, unknown>) => void;
  alert: (summary: string, detail?: unknown) => void;
}

/**
 * The subset of deps the announcement builder and the preview read: the guild (for
 * the event URL), the schedule, the optional asset paths, and a logger. No
 * database, no Discord auth, no channel id. Naming it lets `op:preview` pass only
 * what it actually uses instead of stubbing a database it never touches.
 */
export type WeeklyEventPreviewDeps = Pick<
  WeeklyEventDeps,
  "guildId" | "schedule" | "textFile" | "imageDir" | "log"
>;

export interface WeeklyEventResult {
  /**
   * - `idle`: outside the acting window this tick, nothing to do.
   * - `dry_run`: inside the window; logged what it would do, wrote nothing.
   * - `created`: created the scheduled event this pass.
   * - `adopted`: the event was already on Discord from a pass that crashed before
   *   recording its id; this pass recorded it and created nothing. Kept distinct
   *   from `created` because reporting a creation that did not happen is exactly
   *   how a duplicate-event bug would hide.
   * - `announced`: posted the @everyone announcement this pass.
   * - `noop`: inside the window but the event and announcement already existed.
   */
  outcome:
    | "idle"
    | "dry_run"
    | "created"
    | "adopted"
    | "announced"
    | "noop";
  saturdayDate: string;
}

/**
 * One pass. `apply: false` computes and logs without writing anything or calling
 * Discord (SYNC_DRY_RUN's sibling); `apply: true` creates the event, records it,
 * and posts the announcement, each step only if Discord does not already have it.
 */
export async function runWeeklyEventPass(
  deps: WeeklyEventDeps,
  opts: { apply: boolean },
): Promise<WeeklyEventResult> {
  const now = new Date();
  const plan = planWeeklyOp(now, deps.schedule);

  if (!plan.withinWindow) {
    return { outcome: "idle", saturdayDate: plan.saturdayDate };
  }

  if (!opts.apply) {
    // Dry run: decide nothing and read nothing here. The loop surfaces the full
    // preview once per week (and `op:preview` shows it on demand), so this stays a
    // cheap no-op rather than dumping the announcement and re-reading the asset
    // files on every one of the ~900 ticks in the window.
    return { outcome: "dry_run", saturdayDate: plan.saturdayDate };
  }

  const op = await getOrCreateWeeklyOperation(deps.db, {
    date: plan.saturdayDate,
    attendanceStart: plan.attendanceStart,
    attendanceEnd: plan.attendanceEnd,
    eventEnd: plan.eventEnd,
  });

  let eventId = op.discordEventId;
  // What this pass did about the event, or null if it was already recorded and
  // this pass touched nothing.
  let eventOutcome: "created" | "adopted" | null = null;

  if (eventId === null) {
    // The title is the event's identity for the adopt-or-create reconcile below,
    // and nothing outside this branch reads it, so it is computed here rather than
    // on every one of the ~900 ticks that find the event already recorded.
    const title = opTitle(plan.attendanceStart, deps.schedule.timeZone);
    // Reconcile against Discord before creating. A prior pass may have created the
    // event and then failed to record its id (a crash between the POST and the DB
    // write): list the guild's events and adopt a match rather than making a second
    // event. If the list itself fails, the pass fails and retries next tick, which
    // is correct: creating without having checked is what risks a duplicate.
    const existingId = await findExistingEvent(
      deps,
      title,
      plan.attendanceStart,
    );
    if (existingId !== null) {
      eventId = existingId;
      eventOutcome = "adopted";
      deps.log("weekly event already on Discord; adopted it", {
        date: plan.saturdayDate,
        eventId,
        title,
      });
    } else {
      eventId = await createEvent(deps, title, plan);
      eventOutcome = "created";
    }
    // Either way the event now exists and its id is ours to record: one write,
    // outside the branch, so the two paths cannot drift apart.
    await setOperationDiscordEvent(deps.db, op.id, eventId);
  }

  if (op.announcedAt !== null) {
    return {
      outcome: eventOutcome ?? "noop",
      saturdayDate: plan.saturdayDate,
    };
  }

  const eventUrl = guildScheduledEventUrl(deps.guildId, eventId);

  // Reconcile the announcement the same way. If a prior pass posted it but crashed
  // before recording announced_at, the event link is already in the channel: record
  // it and do NOT re-ping the whole guild.
  if (await announcementAlreadyPosted(deps, eventUrl)) {
    await markOperationAnnounced(deps.db, op.id);
    deps.log("weekly event announcement already present; not re-posting", {
      date: plan.saturdayDate,
      channel: deps.announceChannelId,
    });
    return {
      outcome: eventOutcome ?? "noop",
      saturdayDate: plan.saturdayDate,
    };
  }

  const content = await buildAnnouncementContent(deps, eventUrl);
  await createMessage(deps.discord, deps.announceChannelId, {
    content,
    allowedMentions: { parse: ["everyone"] },
  });
  await markOperationAnnounced(deps.db, op.id);
  deps.log("weekly event announced", {
    date: plan.saturdayDate,
    channel: deps.announceChannelId,
  });

  return { outcome: "announced", saturdayDate: plan.saturdayDate };
}

/**
 * Create the scheduled event with a random cover image, falling back to no cover
 * if Discord rejects the image. Returns the new event id.
 */
async function createEvent(
  deps: Pick<
    WeeklyEventDeps,
    "discord" | "guildId" | "imageDir" | "log" | "alert"
  >,
  title: string,
  plan: WeeklyOpPlan,
): Promise<string> {
  const cover = await pickImage(deps);
  const create = (image?: EventCoverImage): Promise<ScheduledEvent> =>
    createGuildScheduledEvent(deps.discord, deps.guildId, {
      name: title,
      description: EVENT_DESCRIPTION,
      location: EVENT_LOCATION,
      start: plan.attendanceStart,
      end: plan.eventEnd,
      reason: EVENT_AUDIT_REASON,
      image,
    });

  let event: ScheduledEvent;
  try {
    event = await create(cover);
  } catch (error) {
    // A 400 means Discord rejected the request and created nothing (a 5xx or a
    // dropped connection might have created it, so those must not be retried
    // here). If a cover was attached it is the likely culprit (too large, or an
    // unsupported type), so retry once without it: a bad decorative image must
    // never block the op event itself. The op start is always in the future here
    // (planWeeklyOp closes the window at attendanceStart), so a 400 is never a
    // stale-start-time rejection that dropping the image could not fix.
    if (cover && error instanceof DiscordApiError && error.status === 400) {
      deps.log("event cover image rejected; retrying without it", {
        image: cover.filename,
        error: String(error),
      });
      // Retry FIRST; only claim (and alert) success once it actually creates. If
      // the second attempt throws too, it propagates unmentioned rather than
      // paging a false "created without it" on every tick.
      event = await create(undefined);
      deps.alert(
        "weekly event: cover image rejected, event created without it",
        `Image "${cover.filename}" was refused (too large, or not PNG/JPG/GIF). ${
          String(error)
        }`,
      );
    } else {
      throw error;
    }
  }

  deps.log("weekly event created", {
    date: plan.saturdayDate,
    eventId: event.id,
    title,
    cover: cover?.filename ?? null,
  });
  return event.id;
}

/**
 * The id of a scheduled event already on the guild that matches this op (same
 * title and same start instant), or null. Lets a pass adopt an event a crashed
 * earlier pass created but never recorded, instead of making a duplicate.
 */
async function findExistingEvent(
  deps: Pick<WeeklyEventDeps, "discord" | "guildId">,
  title: string,
  start: Date,
): Promise<string | null> {
  const events = await listGuildScheduledEvents(deps.discord, deps.guildId);
  const match = events.find((e) =>
    e.name === title &&
    new Date(e.scheduled_start_time).getTime() === start.getTime()
  );
  return match?.id ?? null;
}

/** How many recent messages to scan for a prior announcement before posting. */
const ANNOUNCEMENT_SCAN_LIMIT = 50;

/**
 * Whether the channel already holds our announcement for this event, found by the
 * event link it carries. Best-effort: if the history cannot be read (no Read
 * Message History permission, say), it returns false and the announcement is posted
 * anyway; the only thing forfeited is the guard against the rare double-post.
 */
async function announcementAlreadyPosted(
  deps: Pick<WeeklyEventDeps, "discord" | "announceChannelId" | "log">,
  eventUrl: string,
): Promise<boolean> {
  try {
    const recent = await listChannelMessages(
      deps.discord,
      deps.announceChannelId,
      ANNOUNCEMENT_SCAN_LIMIT,
    );
    return recent.some((m) => m.content.includes(eventUrl));
  } catch (error) {
    deps.log(
      "could not read channel history before announcing; posting anyway",
      { error: String(error) },
    );
    return false;
  }
}

/**
 * The computed plan, title and the exact announcement (text + chosen image) for a
 * given `now`, without acting on any of it. This is what `op:preview` prints; it
 * ignores the acting window so the CLI can show the upcoming op any day of the
 * week, whereas a live pass only acts inside it.
 */
export async function describeWeeklyEvent(
  deps: WeeklyEventPreviewDeps,
  now: Date,
): Promise<{
  plan: WeeklyOpPlan;
  title: string;
  /** The cover image that would go on the event, or null if none is available. */
  coverImageName: string | null;
  /** The @everyone message text (the image rides on the event, not the message). */
  announcement: string;
}> {
  const plan = planWeeklyOp(now, deps.schedule);
  const title = opTitle(plan.attendanceStart, deps.schedule.timeZone);
  const cover = await chooseImage(deps);
  const announcement = await buildAnnouncementContent(
    deps,
    guildScheduledEventUrl(deps.guildId, "<event-id>"),
  );
  return {
    plan,
    title,
    coverImageName: cover?.filename ?? null,
    announcement,
  };
}

/** Build the @everyone message: the ping, an optional witty line, the event link. */
async function buildAnnouncementContent(
  deps: Pick<WeeklyEventDeps, "textFile" | "log">,
  eventUrl: string,
): Promise<string> {
  const line = await pickWittyLine(deps);
  const paragraphs = ["@everyone"];
  if (line) paragraphs.push(line);
  // The URL on its own paragraph is what Discord unfurls into the event card, with
  // its cover banner and its native "Interested" button.
  paragraphs.push(eventUrl);
  return paragraphs.join("\n\n");
}

/** A random non-empty line from the witty-lines file, or undefined if unusable. */
async function pickWittyLine(
  deps: Pick<WeeklyEventDeps, "textFile" | "log">,
): Promise<string | undefined> {
  if (!deps.textFile) return undefined;
  try {
    const text = await Deno.readTextFile(deps.textFile);
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    return pickRandom(lines, Math.random);
  } catch (error) {
    // Best-effort: a missing or unreadable file just means no witty line, not a
    // failed announcement.
    deps.log("could not read announcement text file", {
      path: deps.textFile,
      error: String(error),
    });
    return undefined;
  }
}

/** A random image from the folder, named only, or undefined if unusable. */
async function chooseImage(
  deps: Pick<WeeklyEventDeps, "imageDir" | "log">,
): Promise<ChosenImage | undefined> {
  if (!deps.imageDir) return undefined;
  try {
    // Keep the content type from the same call that decided the file is an image,
    // so the pick carries its own type and nothing has to assert it back later.
    const candidates: ChosenImage[] = [];
    for await (const entry of Deno.readDir(deps.imageDir)) {
      if (!entry.isFile) continue;
      const contentType = contentTypeOf(entry.name);
      if (!contentType) continue;
      candidates.push({
        filename: entry.name,
        path: join(deps.imageDir, entry.name),
        contentType,
      });
    }
    return pickRandom(candidates, Math.random);
  } catch (error) {
    deps.log("could not read announcement image folder", {
      dir: deps.imageDir,
      error: String(error),
    });
    return undefined;
  }
}

/** A random image from the folder, read into memory, or undefined if unusable. */
async function pickImage(
  deps: Pick<WeeklyEventDeps, "imageDir" | "log">,
): Promise<PickedImage | undefined> {
  const chosen = await chooseImage(deps);
  if (!chosen) return undefined;
  try {
    const bytes = await Deno.readFile(chosen.path);
    return {
      filename: chosen.filename,
      contentType: chosen.contentType,
      bytes,
    };
  } catch (error) {
    // Best-effort, like the folder scan: an unreadable file means no cover, not a
    // failed event.
    deps.log("could not read announcement image", {
      path: chosen.path,
      error: String(error),
    });
    return undefined;
  }
}

/** The MIME type for a filename's extension, or undefined if it is not an image. */
function contentTypeOf(filename: string): string | undefined {
  return IMAGE_CONTENT_TYPES[extname(filename).toLowerCase()];
}

/**
 * The steady-state loop: one pass now, then every `intervalSeconds`. Same shape
 * as the sync loop (apps/worker/sync.ts): a `running` latch stops a slow pass
 * stacking, and a single episode latch keeps a standing failure (a missing
 * CREATE_EVENTS grant 403ing every tick for three days) from paging on every
 * tick. Returns a stop function for the worker's shutdown path.
 */
export function startWeeklyEventLoop(
  deps: WeeklyEventDeps,
  opts: { intervalSeconds: number; dryRun: boolean },
): () => void {
  let running = false;
  let pagedFailure = false;
  // The last Saturday a dry-run preview was logged for, so the preview goes to the
  // log once when the window opens rather than on every tick within it. The
  // actions themselves (created/announced) log inside runWeeklyEventPass, once
  // each, so a live pass needs nothing here; steady-state no-ops stay silent and
  // the heartbeat proves liveness.
  let dryRunLoggedDate: string | null = null;

  const pass = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runWeeklyEventPass(deps, { apply: !opts.dryRun });

      if (
        result.outcome === "dry_run" && result.saturdayDate !== dryRunLoggedDate
      ) {
        dryRunLoggedDate = result.saturdayDate;
        const preview = await describeWeeklyEvent(deps, new Date());
        deps.log(
          "weekly event (dry run): would create the event and announce",
          {
            date: preview.plan.saturdayDate,
            title: preview.title,
            location: EVENT_LOCATION,
            coverImage: preview.coverImageName,
            channel: deps.announceChannelId,
            announcement: preview.announcement,
          },
        );
      }

      // A real pass in the window succeeded: close any failure episode.
      if (pagedFailure && result.outcome !== "idle") {
        pagedFailure = false;
        deps.alert(
          "weekly event recovered",
          "A pass completed normally again.",
        );
      }
    } catch (error) {
      deps.log("weekly event pass failed", { error: String(error) });
      if (!pagedFailure) {
        pagedFailure = true;
        deps.alert("weekly event pass failed", error);
      }
    } finally {
      running = false;
    }
  };

  deps.log("weekly event loop started", {
    intervalSeconds: opts.intervalSeconds,
    dryRun: opts.dryRun,
    timeZone: deps.schedule.timeZone,
    announceWeekday: deps.schedule.announceWeekday,
    announceTime: deps.schedule.announceTime,
  });
  pass();
  const interval = setInterval(pass, opts.intervalSeconds * 1_000);
  return () => clearInterval(interval);
}
