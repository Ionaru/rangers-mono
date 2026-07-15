import type { APIRoute } from "astro";
import { createLinkCode, getDb } from "@7r/db";
import { CODE_TTL_MS, generateLinkCode, pokeMessage } from "@7r/identity";
import { redirectWith, sameOriginGuard } from "../../../lib/forms.ts";
import {
  fetchOnlineClients,
  pokeLinkCode,
  WorkerUnavailableError,
} from "../../../lib/worker-client.ts";

/**
 * Step 2 of the link flow: the member picked somebody, so poke a code at them.
 *
 * The `clid` is a *connection* id, and it is ephemeral: it belongs to that
 * TeamSpeak connection and dies when they disconnect. So the online list is
 * re-fetched here rather than trusting the one the browser posted back. That
 * closes the obvious hole (a member editing the form to name a `clid` that was
 * never offered to them) and also the boring one (they left the page open for an
 * hour and everyone's clid has changed).
 *
 * What is stored is the `uid`, the durable identity, resolved from that fresh
 * list. The poke goes to the `clid`. Those being two different things is the
 * heart of the flow.
 */
export const POST: APIRoute = async ({ request, locals }) => {
  const blocked = sameOriginGuard(request);
  if (blocked) return blocked;

  const member = locals.member!;
  const form = await request.formData();
  const clid = form.get("clid");

  if (typeof clid !== "string" || !clid) {
    return redirectWith("/link/teamspeak", { error: "no_pending" });
  }

  try {
    // Re-fetch, and only accept a clid that is genuinely online AND genuinely
    // unlinked right now. The worker already filters out linked identities, so
    // a clid that is missing from this list is one the member may not claim.
    const online = await fetchOnlineClients();
    const picked = online.find((client) => client.clid === clid);

    if (!picked) {
      // They took too long, or they picked somebody who has since disconnected,
      // or they made the clid up.
      return redirectWith("/link/teamspeak", { error: "no_pending" });
    }

    const code = generateLinkCode();

    // The row first, then the poke. If the poke fails we have an unused code
    // that expires in five minutes, which is harmless. The other order risks
    // poking a code at somebody that we then fail to store, which is a code that
    // can never work and a member who cannot tell why.
    await createLinkCode(getDb(), {
      memberId: member.id,
      targetTsUid: picked.uid,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    await pokeLinkCode(picked.clid, pokeMessage(code));

    return redirectWith("/link/teamspeak", {});
  } catch (cause) {
    if (cause instanceof WorkerUnavailableError) {
      return redirectWith("/link/teamspeak", { error: "worker_down" });
    }
    throw cause;
  }
};
