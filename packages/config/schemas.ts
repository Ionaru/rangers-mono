import { z } from "zod";
import { DEFAULT_ATTENDANCE_MIN_MINUTES } from "@7r/domain";
import { LOG_LEVELS } from "@7r/logging";

/**
 * The environment, grouped by concern (IMPLEMENTATION.md §2).
 *
 * Each service composes only the groups it actually uses, so Phase 1's web and
 * worker do not demand a TeamSpeak query password that nothing will read until
 * Phase 4. Adding a group to a service is the deliberate act of saying "this
 * service now needs TeamSpeak".
 */

/** Env vars arrive as strings, so every non-string field converts explicitly. */
const int = () =>
  z.string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number);

const bool = () =>
  z.enum(["true", "false"], { message: 'must be "true" or "false"' })
    .transform((v) => v === "true");

const time = () =>
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a HH:MM time");

const csv = () =>
  z.string()
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.string()).min(1, "must list at least one id"));

/**
 * A database and nothing else. The migrator needs exactly this: it is a
 * one-shot that opens a connection, applies SQL, and exits. Making it demand a
 * PUBLIC_BASE_URL it never reads is how a fail-loud config trains people to
 * fill variables with junk to get past it.
 */
export const databaseSchema = z.object({
  DATABASE_URL: z.string().regex(
    /^postgres(ql)?:\/\//,
    "must be a postgres:// connection string",
  ),
});
export type DatabaseConfig = z.infer<typeof databaseSchema>;

/** What any long-running service needs: a database and a log level. */
export const coreSchema = databaseSchema.extend({
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
});
export type CoreConfig = z.infer<typeof coreSchema>;

/**
 * The website. It additionally needs to know where it lives, because Phase 2's
 * Discord OAuth and Steam OpenID both hand that URL to a third party to
 * redirect back to.
 */
export const webSchema = coreSchema.extend({
  PUBLIC_BASE_URL: z.url("must be an absolute URL"),
});
export type WebConfig = z.infer<typeof webSchema>;

/**
 * The guild and the bot token, and nothing else: what anything that talks to
 * Discord *as the bot* needs. Phase 4's member poll runs in the worker, and
 * "every loader asks for exactly what its caller reads" means the worker must
 * not be forced to carry a client secret and a session key it never touches.
 */
export const discordBotSchema = z.object({
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
});
export type DiscordBotConfig = z.infer<typeof discordBotSchema>;

/**
 * Phase 2 (login) and Phase 5 (bot).
 *
 * All four app values come from ONE Discord application: 7R_Bot, ours, not the
 * legacy 2019 bot's (ADR 0015). DISCORD_CLIENT_ID is that application's id, so
 * it serves both the OAuth login and slash-command registration.
 */
export const discordSchema = discordBotSchema.extend({
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  /**
   * Ed25519 verify key for the interactions endpoint. Per-application: it must
   * come from the same application as DISCORD_BOT_TOKEN, or every interaction
   * 401s and Discord silently removes the endpoint URL (ADR 0003).
   */
  DISCORD_PUBLIC_KEY: z.string().min(1),
  /** Admin is a single boolean derived from these role ids. No RBAC (ADR 0009). */
  DISCORD_ADMIN_ROLE_IDS: csv(),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
});
export type DiscordConfig = z.infer<typeof discordSchema>;

/** Phase 2. Steam OpenID is stateless, so no API key is needed to log in. */
export const steamSchema = z.object({
  STEAM_REALM: z.url("must be an absolute URL"),
});
export type SteamConfig = z.infer<typeof steamSchema>;

/**
 * The ServerQuery connection itself. Phase 2 (the poke-link flow) onwards.
 *
 * This arrives a phase earlier than the docs' `(Phases 3 & 5)` labelling
 * suggests, and deliberately: the TeamSpeak link flow needs a *live*
 * ServerQuery connection to list the online clients and poke one of them
 * (IMPLEMENTATION §4). There is no way to build identity linking without it, so
 * the transport lands here and Phase 4 adds only the reconcile on top.
 */
