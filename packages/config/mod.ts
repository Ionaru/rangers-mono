import { loadConfig, memoize } from "./load.ts";
import {
  alertSchema,
  coreSchema,
  databaseSchema,
  discordSchema,
  steamSchema,
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
 * Phase 2 (the Discord login) and Phase 4 (the bot). One application, `7R_Bot`:
 * see the schema.
 */
export const getDiscordConfig = memoize(() => loadConfig(discordSchema));

/** Phase 2. Steam OpenID is stateless, so this is one URL and nothing else. */
export const getSteamConfig = memoize(() => loadConfig(steamSchema));

/** Phase 2. How `web` reaches the worker: the only coupling beyond the database. */
export const getWorkerClientConfig = memoize(() =>
  loadConfig(workerClientSchema)
);

/** Phase 2 (the poke-link flow) and Phase 3 (the reconcile). Worker only. */
export const getTeamspeakConfig = memoize(() => loadConfig(teamspeakSchema));

/** The worker posts its own errors here, so a failure is visible without log-diving. */
export const getAlertConfig = memoize(() => loadConfig(alertSchema));
