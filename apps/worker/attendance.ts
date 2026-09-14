import {
  applySample,
  type ChannelSample,
  closeOpenSpans,
  type OpenSpan,
  type OpScheduleConfig,
  planWeeklyOp,
} from "@7r/domain";
import {
  closeAttendanceSessions,
  closeDanglingSessions,
  type Db,
  getOrCreateWeeklyOperation,
  listOpenAttendanceSessions,
  membersByTsUid,
  openAttendanceSessions,
  type Operation,
  recordAttendanceSample,
  renameAttendanceSessions,
  upsertOperationRsvps,
} from "@7r/db";
import {
  type DiscordRestOptions,
  listGuildScheduledEventUsers,
} from "@7r/discord";
import { getLogger, ROOT_CATEGORY } from "@7r/logging";
import {
  commandThrottleStats,
  listChannelClients,
  type TeamspeakConnection,
} from "@7r/teamspeak";

/**
 * Attendance sampling: the Operations channel, every ~90 seconds, for the three
 * hours an op runs (ADR 0007, IMPLEMENTATION §7).
 *
 * A reconciler on a timer, exactly like the weekly event job, and for the same
 * reason: what to do is recomputed from the clock and the database on every
 * tick, so restarts and missed ticks are ordinary rather than special. The
 * sampler's carried state (who is currently in the channel, since when) lives in
 * `attendance_session` rather than in this module, because an op runs for three
 * hours and a deploy in the middle of one must not lose it.
 *
 * **Attendance is a statistic and nothing else** (ADR 0010). Nothing here gates
 * anything; it fills in two read-only views and stops.
 */

const log = getLogger([ROOT_CATEGORY, "worker", "attendance"]);

export interface AttendanceDeps {
  db: Db;
  teamspeak: TeamspeakConnection;
  discord: DiscordRestOptions;
  guildId: string;
  /** The single Operations channel (TS_OPERATIONS_CHANNEL_CID). */
  operationsChannelCid: number;
  schedule: OpScheduleConfig;
  /** ATTENDANCE_SAMPLE_SECONDS. Also sets the restart gap threshold. */
  sampleSeconds: number;
  /** ATTENDANCE_RSVP_REFRESH_SECONDS. */
  rsvpRefreshSeconds: number;
  /** Threaded, unlike the logger: see `SyncDeps.alert` (sync.ts) and ADR 0019. */
  alert: (summary: string, detail?: unknown) => void;
}

/** Sample the Operations channel: one ServerQuery command, paced by the throttle. */
async function sampleChannel(
  deps: AttendanceDeps,
  at: Date,
): Promise<ChannelSample> {
  const clients = await listChannelClients(
    deps.teamspeak,
    deps.operationsChannelCid,
  );
  return {
    at,
    present: clients.map((c) => ({ uid: c.uid, nickname: c.nickname })),
  };
}

/**
 * Close every open span at the last instant we actually observed.
 *
 * The restart correction. An open span means "still here as far as we know", and
 * `creditedMinutes` reads a span with no `left_at` as running to the window's
 * end. So a worker that was down from 20:30 to 21:30 would, on its first tick
 * back, be sitting on spans that silently credit everybody for the hour it was
 * blind. Closing them at `last_sample_at` credits exactly what was seen and no
 * more; anyone still in the channel is re-opened by the very next diff, so the
 * only cost is a split span, and spans sum.
 *
 * The threshold is two sample intervals rather than one, so an ordinary deploy
 * (a few seconds of downtime) keeps spans whole instead of fragmenting every
 * member's evening on every release.
 */
async function closeSpansAcrossGap(
  deps: AttendanceDeps,
  op: Operation,
  open: readonly (OpenSpan & { id: string })[],
  now: Date,
): Promise<number> {
  if (open.length === 0) return 0;

  /**
   * Spans exist but no sample was ever stamped for this op, which means a pass
   * wrote its rows and then died before `recordAttendanceSample`. We have no
   * observation to close them at, so close them where they opened: zero credit
   * for a stretch nobody watched beats crediting all of it. Narrow (the window
   * between two statements) but it is the one case where "no last sample" does
   * not mean "no spans".
   */
  const lastSampleAt = op.lastSampleAt;
  if (lastSampleAt === null) {
    // Each at its own join instant, so each contributes zero minutes. Not one
    // shared instant: repeated crashes can leave spans opened at different
    // ticks, and closing a later one at an earlier span's join time would write
    // a row whose `left_at` precedes its `joined_at`.
    await Promise.all(
      open.map((span) =>
        closeAttendanceSessions(deps.db, [span.id], span.joinedAt)
      ),
    );
    log.warn("closed spans left by a pass that never recorded its sample", {
      operation: op.date,
      spans: open.length,
    });
    return open.length;
  }

  const gapMs = now.getTime() - lastSampleAt.getTime();
  if (gapMs <= deps.sampleSeconds * 2 * 1_000) return 0;

  const stale = closeOpenSpans(open, lastSampleAt);
  await closeAttendanceSessions(
    deps.db,
    stale.map((span) => span.id),
    lastSampleAt,
  );

  log.warn("closed open spans across a sampling gap", {
    operation: op.date,
    spans: stale.length,
    gapSeconds: Math.round(gapMs / 1_000),
    closedAt: lastSampleAt.toISOString(),
  });
  return stale.length;
}