export const teamspeakSchema = z.object({
  TS_QUERY_HOST: z.string().min(1),
  /**
   * SSH ServerQuery, and it is never 10011. TeamSpeak is reached across the
   * public internet, so raw ServerQuery would put the query password in
   * cleartext on the wire at every reconnect (ADR 0002 / §4.4).
   */
  TS_QUERY_PORT: int().pipe(
    z.number().refine((p) => p !== 10011, {
      message:
        "must not be 10011: raw ServerQuery is cleartext and this host is public",
    }),
  ),
  TS_QUERY_USER: z.string().min(1),
  TS_QUERY_PASS: z.string().min(1),
  TS_VIRTUALSERVER_ID: int(),
  TS_BOT_NICKNAME: z.string().min(1).default("7R Bot"),
});
export type TeamspeakConfig = z.infer<typeof teamspeakSchema>;

/**
 * Phase 6. Split out of `teamspeakSchema` on purpose: the Operations channel is
 * an *attendance* concept, and nothing in the link flow has any use for it.
 * Folded in, it would force whoever sets up linking to invent a channel id to
 * get past a fail-loud config, which is exactly the habit this package exists
 * to prevent.
 */
export const attendanceChannelSchema = z.object({
  TS_OPERATIONS_CHANNEL_CID: int(),
});
export type AttendanceChannelConfig = z.infer<typeof attendanceChannelSchema>;

/**
 * The worker's own internal HTTP server. It listens on the Compose network
 * only: never proxied, never public.
 */
export const workerServerSchema = z.object({
  WORKER_INTERNAL_PORT: int().default(8080),
  /**
   * The other half of `workerClientSchema`'s token: web sends it, the worker
   * checks it. Required now (Phase 2) rather than optional, because there is
   * finally something behind it worth authenticating. An unauthenticated
   * /internal/ts/poke is a way to spray a link code at any client on the
   * server.
   */
  WORKER_INTERNAL_TOKEN: z.string().min(1),
});
export type WorkerServerConfig = z.infer<typeof workerServerSchema>;

/** Phase 2. How web reaches the worker: the only coupling beyond the database. */
export const workerClientSchema = z.object({
  WORKER_INTERNAL_URL: z.url("must be an absolute URL"),
  WORKER_INTERNAL_TOKEN: z.string().min(1),
});
export type WorkerClientConfig = z.infer<typeof workerClientSchema>;

/**
 * Phase 6. The credit rule's threshold, and nothing else.
 *
 * Its own schema because of where it is *read*: credit is computed on read
 * (IMPLEMENTATION §7), so the thing that needs this number is `apps/web`
 * rendering an attendance view, not the worker taking samples. Folded into
 * `opsSchema` it would drag `OP_ANNOUNCE_CHANNEL_ID` (required, worker-only)
 * onto the website, which is exactly the coupling "every loader asks for what
 * its caller reads" exists to prevent. `opsSchema` extends it, so the key is
 * defined once and the two cannot drift.
 */
export const attendanceCreditSchema = z.object({
  ATTENDANCE_MIN_MINUTES: int().default(DEFAULT_ATTENDANCE_MIN_MINUTES),
});
export type AttendanceCreditConfig = z.infer<typeof attendanceCreditSchema>;

