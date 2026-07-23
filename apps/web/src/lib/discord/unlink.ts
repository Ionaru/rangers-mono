import { clearTeamspeakLink, findMemberByDiscordId, getDb } from "@7r/db";
import {
  deferredEphemeralReply,
  type Interaction,
  interactionUserId,
  messageEdit,
} from "@7r/discord";
import { deferThen, editOriginal } from "./respond.ts";

/**
 * `/unlink`: remove the member's TeamSpeak link.
 *
 * Self-service and not admin-gated, because members must be able to undo their
 * own links and request deletion (ARCHITECTURE §7, GDPR-lite, ADR 0017). No
 * confirmation step: it is one deliberate command, and it is undone by running
 * /link again.
 *
 * It does not un-attribute attendance already credited to them (see
 * `clearTeamspeakLink`): they still attended those evenings. The next role sync
 * strips their TeamSpeak groups, because the reconcile iterates members with a
 * linked `ts_uid` and they no longer have one.
 */
export function unlinkCommand(interaction: Interaction): Response {
  return deferThen(deferredEphemeralReply(), interaction, async () => {
    const discordId = interactionUserId(interaction);
    if (!discordId) {
      await editOriginal(
        interaction,
        messageEdit({
          content: "We could not tell who you are. Please try again.",
        }),
      );
      return;
    }

    const db = getDb();
    const member = await findMemberByDiscordId(db, discordId);

    if (!member || !member.tsUid) {
      await editOriginal(
        interaction,
        messageEdit({
          content: "You have no TeamSpeak identity linked. Nothing to unlink.",
        }),
      );
      return;
    }

    await clearTeamspeakLink(db, member.id);

    await editOriginal(
      interaction,
      messageEdit({
        content:
          "**TeamSpeak unlinked.** Your TeamSpeak groups come off at the next " +
          "sync. Run /link whenever you want to link again.",
      }),
    );
  });
}