/**
 * Capture the op event's Interested list, if it is due (ADR 0020).
 *
 * Returns the number of entries written, or null when nothing was due or there
 * was nothing to read.
 *
 * Failures here are swallowed into a warning on purpose, and this is the one
 * place in the pass that does that. The RSVP comparison is the decorative half
 * of a decorative feature; the attendance sample is the half that cannot be
 * recovered afterwards. Letting a 403 on the event-users endpoint (a missing
 * grant, which is a Phase 0 problem) throw would abandon the pass and lose the
 * sample with it, which is the wrong trade in every case.
 */
async function refreshRsvps(
  deps: AttendanceDeps,
  op: Operation,
  now: Date,
): Promise<number | null> {
  if (op.discordEventId === null) {
    log.warn("op has no Discord event, so no Interested list to capture", {
      operation: op.date,
    });
    return null;
  }

  const dueAt = op.rsvpRefreshedAt === null
    ? 0
    : op.rsvpRefreshedAt.getTime() + deps.rsvpRefreshSeconds * 1_000;
  if (now.getTime() < dueAt) return null;

  try {
    const subscribers = await listGuildScheduledEventUsers(
      deps.discord,
      deps.guildId,
      op.discordEventId,
    );
    await upsertOperationRsvps(
      deps.db,
      op.id,
      subscribers.map((s) => ({
        discordId: s.id,
        username: s.displayName ?? s.username,
      })),
      now,
    );
    log.info("captured the event's Interested list", {
      operation: op.date,
      interested: subscribers.length,
    });
    return subscribers.length;
  } catch (error) {
    log.warn("could not capture the event's Interested list", {
      operation: op.date,
      error: String(error),
    });
    return null;
  }
}

/**
 * One pass.
 *
 * Outside an op window it does one cheap thing: close anything a finished op
 * left open. That single statement is what closes everyone still in the channel
 * at 23:00 *and* what repairs a worker that was killed mid-op, so neither needs
 * its own code path and neither depends on this process having been alive at the
 * moment it mattered.
 *
 * Inside the window it samples, diffs, persists, and (occasionally) captures the
 * RSVP list.
 */
export async function runAttendancePass(
  deps: AttendanceDeps,
  now: Date = new Date(),
): Promise<void> {
  const plan = planWeeklyOp(now, deps.schedule);

  /**
   * **Not `plan.withinWindow`.** That flag closes at the op's *start*, because
   * Discord refuses to schedule an event whose start is already past
   * (`@7r/domain` ops.ts), which makes it false for the entire duration of the
   * op: exactly the stretch this loop cares about. The attendance window is its
   * own test.
   */
  const inWindow = now >= plan.attendanceStart && now < plan.attendanceEnd;

  if (!inWindow) {
    const swept = await closeDanglingSessions(deps.db);
    if (swept > 0) {
      log.info("closed spans left open by a finished op", { spans: swept });
    }
    return;
  }

  /**
   * Created here rather than waited for. The weekly event job creates the same
   * row (same pure plan, same unique `date`, so they converge), but it does so
   * only when `OP_EVENT_DRY_RUN` is false. Attendance must not silently stop
   * recording because somebody has not flipped an unrelated switch yet.
   */
  const op = await getOrCreateWeeklyOperation(deps.db, {
    date: plan.saturdayDate,
    attendanceStart: plan.attendanceStart,
    attendanceEnd: plan.attendanceEnd,
    eventEnd: plan.eventEnd,
  });

  const stored = await listOpenAttendanceSessions(deps.db, op.id);
  const open = stored.map((row) => ({
    id: row.id,
    tsUid: row.tsUid,
    tsNickname: row.tsNickname ?? "",
    joinedAt: row.joinedAt,
  }));

  const gapClosed = await closeSpansAcrossGap(deps, op, open, now);
  const carried = gapClosed > 0 ? [] : open;

  const throttleBefore = commandThrottleStats(deps.teamspeak);
  const sample = await sampleChannel(deps, now);
  const diff = applySample(carried, sample);

  /**
   * Only when somebody actually arrived. This loads every linked identity in the
   * unit, and on the large majority of ticks nobody joins or leaves, so calling
   * it unconditionally would be ~120 full reads of the member table per op to
   * resolve nothing.
   */
  const members = diff.opened.length > 0
    ? await membersByTsUid(deps.db)
    : new Map<string, { id: string }>();

  /**
   * Concurrent, not sequential: `applySample` partitions the tick's identities
   * into arrivals, departures and renames, so no two of these touch the same
   * row and none depends on another's result. Only the sample stamp below has
   * to wait for them.
   */
  await Promise.all([
    openAttendanceSessions(
      deps.db,
      op.id,
      diff.opened.map((span) => ({
        memberId: members.get(span.tsUid)?.id ?? null,
        tsUid: span.tsUid,
        tsNickname: span.tsNickname,
        joinedAt: span.joinedAt,
      })),
    ),
    closeAttendanceSessions(deps.db, diff.closed.map((span) => span.id), now),
    renameAttendanceSessions(
      deps.db,
      diff.renamed.map((span) => ({
        id: span.id,
        tsNickname: span.tsNickname,
      })),
    ),
  ]);

  // Only after the writes: this is the instant a later restart will close open
  // spans at, so it must never claim more than has actually been recorded.
  await recordAttendanceSample(deps.db, op.id, now);

  await refreshRsvps(deps, op, now);

  const guests = diff.opened.filter((span) => !members.has(span.tsUid)).length;
  log.info("sampled the Operations channel", {
    operation: op.date,
    // The spans open after the diff, not the raw client count: one identity
    // connected from two clients is one person present, and `applySample` has
    // already collapsed it. Reporting the raw number here would disagree with
    // every other count in the system.
    present: diff.open.length,
    opened: diff.opened.length,
    closed: diff.closed.length,
    guestsOpened: guests,
    // A per-pass delta, as the reconcile reports (sync.ts): the counter itself
    // is cumulative and only ever grows, so logging it raw would say nothing.
    // Pacing is invisible until it is not, and a Saturday where the sampler and
    // the reconcile contend for the command budget shows up here first.
    gateWaitMs: Math.round(
      commandThrottleStats(deps.teamspeak).waitedMs - throttleBefore.waitedMs,
    ),
  });
}

