import { extname, join } from "@std/path";
import type { OpsConfig } from "@7r/config";
import type { Db } from "@7r/db";
import {
  getOrCreateWeeklyOperation,
  markOperationAnnounced,
  markOperationPrepared,
  setOperationDiscordEvent,
} from "@7r/db";
import {
  type OpScheduleConfig,
  opTitle,
  pickRandom,
  planWeeklyOp,
  splitMessages,
  type WeeklyOpPlan,
} from "@7r/domain";
import {
  createGuildScheduledEvent,
  createMessage,
  DiscordApiError,
  type DiscordRestOptions,
  discordTimestamp,
  type EventCoverImage,
  guildScheduledEventUrl,
  listChannelMessages,
  listGuildScheduledEvents,
  type ScheduledEvent,
} from "@7r/discord";
import { getLogger, ROOT_CATEGORY } from "@7r/logging";

const log = getLogger([ROOT_CATEGORY, "worker", "event"]);

/**
 * The weekly Saturday Operation: create the Discord scheduled event (with a random
 * in-game image as its cover banner) and its `operation` row, ping the mission
 * makers to fill the event in, then a day later ping @everyone in #arma_general
 * with the event link (ARCHITECTURE §4.2, IMPLEMENTATION §7).
 *
 * The event is created ahead of the announcement on purpose: it is born with
 * "Mission: TBD / Location: TBD" on it, and the mission makers are the ones who
 * can replace that. Creating it at the announce moment left them no window, so the
 * @everyone went out to a guild that could not yet be told what it was turning up
 * for. The prep moment is `prepLeadDays` before the announce moment
 * (`planWeeklyOp`), and the whole step is off unless a mission-maker channel is
 * configured.
 *
 * This is a reconciler, not a fire-once cron. Every tick it recomputes the coming
 * Saturday and this week's prep and announce moments (pure, `@7r/domain`
 * `planWeeklyOp`), and inside the window it ensures four things exist. Each is
 * guarded by a database column AND reconciled against Discord's own state, so a
 * pass that crashed between a Discord write and the database write that records it
 * resumes rather than duplicates:
 *   - the `operation` row (unique `date`);
 *   - the scheduled event (`operation.discord_event_id`; before creating, the pass
 *     lists the guild's events and adopts a matching one, so a lost event id never
 *     spawns a second event: this reconcile fails closed, aborting the pass if the
 *     list cannot be read);
 *   - the mission-maker ping (`operation.prepared_at`);
 *   - the announcement (`operation.announced_at`), held back until the announce
 *     moment even though the event has existed since the prep one.
 * Before either ping the pass scans that channel for its own prior message so a
 * crash between posting and recording does not re-ping. Those scans are
 * best-effort: if the history cannot be read it posts anyway, so a double-ping is
 * made unlikely, not impossible.
 *
 * A fixed UTC cron was rejected on purpose: it would misplace the op by an hour
 * across a DST change, and it would not survive a missed tick.
 */

/**
 * The event's fixed copy. The title is dynamic (`opTitle`); these are not.
 *
 * `EVENT_LOCATION` is exported because `op:preview` prints it: the preview is the
 * gate before the job goes live, so every field it shows has to come from the code
 * that acts rather than from a literal of its own.
 *
 * The two TBD lines are not a placeholder we forgot to fill: they are the form the
 * mission makers edit between the prep ping and the announcement.
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
    // One switch, read here so the plan and the acting pass cannot disagree about
    // it: with no mission-maker channel there is nobody to ping, and pulling the
    // event creation a day earlier anyway would only mean an event sitting in the
    // guild for a day with "Mission: TBD" on it and no one asked to fix it.
    prepLeadDays: ops.OP_PREP_CHANNEL_ID ? ops.OP_PREP_LEAD_DAYS : 0,
  };
}

export interface WeeklyEventDeps {
  db: Db;
  discord: DiscordRestOptions;
  guildId: string;
  /** #arma_general. */
  announceChannelId: string;
  /**
   * The mission-maker channel pinged ahead of the announcement; unset -> no prep
   * step (and `opScheduleFrom` collapses the lead to 0 to match).
   */
  prepChannelId?: string;
  /** The role mentioned in the prep ping; unset -> the ping mentions nobody. */
  prepMentionRoleId?: string;
  schedule: OpScheduleConfig;
  /** Optional path to a witty-lines file; unset -> no witty line. */
  textFile?: string;
  /** Optional path to an image folder; unset -> no image. */
  imageDir?: string;
  /** Threaded, unlike the logger: see `SyncDeps.alert` (sync.ts) and ADR 0019. */
  alert: (summary: string, detail?: unknown) => void;
}

