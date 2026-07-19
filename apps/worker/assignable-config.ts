import type { AssignableKind, Badge, Rank, Role } from "@7r/domain";

/**
 * The Assignable mapping: THE git-tracked config ADR 0009 promises. The
 * `assignable` table is derived from this file by `deno task assignables:seed`
 * and is never hand-edited as a source of record; changing the mapping means a
 * PR here and a re-seed.
 *
 * Sgids are deliberately absent. The legacy dump holds two families of ids for
 * the same group names because the TeamSpeak server was rebuilt at some point,
 * so a number written here would be a number nobody can trust. The seed
 * resolves each `tsGroupName` against a live `servergrouplist` at run time,
 * prints the proposed name-to-sgid mapping, and asks before writing
 * (MIGRATION.md, gotcha 1).
 *
 * Names and Discord role ids are from MIGRATION.md: the ranks and staff roles
 * from the legacy dump, the badge role ids from the 2026-07-15
 * `badges:backfill` run. The badge roles wear a 🎖️ prefix in Discord; the
 * canonical name here and on TeamSpeak stays plain, and the sync never matches
 * on names anyway (Discord side by snowflake, TeamSpeak side by this file's
 * `tsGroupName`).
 */
export interface AssignableConfigEntry {
  kind: AssignableKind;
  /** Typed against the domain unions, so a typo fails `deno task check`. */
  name: Rank | Role | Badge;
  discordRoleId: string;
  /** The live TeamSpeak group name, or null = not mirrored to TeamSpeak. */
  tsGroupName: string | null;
  sortOrder: number;
}

export const ASSIGNABLE_CONFIG: readonly AssignableConfigEntry[] = [
  // Ranks: exclusive, exactly one per member. Reserve sorts last on purpose:
  // it is "still one of us, not currently active", not a rung on the ladder.
  {
    kind: "rank",
    name: "Officer",
    discordRoleId: "308218743085989888",
    tsGroupName: "Arma3 Officer",
    sortOrder: 0,
  },
  {
    kind: "rank",
    name: "NCO",
    discordRoleId: "308219154396217344",
    tsGroupName: "Arma3 NCO",
    sortOrder: 1,
  },
  {
    kind: "rank",
    name: "Member",
    discordRoleId: "308221089681637376",
    tsGroupName: "Arma3 Member",
    sortOrder: 2,
  },
  {
    kind: "rank",
    name: "Recruit",
    discordRoleId: "440484951507599370",
    tsGroupName: "Arma3 Recruit",
    sortOrder: 3,
  },
  {
    kind: "rank",
    name: "Reserve",
    discordRoleId: "657877767186022412",
    tsGroupName: "Arma3 Reserve",
    sortOrder: 4,
  },

  // Staff roles: additive. Mission maker has no TeamSpeak group, and that is
  // not an omission: its tsSgid stays null and the sync never mirrors it.
  {
    kind: "role",
    name: "Recruiter",
    discordRoleId: "432647112275001358",
    tsGroupName: "Recruiter",
    sortOrder: 0,
  },
  {
    kind: "role",
    name: "Instructor",
    discordRoleId: "455066329532203008",
    tsGroupName: "Instructor",
    sortOrder: 1,
  },
  {
    kind: "role",
    name: "Mission maker",
    discordRoleId: "432647098517684246",
    tsGroupName: null,
    sortOrder: 2,
  },

  // Badges: additive qualifications. Discord role ids from badges:backfill.
  {
    kind: "badge",
    name: "Medic",
    discordRoleId: "1526736079737192549",
    tsGroupName: "Medic",
    sortOrder: 0,
  },
  {
    kind: "badge",
    name: "Marksman",
    discordRoleId: "1526736080987226162",
    tsGroupName: "Marksman",
    sortOrder: 1,
  },
  {
    kind: "badge",
    name: "Engineer",
    discordRoleId: "1526736082207641680",
    tsGroupName: "Engineer",
    sortOrder: 2,
  },
  {
    kind: "badge",
    name: "Armoured",
    discordRoleId: "1526736083172462633",
    tsGroupName: "Armoured",
    sortOrder: 3,
  },
  {
    kind: "badge",
    name: "Heavy Weapons",
    discordRoleId: "1526736084267175977",
    tsGroupName: "Heavy Weapons",
    sortOrder: 4,
  },
  {
    kind: "badge",
    name: "Leadership",
    discordRoleId: "1526736084996718796",
    tsGroupName: "Leadership",
    sortOrder: 5,
  },
  {
    kind: "badge",
    name: "Rotary Aviation",
    discordRoleId: "1526736092861300936",
    tsGroupName: "Rotary Aviation",
    sortOrder: 6,
  },
  {
    kind: "badge",
    name: "Fixed-Wing Aviation",
    discordRoleId: "1526736093804757024",
    tsGroupName: "Fixed-Wing Aviation",
    sortOrder: 7,
  },
];