/**
 * The steady-state loop: one pass now, then every `intervalSeconds`, forever.
 *
 * There is deliberately **no dry-run flag**, unlike the sync and the weekly
 * event. Both of those write somewhere we do not own (TeamSpeak groups, an
 * @everyone ping), so a switch that says "compute but do not act" buys a real
 * first-run safety net. This writes only our own tables from read-only calls, so
 * the same switch would buy nothing and cost the failure ADR 0007 warns about:
 * shipped, never flipped, and nobody notices for two years, which is precisely
 * how the legacy recorder died in July 2024. The wrong-channel risk is real and
 * is answered by `deno task attendance:preview` instead, which is a check run
 * before the first Saturday rather than a switch somebody has to remember.
 */
export function startAttendanceLoop(
  deps: AttendanceDeps,
  opts: { intervalSeconds: number },
): () => void {
  let running = false;

  /**
   * A failed sample is not news; a run of them is. Same leaky bucket as the sync
   * loop (sync.ts), and for the same reason: TeamSpeak drops and reconnects, and
   * a single missed sample costs at most 90 seconds of resolution on a
   * 60-minute threshold. Every failure is still logged immediately.
   *
   * Unlike the sync loop there is no "permanent failure" fast path. The two
   * errors that never fix themselves there are a revoked bot token and a missing
   * intent; here the Discord half is already swallowed into a warning
   * (`refreshRsvps`), so anything that reaches this catch came from TeamSpeak or
   * the database, where the honest answer is to wait and see.
   */
  const FAILURE_ALERT_AT = 3;
  let failureScore = 0;
  let pagedFailure = false;

  /** A pass that hangs never throws, so it would otherwise silence every tick after it. */
  const STALL_ALERT_AFTER = 3;
  let skippedTicks = 0;
  let pagedStall = false;

  const pass = async () => {
    if (running) {
      skippedTicks++;
      log.warn("attendance pass still running, skipping this tick", {
        skippedTicks,
      });
      if (skippedTicks >= STALL_ALERT_AFTER && !pagedStall) {
        pagedStall = true;
        deps.alert(
          "attendance sampling appears stuck",
          `A pass has been running for more than ${skippedTicks} intervals and every tick since has been skipped. ` +
            `If an op is running now, it is not being recorded. The usual cause is a ServerQuery command that ` +
            `will never answer, which a worker restart clears.`,
        );
      }
      return;
    }
    running = true;
    skippedTicks = 0;
    pagedStall = false;

    try {
      await runAttendancePass(deps);
      failureScore = Math.max(0, failureScore - 1);
      if (pagedFailure && failureScore === 0) {
        pagedFailure = false;
        deps.alert(
          "attendance sampling recovered",
          "A pass completed normally again.",
        );
      }
    } catch (error) {
      failureScore++;
      log.error("attendance pass failed", {
        error: String(error),
        failureScore,
      });
      if (!pagedFailure && failureScore >= FAILURE_ALERT_AT) {
        pagedFailure = true;
        deps.alert("attendance sampling failing", error);
      }
    } finally {
      running = false;
    }
  };

  log.info("attendance loop started", {
    intervalSeconds: opts.intervalSeconds,
    operationsChannelCid: deps.operationsChannelCid,
  });
  pass();
  const interval = setInterval(pass, opts.intervalSeconds * 1_000);
  return () => clearInterval(interval);
}