/**
 * The subset of deps the announcement builder and the preview read: the guild (for
 * the event URL), the schedule and the optional asset paths. No database, no
 * Discord auth, no channel id. Naming it lets `op:preview` pass only what it
 * actually uses instead of stubbing a database it never touches.
 *
 * `op:preview` still sees the file-read failures this path can report: they go
 * to the module logger now, and the CLI turns that on itself (op-preview.ts).
 */
export type WeeklyEventPreviewDeps = Pick<
  WeeklyEventDeps,
  "guildId" | "schedule" | "textFile" | "imageDir" | "prepMentionRoleId"
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
   * - `prepared`: pinged the mission makers to fill the event in this pass.
   * - `waiting`: the event and the prep ping are done and the announce moment has
   *   not arrived yet. The steady state of the day the mission makers have to
   *   edit, and distinct from `noop` so a stuck announcement can be told apart
   *   from one that is simply not due.
   * - `announced`: posted the @everyone announcement this pass.
   * - `noop`: inside the window but every step was already done.
   *
   * A pass that does several of these reports the last one it got to, so the
   * first live pass of a week that also reaches the announcement reports
   * `announced`, not `created`.
   */
  outcome:
    | "idle"
    | "dry_run"
    | "created"
    | "adopted"
    | "prepared"
    | "waiting"
    | "announced"
    | "noop";
  saturdayDate: string;
}

