/**
 * The vocabulary of the platform. See CONTEXT.md, which is the source of these
 * names: change them there first.
 *
 * This package holds domain types and pure rules. It performs no I/O, imports
 * no driver, and reads no environment. Keep it that way: the two functions the
 * test suite exists for (the TeamSpeak group reconcile in Phase 3 and the
 * sample-to-session reconstruction in Phase 5) are only testable without a live
 * server because they take plain data in and return plain data out.
 */

/** A grantable thing a Member can hold. The sync treats all three kinds alike. */
export type AssignableKind = "rank" | "role" | "badge";

/**
 * A Member's standing. Exclusive: a Member holds exactly one.
 * Ordered as the unit lists them; `Reserve` ("still one of us, not currently
 * active") is not a rung on the ladder and sorts last.
 */
export const RANKS = [
  "Officer",
  "NCO",
  "Member",
  "Recruit",
  "Reserve",
] as const;
export type Rank = typeof RANKS[number];

/** Staff functions a Member is appointed to. Additive. Not qualifications. */
export const ROLES = ["Recruiter", "Instructor", "Mission maker"] as const;
export type Role = typeof ROLES[number];

/** Training qualifications a Member has earned. Additive. */
export const BADGES = [
  "Medic",
  "Marksman",
  "Engineer",
  "Armoured",
  "Heavy Weapons",
  "Leadership",
  "Rotary Aviation",
  "Fixed-Wing Aviation",
] as const;
export type Badge = typeof BADGES[number];

/**
 * How a TeamSpeak link was established.
 * - `poke`: the member proved possession (pick-from-list + poked code).
 * - `manual`: an admin force-linked it (`/link-force`). Visibly not self-verified.
 * - `legacy_import`: carried over from the old database, flagged for re-verification.
 */
export type TsLinkMethod = "poke" | "manual" | "legacy_import";

/** How a Steam link was established. Steam OpenID proves account ownership. */
export type SteamLinkMethod = "openid" | "manual";

/** How an Operation came to exist. */
export type OperationSource = "auto_weekly" | "manual";

/** The identifying part of an Assignable, which is all the pure rules need. */
export interface AssignableRef {
  kind: AssignableKind;
  name: string;
}