/** Phase 5 (the weekly event) and Phase 6 (attendance). Saturday only. */
export const opsSchema = attendanceCreditSchema.extend({
  OP_TIMEZONE: z.string().min(1).default("Europe/Amsterdam"),
  /** Event/attendance start, the op's mission time (20:00 local). */
  OP_ATTENDANCE_START: time().default("20:00"),
  OP_ATTENDANCE_END: time().default("23:00"),
  /** Discord event end, past the mission to cover debrief (23:30 local). */
  OP_EVENT_END: time().default("23:30"),
  ATTENDANCE_SAMPLE_SECONDS: int().default(90),
  /**
   * How often, during the op, the Discord event's Interested list is re-read
   * into `operation_rsvp` (ADR 0020).
   *
   * Much coarser than the presence sample because it answers a much coarser
   * question: whether somebody said they were coming, not when. Fifteen minutes
   * over a three-hour op is about a dozen REST calls, which also means a worker
   * that boots at 20:40 still captures a list rather than losing the op's RSVP
   * data entirely.
   */
  ATTENDANCE_RSVP_REFRESH_SECONDS: int().default(900),

  // --- weekly event creation + announcement (Phase 5) ---

  /** The #arma_general channel the @everyone announcement is posted to. */
  OP_ANNOUNCE_CHANNEL_ID: z.string().min(1),
  /**
   * The weekday the event is created and announced, ahead of the Saturday op.
   * 0 = Sunday .. 6 = Saturday; default 3 = Wednesday.
   */
  OP_ANNOUNCE_WEEKDAY: int()
    .pipe(z.number().int().min(0).max(6))
    .default(3),
  /** The local time on that weekday to fire (18:00). */
  OP_ANNOUNCE_TIME: time().default("18:00"),
  /**
   * The mission-maker channel the event is posted to ahead of the announcement,
   * so the mission and location can be filled in on it before the guild is
   * pinged.
   *
   * Optional, and it is the switch for the whole prep step: unset, the worker
   * behaves exactly as it did before (create the event and announce it in the
   * same pass at the announce moment). Set, the event is created
   * `OP_PREP_LEAD_DAYS` earlier and this channel is pinged then.
   */
  OP_PREP_CHANNEL_ID: z.string().min(1).optional(),
  /**
   * The role mentioned in that prep ping (the Mission maker role). Unset -> the
   * message is posted without a mention, which notifies nobody: it is worth
   * setting. Mentioning a role that is not "allow anyone to @mention" in Discord
   * needs the bot's Mention @everyone permission in the channel.
   */
  OP_PREP_MENTION_ROLE_ID: z.string().min(1).optional(),
  /**
   * How many days before the announce moment the event is created and the prep
   * ping posted, at the same local time (1 = the day before). Only read when
   * OP_PREP_CHANNEL_ID is set.
   */
  OP_PREP_LEAD_DAYS: int()
    .pipe(z.number().int().min(0).max(6))
    .default(1),
  /**
   * Optional path to a UTF-8 file of witty announcement messages, blank-line
   * separated (a message may span multiple lines), one picked at random. Unset (or
   * empty/missing) -> no witty message.
   *
   * Named `_PATH`, not `_FILE`, deliberately: a `*_FILE` key is reserved by the
   * secret-file convention (load.ts `resolveSecretFiles`), which would try to READ
   * the file at boot and set `OP_ANNOUNCE_TEXT` from it, failing wherever the file
   * is not mounted (the web container has no assets mount). See the guard test.
   */
  OP_ANNOUNCE_TEXT_PATH: z.string().min(1).optional(),
  /**
   * Optional path to a directory of images (PNG/JPG/GIF), one picked at random and
   * used as the Discord event's cover banner. Unset (or empty/no images) -> no
   * cover. Must be readable by the worker (mount it into the container).
   */
  OP_ANNOUNCE_IMAGE_DIR: z.string().min(1).optional(),
  /**
   * Starts true, like SYNC_DRY_RUN. While true the weekly job computes and logs
   * what it would create and post but writes nothing and calls no Discord
   * endpoint. Flip to false to go live (the first live pass @everyone-pings the
   * whole guild, so review a dry-run first).
   */
  OP_EVENT_DRY_RUN: bool().default(true),
});
export type OpsConfig = z.infer<typeof opsSchema>;

/** Phase 4. */
export const syncSchema = z.object({
  ROLE_SYNC_INTERVAL_SECONDS: int().default(300),
  /** Starts true. Flip it only after a preview looks right (ADR 0009). */
  SYNC_DRY_RUN: bool().default(true),
  /**
   * The blast-radius guard. A pass that would remove owned groups from more
   * than this many members halts and applies nothing. Normal operation touches
   * 0-2 people, so a mass removal is definitionally a bug. Standing guard, not
   * a first-run check.
   */
  SYNC_MAX_REMOVALS: int().default(5),
});
export type SyncConfig = z.infer<typeof syncSchema>;

/**
 * The worker posts its own errors here, so failures are visible without
 * log-diving.
 *
 * Optional, unlike every other secret in this file. A missing webhook costs
 * visibility, not correctness: the worker logs to stdout and carries on. Making
 * it required would mean a worker that refuses to boot because nobody has
 * created a Discord webhook yet, which is precisely how people learn to paste
 * junk into a fail-loud config to get past it.
 */
export const alertSchema = z.object({
  ERROR_ALERT_DISCORD_WEBHOOK: z.url("must be an absolute URL").optional(),
});
export type AlertConfig = z.infer<typeof alertSchema>;