/**
 * One pass. `apply: false` computes and logs without writing anything or calling
 * Discord (SYNC_DRY_RUN's sibling); `apply: true` creates the event, records it,
 * pings the mission makers and posts the announcement, each step only if Discord
 * does not already have it and only once its moment has come.
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
      log.info("weekly event already on Discord; adopted it", {
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

  const eventUrl = guildScheduledEventUrl(deps.guildId, eventId);

  // What this pass did about the prep ping, or null if there was nothing to do.
  let prepOutcome: "prepared" | null = null;

  // The mission-maker ping, reconciled exactly like the announcement below: the
  // event link in that channel is the record a crashed pass left behind, so a
  // dropped `prepared_at` write costs a stamp, not a second ping.
  //
  // Not posted once the announce moment has passed: a pass catching up after the
  // worker was down through the prep moment would otherwise ask the mission makers
  // to edit the event before a deadline that is already behind them, and then ping
  // @everyone in the same breath. The announcement still goes out; `prepared_at`
  // stays null, because it records that they were asked and they were not.
  if (
    deps.prepChannelId && op.preparedAt === null && !plan.withinAnnounceWindow
  ) {
    if (await alreadyPosted(deps, deps.prepChannelId, eventUrl)) {
      log.info("mission-maker ping already present; not re-posting", {
        date: plan.saturdayDate,
        channel: deps.prepChannelId,
      });
    } else {
      await createMessage(deps.discord, deps.prepChannelId, {
        content: buildPrepContent(deps, eventUrl, plan.announceAt),
        // By id, not `parse: ["roles"]`: this names the one role that may be
        // notified rather than permitting whatever the content happens to hold.
        allowedMentions: {
          roles: deps.prepMentionRoleId ? [deps.prepMentionRoleId] : [],
        },
      });
      prepOutcome = "prepared";
      log.info("mission makers pinged to fill in the event", {
        date: plan.saturdayDate,
        channel: deps.prepChannelId,
      });
    }
    await markOperationPrepared(deps.db, op.id);
  }

  // The announcement is the one step gated on a second moment: the event has
  // existed since `prepareAt`, and the whole point of the lead is that the guild
  // is not pinged until the mission makers have had their day with it.
  if (!plan.withinAnnounceWindow) {
    return {
      outcome: prepOutcome ?? eventOutcome ?? "waiting",
      saturdayDate: plan.saturdayDate,
    };
  }

  if (op.announcedAt !== null) {
    return {
      outcome: prepOutcome ?? eventOutcome ?? "noop",
      saturdayDate: plan.saturdayDate,
    };
  }

  // Reconcile the announcement the same way. If a prior pass posted it but crashed
  // before recording announced_at, the event link is already in the channel: record
  // it and do NOT re-ping the whole guild.
  if (await alreadyPosted(deps, deps.announceChannelId, eventUrl)) {
    await markOperationAnnounced(deps.db, op.id);
    log.info("weekly event announcement already present; not re-posting", {
      date: plan.saturdayDate,
      channel: deps.announceChannelId,
    });
    return {
      outcome: prepOutcome ?? eventOutcome ?? "noop",
      saturdayDate: plan.saturdayDate,
    };
  }

  const content = await buildAnnouncementContent(deps, eventUrl);
  await createMessage(deps.discord, deps.announceChannelId, {
    content,
    allowedMentions: { parse: ["everyone"] },
  });
  await markOperationAnnounced(deps.db, op.id);
  log.info("weekly event announced", {
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
  deps: Pick<WeeklyEventDeps, "discord" | "guildId" | "imageDir" | "alert">,
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
      log.warn("event cover image rejected; retrying without it", {
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

  log.info("weekly event created", {
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

/** How many recent messages to scan for a prior post before posting. */
const ANNOUNCEMENT_SCAN_LIMIT = 50;

/**
 * Whether the channel already holds one of our posts for this event, found by the
 * event link it carries. Best-effort: if the history cannot be read (no Read
 * Message History permission, say), it returns false and the message is posted
 * anyway; the only thing forfeited is the guard against the rare double-post.
 *
 * One helper for both channels: the prep ping and the announcement carry the same
 * link and want the same guard, and a second copy would be a second place for the
 * "posted but not recorded" fix to land in one and miss the other.
 */
