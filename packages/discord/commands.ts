/**
 * The slash commands `7R_Bot` owns, as data.
 *
 * Phase 5's first slice is `/link` and `/unlink` (ADR 0017). Both are
 * member-facing: unlike every other planned write command, they are not
 * admin-gated, because a member linking or unlinking their own TeamSpeak
 * identity is self-service (ARCHITECTURE §7).
 *
 * `type: 1` is CHAT_INPUT (an ordinary slash command). Descriptions are capped
 * at 100 characters by Discord.
 */

/** An application command definition, only the fields we set. */
export interface CommandDefinition {
  name: string;
  description: string;
  type: number;
}

const CHAT_INPUT = 1;

export const LINK_COMMANDS: CommandDefinition[] = [
  {
    name: "link",
    description:
      "Link (or re-link) your TeamSpeak identity so you get your groups.",
    type: CHAT_INPUT,
  },
  {
    name: "unlink",
    description: "Remove the TeamSpeak identity linked to your account.",
    type: CHAT_INPUT,
  },
];
