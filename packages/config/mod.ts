import { loadConfig, memoize } from "./load.ts";
import {
  alertSchema,
  attendanceChannelSchema,
  attendanceCreditSchema,
  coreSchema,
  databaseSchema,
  discordBotSchema,
  discordSchema,
  opsSchema,
  steamSchema,
  syncSchema,
  teamspeakSchema,
  webSchema,
  workerClientSchema,
  workerServerSchema,
} from "./schemas.ts";

export * from "./load.ts";
export * from "./schemas.ts";

/**
 * The configuration each service needs. Every loader asks for exactly what its
 * caller reads, and no more: that is what lets the worker boot without a Steam
 * realm, and the migrator boot without any of it.
 *
 * All of them are lazy on purpose. `astro build` executes module code, and
 * neither the build nor CI has a DATABASE_URL, so parsing at module scope would
 * turn a missing production secret into a failed build. Call these from a
 * request handler or from a service's entry point, where an exception is the
 * fail-loud you actually want.
 */
export const getDatabaseConfig = memoize(() => loadConfig(databaseSchema));

export const getCoreConfig = memoize(() => loadConfig(coreSchema));

export const getWebConfig = memoize(() => loadConfig(webSchema));

export const getWorkerServerConfig = memoize(() =>
  loadConfig(workerServerSchema)
);

/**
 * Phase 2 (the Discord login) and Phase 5 (the bot). One application, `7R_Bot`:
 * see the schema.
 */
export const getDiscordConfig = memoize(() => loadConfig(discordSchema));

/** Phase 4. The worker's guild poll: the bot token and the guild, nothing more. */
export const getDiscordBotConfig = memoize(() => loadConfig(discordBotSchema));

/** Phase 4: the reconcile loop, its dry-run switch, and the blast-radius guard. */
export const getSyncConfig = memoize(() => loadConfig(syncSchema));

/** Phase 5 (the weekly event + announcement) and Phase 6 (attendance). Worker only. */
export const getOpsConfig = memoize(() => loadConfig(opsSchema));

/**
 * Phase 6. The attendance credit threshold, for `apps/web`: credit is computed
 * on read, so the website is what needs the number. Deliberately not
 * `getOpsConfig`, which would make the site require the worker's announce
 * channel to render a page.
 */
export const getAttendanceCreditConfig = memoize(() =>
  loadConfig(attendanceCreditSchema)
);

/** Phase 2. Steam OpenID is stateless, so this is one URL and nothing else. */
export const getSteamConfig = memoize(() => loadConfig(steamSchema));

/** Phase 2. How `web` reaches the worker: the only coupling beyond the database. */
export const getWorkerClientConfig = memoize(() =>
  loadConfig(workerClientSchema)
);

/** Phase 2 (the poke-link flow) and Phase 4 (the reconcile). Worker only. */
export const getTeamspeakConfig = memoize(() => loadConfig(teamspeakSchema));

/**
 * Phase 6. The one Operations channel the attendance sampler reads. Worker only,
 * and separate from `getTeamspeakConfig` for the reason the schema gives: it is
 * an attendance concept, and folding it into the transport config would make
 * whoever sets up linking invent a channel id to get past a fail-loud boot.
 */
export const getAttendanceChannelConfig = memoize(() =>
  loadConfig(attendanceChannelSchema)
);

/** The worker posts its own errors here, so a failure is visible without log-diving. */
export const getAlertConfig = memoize(() => loadConfig(alertSchema));
