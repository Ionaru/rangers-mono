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

/**
 * Application command option types, only the ones we use.
 *
 * The full list runs to eleven; these three are what `/attendance claim` needs.
 * `SUB_COMMAND` is an option that carries options of its own, which is how
 * Discord models `/attendance claim <args>` rather than a second command.
 */
export const CommandOptionType = {
  SUB_COMMAND: 1,
  STRING: 3,
  USER: 6,
} as const;

/** One option on a command, or one option on a subcommand. */
export interface CommandOption {
  type: number;
  name: string;
  description: string;
  /** Absent is false, as Discord defaults it. */
  required?: boolean;
  /** SUB_COMMAND only: the arguments it takes. */
  options?: CommandOption[];
}

/** An application command definition, only the fields we set. */
export interface CommandDefinition {
  name: string;
  description: string;
  type: number;
  options?: CommandOption[];
}

const CHAT_INPUT = 1;

/**
 * The admin commands. Gated by `DISCORD_ADMIN_ROLE_IDS` **in the handler**, not
 * here: Discord's own `default_member_permissions` is a different, coarser
 * mechanism (it works in permission bits, not role ids) and using both would
 * mean two places to keep an admin list. The command is visible to everyone and
 * refuses everyone who is not an admin, which is also the clearer failure.
 */
export const ADMIN_COMMANDS: CommandDefinition[] = [
  {
    name: "attendance",
    description: "Attendance admin.",
    type: CHAT_INPUT,
    options: [
      {
        type: CommandOptionType.SUB_COMMAND,
        name: "claim",
        description:
          "Attribute a guest's past attendance to a member, by TeamSpeak identity.",
        options: [
          {
            type: CommandOptionType.STRING,
            name: "ts_uid",
            description:
              "The unclaimed TeamSpeak identity (from the attendance page).",
            required: true,
          },
          {
            type: CommandOptionType.USER,
            name: "member",
            description: "The member those sessions belong to.",
            required: true,
          },
        ],
      },
    ],
  },
];

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

/**
 * Every command `7R_Bot` owns, and the **only** thing `register.ts` may PUT.
 *
 * Registration is a bulk overwrite of the whole guild scope: whatever is not in
 * this array is deleted from Discord. So a new command is added here, never
 * registered on its own, or the ones left out quietly vanish. (That overwrite is
 * also how a surviving `/loa` gets cleared, which is deliberate: there is no LOA
 * feature, ADR 0010.)
 */
export const ALL_COMMANDS: CommandDefinition[] = [
  ...LINK_COMMANDS,
  ...ADMIN_COMMANDS,
];
