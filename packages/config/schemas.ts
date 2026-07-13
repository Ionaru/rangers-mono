import { z } from "zod";
import { DEFAULT_ATTENDANCE_MIN_MINUTES } from "@7r/domain";

/**
 * The environment, grouped by concern (IMPLEMENTATION.md §2).
 *
 * Each service composes only the groups it actually uses, so Phase 1's web and
 * worker do not demand a TeamSpeak query password that nothing will read until
 * Phase 3. Adding a group to a service is the deliberate act of saying "this
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
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
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
 * Phase 2 (login) and Phase 4 (bot).
 *
 * All four app values come from ONE Discord application: 7R_Bot, ours, not the
 * legacy 2019 bot's (ADR 0015). DISCORD_CLIENT_ID is that application's id, so
 * it serves both the OAuth login and slash-command registration.
 */
export const discordSchema = z.object({
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_CLIENT_SECRET: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
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

/** Phase 3 (role sync) and Phase 5 (attendance sampling). */
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
  TS_OPERATIONS_CHANNEL_CID: int(),
  TS_BOT_NICKNAME: z.string().min(1).default("7R Bot"),
});
export type TeamspeakConfig = z.infer<typeof teamspeakSchema>;

/**
 * The worker's own internal HTTP server. It listens on the Compose network
 * only: never proxied, never public.
 *
 * Phase 2 adds WORKER_INTERNAL_TOKEN here, when there is finally something
 * behind it worth authenticating (the TeamSpeak link flow). Phase 1 serves only
 * an unauthenticated /healthz, and requiring a secret that nothing reads yet is
 * how a fail-loud config teaches people to fill it with junk.
 */
export const workerServerSchema = z.object({
  WORKER_INTERNAL_PORT: int().default(8080),
});
export type WorkerServerConfig = z.infer<typeof workerServerSchema>;

/** Phase 2. How web reaches the worker: the only coupling beyond the database. */
export const workerClientSchema = z.object({
  WORKER_INTERNAL_URL: z.url("must be an absolute URL"),
  WORKER_INTERNAL_TOKEN: z.string().min(1),
});
export type WorkerClientConfig = z.infer<typeof workerClientSchema>;

/** Phase 4 (the weekly event) and Phase 5 (attendance). Saturday only. */
export const opsSchema = z.object({
  OP_TIMEZONE: z.string().min(1).default("Europe/Amsterdam"),
  OP_WEEKLY_CRON: z.string().min(1).default("0 20 * * 6"),
  OP_ATTENDANCE_START: time().default("20:00"),
  OP_ATTENDANCE_END: time().default("23:00"),
  OP_EVENT_END: time().default("23:30"),
  ATTENDANCE_MIN_MINUTES: int().default(DEFAULT_ATTENDANCE_MIN_MINUTES),
  ATTENDANCE_SAMPLE_SECONDS: int().default(90),
});
export type OpsConfig = z.infer<typeof opsSchema>;

/** Phase 3. */
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

/** The worker posts its own errors here, so failures are visible without log-diving. */
export const alertSchema = z.object({
  ERROR_ALERT_DISCORD_WEBHOOK: z.url("must be an absolute URL"),
});
export type AlertConfig = z.infer<typeof alertSchema>;
