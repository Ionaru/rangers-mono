import type { APIRoute } from "astro";
import { getDb, ping } from "@7r/db";

export const prerender = false;

/**
 * The health check, and the proof that the monorepo works.
 *
 * The point of this route is not health. It is that `apps/web` resolves,
 * bundles and executes `@7r/db` (a workspace package shipped as raw
 * TypeScript), which is the one thing ADR 0006's whole justification rests on:
 * a shared domain/db layer consumed by *both* the website and the worker. If
 * Astro's bundler cannot follow this import, the monorepo buys nothing and we
 * want to know on day one, not in Phase 2.
 *
 * Connectivity only, like the worker's. Deliberately not a query against a
 * table: Compose wires this route to the container healthcheck, and migrations
 * are a one-shot profile, so a route that reads `member` reports the container
 * unhealthy on any `up` that runs before the migrator. `ping()` already proves
 * the bundling edge this route exists for.
 */
export const GET: APIRoute = async () => {
  try {
    await ping(getDb());
    return Response.json({ ok: true, db: "up" });
  } catch (cause) {
    console.error("[web] health check failed:", cause);
    return Response.json({ ok: false, db: "down" }, { status: 503 });
  }
};
