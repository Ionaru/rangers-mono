import type { APIRoute } from "astro";
import { getDiscordConfig } from "@7r/config";
import {
  type Interaction,
  InteractionType,
  parseCustomId,
  pong,
  verifyInteractionSignature,
} from "@7r/discord";
import {
  linkCode,
  linkCommand,
  linkEnter,
  linkPick,
} from "../../../lib/discord/link.ts";
import { unlinkCommand } from "../../../lib/discord/unlink.ts";

export const prerender = false;

/**
 * The Discord interactions endpoint (ARCHITECTURE §4.1, IMPLEMENTATION §8).
 *
 * Everything Discord sends the bot arrives here as a signed HTTP POST: slash
 * commands, the `/link` select and button, and the `/link` code modal. There is
 * no gateway (ADR 0003); this is the whole surface.
 *
 * The order below is not arbitrary. **Verify first, over the raw bytes, and fail
 * closed.** Discord probes this endpoint with deliberately invalid signatures and
 * removes the URL if one is ever answered with a 200 (a silent, delayed bot
 * death), so nothing is parsed or acted on until the signature is proven, and any
 * failure is a 401.
 */
export const POST: APIRoute = async ({ request }) => {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");

  // The RAW bytes. Verify over exactly these: re-serialising parsed JSON would
  // not be byte-identical and would fail to verify (IMPLEMENTATION §8).
  const bodyBytes = new Uint8Array(await request.arrayBuffer());

  const { DISCORD_PUBLIC_KEY } = getDiscordConfig();

  const verified = signature !== null && timestamp !== null &&
    await verifyInteractionSignature({
      publicKeyHex: DISCORD_PUBLIC_KEY,
      signatureHex: signature,
      timestamp,
      body: bodyBytes,
    });

  if (!verified) {
    // No detail. A probe learns nothing from this beyond "no".
    return new Response("invalid request signature", { status: 401 });
  }

  let interaction: Interaction;
  try {
    interaction = JSON.parse(
      new TextDecoder().decode(bodyBytes),
    ) as Interaction;
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // PING -> PONG. This is what Discord sends to accept the endpoint URL, so it
  // has to be answered before anything else works.
  if (interaction.type === InteractionType.PING) {
    return Response.json(pong());
  }

  const routed = dispatch(interaction);
  if (routed) return routed;

  // A well-formed interaction we do not handle. Acknowledge nothing; a 400 keeps
  // it out of the logs as an error while making clear it was not routed.
  return new Response("unhandled interaction", { status: 400 });
};

/** Route a verified interaction to its handler, or null if nothing matches. */
function dispatch(interaction: Interaction): Response | null {
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    switch (interaction.data?.name) {
      case "link":
        return linkCommand(interaction);
      case "unlink":
        return unlinkCommand(interaction);
    }
    return null;
  }

  if (
    interaction.type === InteractionType.MESSAGE_COMPONENT ||
    interaction.type === InteractionType.MODAL_SUBMIT
  ) {
    const parsed = parseCustomId(interaction.data?.custom_id ?? "");
    if (parsed?.namespace !== "link") return null;
    switch (parsed.action) {
      case "pick":
        return linkPick(interaction);
      case "enter":
        return linkEnter(interaction);
      case "code":
        return linkCode(interaction);
    }
    return null;
  }

  return null;
}
