import { discordJson } from "./rest.ts";

/**
 * Editing an interaction's reply after it was deferred.
 *
 * The `/link` flow defers (ACK now, a loading state shows), does its slow work
 * against TeamSpeak and the database, then edits the reply in place with the
 * result. That edit is this endpoint.
 *
 * **It is authenticated by the interaction token in the URL, not by the bot
 * token.** So it passes `botToken: null` and no `Authorization` header goes out
 * (rest.ts): sending the bot token here is harmless but wrong, and passing null
 * documents that this route's auth is the token path itself. The token is valid
 * for 15 minutes, which is comfortably longer than the flow ever takes.
 *
 * Reusing `discordJson` rather than a second `fetch` buys the retry, 429 and
 * timeout handling the endpoint already has: a PATCH is idempotent, so a
 * transient 5xx is safely replayed.
 */
export async function editOriginalInteractionResponse(
  input: {
    applicationId: string;
    interactionToken: string;
    body: { content?: string; components?: unknown[] };
  },
): Promise<void> {
  await discordJson(
    { botToken: null },
    `/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
    {
      method: "PATCH",
      body: JSON.stringify(input.body),
    },
  );
}
