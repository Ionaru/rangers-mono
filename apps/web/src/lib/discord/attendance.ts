import { claimGuestSessions, findMemberByDiscordId, getDb } from "@7r/db";
import {
  deferredEphemeralReply,
  type Interaction,
  messageEdit,
  optionValue,
  subcommandOf,
} from "@7r/discord";
import { hasAdminRole } from "../admin.ts";
import { deferThen, editOriginal } from "./respond.ts";

/**
 * `/attendance claim <ts_uid> <member>`: attribute a guest's past attendance to
 * a member by hand (ADR 0009, IMPLEMENTATION §5).
 *
 * The rare fallback. A guest session is a TeamSpeak identity that resolved to
 * nobody when it was sampled, and linking adopts every one of them
 * automatically (`completeTeamspeakLink`), so this is only for an identity whose
 * owner is never going to link it: somebody who has left, or somebody whose old
 * identity is gone after a reinstall. The attendance page's guest list is the
 * worklist.
 *
 * The first admin-gated command in the system. The gate is `hasAdminRole` over
 * the roles Discord already put in the interaction payload, so it costs no REST
 * call, and it is the same rule the web page uses.
 */
export function attendanceCommand(interaction: Interaction): Response {
  return deferThen(deferredEphemeralReply(), interaction, async () => {
    const reply = (content: string) =>
      editOriginal(interaction, messageEdit({ content }));

    /**
     * Admin-only, and it fails closed on a missing `member`: an interaction from
     * outside a guild has no roles, and "no roles" must never read as "allowed".
     */
    if (!hasAdminRole(interaction.member?.roles ?? [])) {
      await reply("That command is for admins.");
      return;
    }

    const sub = subcommandOf(interaction.data);
    if (sub?.name !== "claim") {
      await reply("Unknown subcommand.");
      return;
    }

    const tsUid = optionValue(sub.options, "ts_uid");
    const targetDiscordId = optionValue(sub.options, "member");
    if (!tsUid || !targetDiscordId) {
      await reply("Both a TeamSpeak identity and a member are required.");
      return;
    }

    const db = getDb();
    const member = await findMemberByDiscordId(db, targetDiscordId);
    if (!member) {
      await reply(
        "That person has no member record yet. Ask them to run /link, or to " +
          "sign in to the website once, and try again.",
      );
      return;
    }

    const claimed = await claimGuestSessions(db, tsUid, member.id);

    if (claimed === 0) {
      /**
       * Two different situations, one answer, and deliberately so: either no
       * session carries that identity, or every session that does already
       * belongs to somebody. Both mean "nothing changed", and the query cannot
       * tell them apart without a second round trip to say something nobody
       * acts on differently.
       */
      await reply(
        `Nothing to claim for \`${tsUid}\`. Either no attendance was recorded ` +
          `against that identity, or it already belongs to a member. Claiming ` +
          `never takes a session from somebody else.`,
      );
      return;
    }

    await reply(
      `Attributed ${claimed} attendance session${claimed === 1 ? "" : "s"} ` +
        `from \`${tsUid}\` to **${member.displayName}**.`,
    );
  });
}
