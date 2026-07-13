import {
  listClients,
  pokeClient,
  type TeamspeakConnection,
} from "@7r/teamspeak";
import { type Db, listLinkedTsUids, ping } from "@7r/db";

/**
 * The worker's internal HTTP API. The Compose network only: never proxied, never
 * public (ARCHITECTURE §2, and compose.yaml publishes no port for this service).
 *
 * It exists for exactly one reason. The TeamSpeak link flow needs live access to
 * the ServerQuery connection, and that connection is stateful and singular, so
 * it lives in the worker. The website cannot hold it, so it asks. This is the
 * only coupling between the two services beyond the database, and it is
 * deliberately synchronous: if the worker is down, linking fails loudly rather
 * than hanging or, worse, quietly pretending nobody is online.
 */

export interface InternalApiDeps {
  db: Db;
  teamspeak: TeamspeakConnection;
  token: string;
  log: (message: string, extra?: Record<string, unknown>) => void;
  alert: (summary: string, detail?: unknown) => void;
}

/**
 * Compare two secrets without leaking their contents through how long it took.
 *
 * `a === b` on strings short-circuits at the first differing byte, so the time
 * it takes is a function of how many leading characters an attacker got right.
 * Over enough requests on a network they control, that recovers the token one
 * character at a time. This compares every byte, always.
 *
 * The length check leaks the length, which is not a secret worth protecting.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length), token);
}

export function createInternalApiHandler(
  deps: InternalApiDeps,
): (request: Request) => Promise<Response> {
  const { db, teamspeak, token, log, alert } = deps;

  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);

    // Unauthenticated, and it must stay that way: this is what Compose's
    // healthcheck calls, and a healthcheck that needs a secret is a healthcheck
    // that reports "unhealthy" when the secret is wrong.
    if (pathname === "/healthz") {
      try {
        await ping(db);
        return Response.json({ ok: true, db: "up" });
      } catch (cause) {
        log("health check failed", { error: String(cause) });
        return Response.json({ ok: false, db: "down" }, { status: 503 });
      }
    }

    if (!pathname.startsWith("/internal/")) {
      return new Response("not found", { status: 404 });
    }

    if (!authorized(request, token)) {
      // No detail, and no hint about which half was wrong.
      return new Response("unauthorized", { status: 401 });
    }

    try {
      if (pathname === "/internal/ts/clients" && request.method === "GET") {
        return await handleClients(deps);
      }

      if (pathname === "/internal/ts/poke" && request.method === "POST") {
        return await handlePoke(request, teamspeak);
      }
    } catch (cause) {
      // A ServerQuery call blew up. The website is waiting on this, so answer
      // it, but make sure the failure is visible: the member sees "TeamSpeak is
      // unreachable" and somebody needs to know why.
      log("internal api failed", { pathname, error: String(cause) });
      alert(`internal api ${pathname} failed`, cause);
      return Response.json(
        { error: "teamspeak_unavailable" },
        { status: 502 },
      );
    }

    return new Response("not found", { status: 404 });
  };
}

/**
 * The clients a member may claim as themselves: online, real people, and not
 * already linked to somebody.
 *
 * Filtering out the taken identities here rather than in the browser is what
 * stops the pick-list being an invitation to claim a teammate's identity. It is
 * not the *guarantee* (that is the poke, which goes to whoever they picked, plus
 * the unique constraint on member.ts_uid), but it means the mistake is not
 * offered in the first place.
 */
async function handleClients(deps: InternalApiDeps): Promise<Response> {
  const { db, teamspeak } = deps;

  const [online, linked] = await Promise.all([
    listClients(teamspeak),
    listLinkedTsUids(db),
  ]);

  const taken = new Set(linked);
  const available = online.filter((client) => !taken.has(client.uid));

  return Response.json({ clients: available });
}

/** Poke a code at the connection the member picked. */
async function handlePoke(
  request: Request,
  teamspeak: TeamspeakConnection,
): Promise<Response> {
  const body = await request.json().catch(() => null) as
    | { clid?: unknown; message?: unknown }
    | null;

  const clid = typeof body?.clid === "string" ? body.clid : null;
  const message = typeof body?.message === "string" ? body.message : null;

  if (!clid || !message) {
    return Response.json(
      { error: "clid and message are required" },
      { status: 400 },
    );
  }

  await pokeClient(teamspeak, clid, message);
  return Response.json({ ok: true });
}
