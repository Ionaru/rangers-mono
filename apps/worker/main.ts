import { getCoreConfig, getWorkerServerConfig } from "@7r/config";
import { closeDb, getDb, ping } from "@7r/db";

/**
 * The worker: one long-running Deno process.
 *
 * In Phase 1 it only proves it can boot, reach Postgres, and stay up. What it
 * grows into (ARCHITECTURE.md §2) is the process that holds the TeamSpeak
 * ServerQuery connection, reconciles server-groups, samples the Operations
 * channel, and creates the weekly Discord event.
 *
 * The two survival rules below exist now rather than later precisely because
 * they are about *that* future: by the time a dropped TeamSpeak connection can
 * hurt, the guard has to already be there.
 */

/**
 * Survival rule 1: an unhandled rejection must not kill the process.
 *
 * Deno's default is to exit. Once this process holds the ServerQuery
 * connection, a stray rejection anywhere would drop TeamSpeak sync and
 * attendance sampling with it. Log it, keep going.
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
  // Fails loud here, at the entry point, if the environment is not what we need.
  const core = getCoreConfig();
  const { WORKER_INTERNAL_PORT } = getWorkerServerConfig();
  const db = getDb();

  // Connectivity only. Deliberately not a query against a table: booting must
  // not depend on the schema being migrated, or a fresh deploy crash-loops the
  // worker until someone remembers to run the one-shot migrator.
  await ping(db);
  log("worker started", {
    logLevel: core.LOG_LEVEL,
    port: WORKER_INTERNAL_PORT,
  });

  /**
   * The internal API. Compose network only: never proxied, never public.
   * Phase 2 adds GET /internal/ts/clients and POST /internal/ts/poke behind
   * WORKER_INTERNAL_TOKEN; for now it is a health check and nothing else.
   */
  const server = Deno.serve({
    port: WORKER_INTERNAL_PORT,
    hostname: "0.0.0.0",
    onListen: () => {},
  }, async (request) => {
    const { pathname } = new URL(request.url);

    if (pathname !== "/healthz") {
      return new Response("not found", { status: 404 });
    }

    try {
      await ping(db);
      return Response.json({ ok: true, db: "up" });
    } catch (cause) {
      log("health check failed", { error: String(cause) });
      return Response.json({ ok: false, db: "down" }, { status: 503 });
    }
  });

  const heartbeat = setInterval(() => log("heartbeat"), HEARTBEAT_MS);

  /**
   * Survival rule 2: shut down cleanly on SIGTERM.
   *
   * Compose sends SIGTERM and waits out its kill timeout on every deploy if the
   * process does not go. Deno's event loop stays alive while ANY of these is
   * outstanding, and all four have bitten here already:
   *   - the heartbeat interval,
   *   - the HTTP server,
   *   - the signal listeners themselves (a registered listener is a live handle),
   *   - postgres.js's idle connection pool.
   * Releasing three of the four and wondering why the process hangs is a
   * genuinely miserable afternoon. Release all of them.
   */
  const onSignal = () => void shutdown();

  const shutdown = async () => {
    log("shutting down");
    clearInterval(heartbeat);
    Deno.removeSignalListener("SIGTERM", onSignal);
    Deno.removeSignalListener("SIGINT", onSignal);
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
  // *boot* failure too (a port already in use, a bad config) and leave a worker
  // that is up, silent, and doing nothing at all. Crash instead: Compose
  // restarts it, and the error is visible.
  try {
    await main();
  } catch (error) {
    console.error("[worker] fatal during startup:", error);
    Deno.exit(1);
  }
}
