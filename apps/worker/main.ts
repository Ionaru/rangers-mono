import {
  type AlertConfig,
  type CoreConfig,
  getAlertConfig,
  getCoreConfig,
  getTeamspeakConfig,
  getWorkerServerConfig,
  loadAll,
  type TeamspeakConfig,
  type WorkerServerConfig,
} from "@7r/config";
import { closeDb, getDb, ping } from "@7r/db";
import { connectTeamspeak, keepConnected } from "@7r/teamspeak";
import { makeAlerter } from "./alert.ts";
import { createInternalApiHandler } from "./internal-api.ts";

/**
 * The worker: one long-running Deno process.
 *
 * It holds the TeamSpeak ServerQuery connection, which is the reason it exists:
 * the connection is stateful and singular, so exactly one process may own it,
 * and the website asks that process questions over the internal API rather than
 * opening a second one (ARCHITECTURE §2).
 *
 * From Phase 2 it serves the identity link flow. What it grows into is the
 * group reconcile (Phase 3), the weekly Discord event (Phase 4) and the
 * Operations-channel sampling (Phase 5), all on this same connection.
 */

/**
 * Survival rule 1: an unhandled rejection must not kill the process.
 *
 * Deno's default is to exit. This process holds the ServerQuery connection, so a
 * stray rejection anywhere would drop TeamSpeak linking, and later the sync and
 * the attendance sampling with it. Log it, keep going.
 */
addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  console.error("[worker] unhandled rejection (continuing):", event.reason);
});

const HEARTBEAT_MS = 60_000;

function log(message: string, extra: Record<string, unknown> = {}) {
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), msg: message, ...extra }),
  );
}

async function main() {
  /**
   * Fails loud here, at the entry point, if the environment is not what we need,
   * and names EVERY missing value rather than the first one.
   *
   * The worker needs four separate groups of config, and one group per restart
   * is how setting a box up turns into an afternoon: fix WORKER_INTERNAL_TOKEN,
   * redeploy, be told about TS_QUERY_HOST, redeploy, be told about
   * TS_QUERY_PASS. `loadAll` collects them.
   */
  const [core, workerServer, ts, alerts] = loadAll<
    [CoreConfig, WorkerServerConfig, TeamspeakConfig, AlertConfig]
  >([getCoreConfig, getWorkerServerConfig, getTeamspeakConfig, getAlertConfig]);

  const { WORKER_INTERNAL_PORT, WORKER_INTERNAL_TOKEN } = workerServer;
  const { ERROR_ALERT_DISCORD_WEBHOOK } = alerts;

  const db = getDb();
  const alert = makeAlerter(ERROR_ALERT_DISCORD_WEBHOOK, log);

  // Connectivity only. Deliberately not a query against a table: booting must
  // not depend on the schema being migrated, or a fresh deploy crash-loops the
  // worker until someone remembers to run the one-shot migrator.
  await ping(db);

  /**
   * The TeamSpeak connection, and a boot failure here is FATAL, on purpose.
   *
   * Both of this worker's routes need it, so a worker that is up without it is a
   * worker that can only return errors, while Compose reports it healthy and
   * nobody is told. Crash instead: Compose restarts it, and the reason is in the
   * logs. A connection that drops *later* is a different matter and must not
   * kill anything (keepConnected reconnects indefinitely).
   */
  const teamspeak = await connectTeamspeak({
    host: ts.TS_QUERY_HOST,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
    virtualServerId: ts.TS_VIRTUALSERVER_ID,
    nickname: ts.TS_BOT_NICKNAME,
  });
  keepConnected(teamspeak, log);

  log("worker started", {
    logLevel: core.LOG_LEVEL,
    port: WORKER_INTERNAL_PORT,
    teamspeak: `${ts.TS_QUERY_HOST}:${ts.TS_QUERY_PORT}`,
  });

  const server = Deno.serve(
    {
      port: WORKER_INTERNAL_PORT,
      hostname: "0.0.0.0",
      onListen: () => {},
    },
    createInternalApiHandler({
      db,
      teamspeak,
      token: WORKER_INTERNAL_TOKEN,
      log,
      alert,
    }),
  );

  const heartbeat = setInterval(() => log("heartbeat"), HEARTBEAT_MS);

  /**
   * Survival rule 2: shut down cleanly on SIGTERM.
   *
   * Compose sends SIGTERM and waits out its kill timeout on every deploy if the
   * process does not go. Deno's event loop stays alive while ANY of these is
   * outstanding, and all of them have bitten here already:
   *   - the heartbeat interval,
   *   - the HTTP server,
   *   - the signal listeners themselves (a registered listener is a live handle),
   *   - postgres.js's idle connection pool,
   *   - and now the ServerQuery socket, which keepalives and so will never close
   *     itself.
   * Releasing all but one and wondering why the process hangs is a genuinely
   * miserable afternoon. Release all of them.
   */
  const onSignal = () => void shutdown();

  const shutdown = async () => {
    log("shutting down");
    clearInterval(heartbeat);
    Deno.removeSignalListener("SIGTERM", onSignal);
    Deno.removeSignalListener("SIGINT", onSignal);
    // forceQuit, not quit: `quit` is a round-trip to a server that may be the
    // very thing that is wedged, and we are leaving regardless. It also stops
    // the "close" handler racing us into a reconnect on the way out.
    teamspeak.removeAllListeners();
    teamspeak.forceQuit();
    await server.shutdown();
    await closeDb();
  };

  Deno.addSignalListener("SIGTERM", onSignal);
  Deno.addSignalListener("SIGINT", onSignal);

  await server.finished;
  log("stopped");
}

if (import.meta.main) {
  // Startup failures are fatal, and must stay fatal. The unhandledrejection
  // guard above deliberately swallows stray rejections so a passing error never
  // drops the TeamSpeak connection, but without this catch it would swallow a
  // *boot* failure too (a port already in use, a bad config, TeamSpeak refusing
  // the login) and leave a worker that is up, silent, and doing nothing at all.
  // Crash instead: Compose restarts it, and the error is visible.
  try {
    await main();
  } catch (error) {
    console.error("[worker] fatal during startup:", error);
    Deno.exit(1);
  }
}
