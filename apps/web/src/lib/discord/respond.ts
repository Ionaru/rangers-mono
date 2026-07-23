import { editOriginalInteractionResponse, messageEdit } from "@7r/discord";

/**
 * The two things every deferred interaction handler needs: the ACK goes back
 * now, the slow work runs after and edits the reply in place.
 *
 * Discord gives us 3 seconds to respond and 15 minutes to follow up. `/link`,
 * `/unlink` and the modal submit all touch TeamSpeak or the database and cannot
 * fit in 3 seconds on a cold container, so they defer: return the ACK, then edit
 * `@original` once the work is done.
 */

/** The bits of an interaction the followup edit is addressed by. */
export interface InteractionRef {
  application_id: string;
  token: string;
}

/** Edit the interaction's original reply. Thin wrapper so handlers do not repeat the field-shuffling. */
export function editOriginal(
  interaction: InteractionRef,
  body: { content?: string; components?: unknown[] },
): Promise<void> {
  return editOriginalInteractionResponse({
    applicationId: interaction.application_id,
    interactionToken: interaction.token,
    body,
  });
}

/**
 * Return the deferred ACK now, run `work` detached.
 *
 * **The `.catch` is mandatory, not defensive.** Deno aborts the whole process on
 * an unhandled rejection, and the web app installs no `unhandledrejection`
 * handler (only the worker does), so a handler that threw would take the server
 * down. On failure it also tries to replace the member's spinner with an apology,
 * because a deferred reply that is never edited is a loading state that spins
 * forever.
 */
export function deferThen(
  ack: unknown,
  interaction: InteractionRef,
  work: () => Promise<void>,
): Response {
  void (async () => {
    try {
      await work();
    } catch (error) {
      console.error("[discord] deferred interaction work failed", error);
      try {
        await editOriginal(
          interaction,
          messageEdit({
            content:
              "Something went wrong on our end. Please try again in a few minutes.",
          }),
        );
      } catch (editError) {
        // The follow-up window may have closed, or Discord is down. Nothing left
        // to do but log; the member sees a spinner that eventually times out.
        console.error(
          "[discord] could not edit @original after a failure",
          editError,
        );
      }
    }
  })();

  return Response.json(ack);
}
