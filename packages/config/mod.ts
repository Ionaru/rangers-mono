import { loadConfig, memoize } from "./load.ts";
import {
  coreSchema,
  databaseSchema,
  webSchema,
  workerServerSchema,
} from "./schemas.ts";

export * from "./load.ts";
export * from "./schemas.ts";

/**
 * The configuration Phase 1's services need. Each loader asks for exactly what
 * its caller reads, and no more.
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