async function alreadyPosted(
  deps: Pick<WeeklyEventDeps, "discord">,
  channelId: string,
  eventUrl: string,
): Promise<boolean> {
  try {
    const recent = await listChannelMessages(
      deps.discord,
      channelId,
      ANNOUNCEMENT_SCAN_LIMIT,
    );
    return recent.some((m) => m.content.includes(eventUrl));
  } catch (error) {
    log.warn(
      "could not read channel history before posting; posting anyway",
      { channel: channelId, error: String(error) },
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
  /** The mission-maker ping text posted at the prep moment. */
  prepPing: string;
  /** The @everyone message text (the image rides on the event, not the message). */
  announcement: string;
}> {
  const plan = planWeeklyOp(now, deps.schedule);
  const title = opTitle(plan.attendanceStart, deps.schedule.timeZone);
  const cover = await chooseImage(deps);
  const eventUrl = guildScheduledEventUrl(deps.guildId, "<event-id>");
  const announcement = await buildAnnouncementContent(deps, eventUrl);
  return {
    plan,
    title,
    coverImageName: cover?.filename ?? null,
    prepPing: buildPrepContent(deps, eventUrl, plan.announceAt),
    announcement,
  };
}

/**
 * Build the mission-maker ping: the role mention, what is wanted and by when, then
 * the event link.
 *
 * It says nothing about @everyone in so many words, deliberately: the literal text
 * renders as a highlighted-looking mention that pings nobody (the `allowed_mentions`
 * on this post permits only the one role), and a ping-shaped thing that does not
 * ping is exactly the confusion not to post into a staff channel.
 *
 * The deadline goes in as a Discord timestamp, so every reader sees it in their own
 * timezone rather than in the unit's.
 */
function buildPrepContent(
  deps: Pick<WeeklyEventDeps, "prepMentionRoleId">,
  eventUrl: string,
  announceAt: Date,
): string {
  const mention = deps.prepMentionRoleId
    ? `<@&${deps.prepMentionRoleId}>`
    : "Mission makers";
  return [
    mention,
    `Saturday's op event is up. Set the mission and location on it before it goes ` +
    `out to the rest of the unit ${discordTimestamp(announceAt)}.`,
    eventUrl,
  ].join("\n\n");
}

/** Build the @everyone message: the ping, an optional witty message, the event link. */
async function buildAnnouncementContent(
  deps: Pick<WeeklyEventDeps, "textFile">,
  eventUrl: string,
): Promise<string> {
  const witty = await pickWittyMessage(deps);
  const paragraphs = ["@everyone"];
  if (witty) paragraphs.push(witty);
  // The URL on its own paragraph is what Discord unfurls into the event card, with
  // its cover banner and its native "Interested" button.
  paragraphs.push(eventUrl);
  return paragraphs.join("\n\n");
}

/**
 * A random witty message from the file, or undefined if unusable.
 *
 * Messages are blank-line-separated (`splitMessages`), so one may span several
 * lines and keep its own line breaks; those breaks are preserved into the Discord
 * message verbatim.
 */
async function pickWittyMessage(
  deps: Pick<WeeklyEventDeps, "textFile">,
): Promise<string | undefined> {
  if (!deps.textFile) return undefined;
  try {
    const messages = splitMessages(await Deno.readTextFile(deps.textFile));
    return pickRandom(messages, Math.random);
  } catch (error) {
    // Best-effort: a missing or unreadable file just means no witty message, not a
    // failed announcement.
    log.warn("could not read announcement text file", {
      path: deps.textFile,
      error: String(error),
    });
    return undefined;
  }
}

/** A random image from the folder, named only, or undefined if unusable. */
async function chooseImage(
  deps: Pick<WeeklyEventDeps, "imageDir">,
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
    log.warn("could not read announcement image folder", {
      dir: deps.imageDir,
      error: String(error),
    });
    return undefined;
  }
}

/** A random image from the folder, read into memory, or undefined if unusable. */
async function pickImage(
  deps: Pick<WeeklyEventDeps, "imageDir">,
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
    log.warn("could not read announcement image", {
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
        log.info(
          "weekly event (dry run): would create the event, ping the mission makers and announce",
          {
            date: preview.plan.saturdayDate,
            title: preview.title,
            location: EVENT_LOCATION,
            coverImage: preview.coverImageName,
            prepChannel: deps.prepChannelId ?? null,
            prepAt: preview.plan.prepareAt,
            prepPing: deps.prepChannelId ? preview.prepPing : null,
            announceAt: preview.plan.announceAt,
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
      log.error("weekly event pass failed", { error: String(error) });
      if (!pagedFailure) {
        pagedFailure = true;
        deps.alert("weekly event pass failed", error);
      }
    } finally {
      running = false;
    }
  };

  log.info("weekly event loop started", {
    intervalSeconds: opts.intervalSeconds,
    dryRun: opts.dryRun,
    timeZone: deps.schedule.timeZone,
    announceWeekday: deps.schedule.announceWeekday,
    announceTime: deps.schedule.announceTime,
    // Whether the mission makers get their day with the event is a mode of this
    // loop, like the dry run above: an operator reading one line has to be able to
    // see that the step is off rather than deduce it from a ping that never came.
    prepChannel: deps.prepChannelId ?? null,
    prepLeadDays: deps.schedule.prepLeadDays,
  });
  pass();
  const interval = setInterval(pass, opts.intervalSeconds * 1_000);
  return () => clearInterval(interval);
}
