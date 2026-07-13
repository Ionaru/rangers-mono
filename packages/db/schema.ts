import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AssignableKind,
  OperationSource,
  SteamLinkMethod,
  TsLinkMethod,
} from "@7r/domain";

/**
 * The schema. See ARCHITECTURE.md §3 and IMPLEMENTATION.md §3.
 *
 * Two things are deliberately absent and should stay absent:
 * - no `loa` table. Leave of absence is not a concept here; who turns up for an
 *   op is the Discord event's native RSVP list (ADR 0010).
 * - no permission table. Admin is a single boolean derived from
 *   DISCORD_ADMIN_ROLE_IDS (ADR 0009).
 *
 * Nor are per-member role assignments stored: a member's current Discord roles
 * are the truth (ADR 0002). `assignable` holds only the definitions.
 *
 * Drizzle guardrails (ADR 0008), which shrink the eventual 1.0 upgrade to a
 * migrations-folder restructure: only the core `pgTable` builder, no
 * `relations()` / `.query`, and no global `casing` option. Because `casing` is
 * off, every multi-word column names its snake_case column explicitly.
 */

/**
 * Every timestamp is `timestamptz`. Ops are defined in Europe/Amsterdam with a
 * DST-correct window but what we store are instants; a naive `timestamp` would
 * silently drop the offset and quietly misplace an hour twice a year.
 */
const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/** The person, and the hub every external identity hangs off. */
export const member = pgTable("member", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Required: it is the login and the source of roles (ADR 0001). */
  discordId: text("discord_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  /** Stamped the first time the role sync sees them missing from the guild (§4.4). */
  disabledAt: tstz("disabled_at"),

  // TeamSpeak: one current link, self-service replaceable.
  tsUid: text("ts_uid").unique(),
  tsNickname: text("ts_nickname"),
  tsVerifiedAt: tstz("ts_verified_at"),
  tsLinkMethod: text("ts_link_method").$type<TsLinkMethod>(),

  // Steam: an optional profile field. Proves account ownership, gates nothing.
  steamId: text("steam_id").unique(),
  steamVerifiedAt: tstz("steam_verified_at"),
  steamLinkMethod: text("steam_link_method").$type<SteamLinkMethod>(),

  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/**
 * A rank / role / badge and its mapping. Discord is authoritative (ADR 0002).
 * The set of non-null `ts_sgid` is the "owned set" the sync reconciles;
 * every other TeamSpeak group is invisible to us and is left alone.
 */
export const assignable = pgTable("assignable", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").$type<AssignableKind>().notNull(),
  name: text("name").notNull(),
  discordRoleId: text("discord_role_id").notNull().unique(),
  /** null = defined in Discord but not mirrored to TeamSpeak. */
  tsSgid: integer("ts_sgid"),
  sortOrder: integer("sort_order").notNull().default(0),
});

/** One op. Saturdays only. */
export const operation = pgTable("operation", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * Unique. The weekly job is idempotent by "skip if an operation exists for
   * this date", which is a race unless the database says so too.
   */
  date: date("date").notNull().unique(),
  attendanceStart: tstz("attendance_start").notNull(),
  attendanceEnd: tstz("attendance_end").notNull(),
  eventEnd: tstz("event_end").notNull(),
  discordEventId: text("discord_event_id"),
  name: text("name"),
  source: text("source").$type<OperationSource>().notNull().default(
    "auto_weekly",
  ),
});

/** One continuous presence span in the Operations channel, reconstructed from samples. */
export const attendanceSession = pgTable("attendance_session", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => operation.id, {
    onDelete: "cascade",
  }),
  /** null = guest: a TeamSpeak identity that resolves to no member (yet). */
  memberId: uuid("member_id").references(() => member.id, {
    onDelete: "set null",
  }),
  tsUid: text("ts_uid").notNull(),
  tsNickname: text("ts_nickname"),
  joinedAt: tstz("joined_at").notNull(),
  leftAt: tstz("left_at"),
}, (t) => [
  index("attendance_session_operation_idx").on(t.operationId),
  // Guest sessions backfill to a member the moment they link TeamSpeak, which
  // is a lookup by bare ts_uid across every op ever recorded.
  index("attendance_session_ts_uid_idx").on(t.tsUid),
]);

/** A one-time TeamSpeak possession challenge. Steam uses OpenID and needs none. */
export const linkCode = pgTable("link_code", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull(),
  memberId: uuid("member_id").notNull().references(() => member.id, {
    onDelete: "cascade",
  }),
  /** The client the member picked from the list, and the one the bot pokes. */
  targetTsUid: text("target_ts_uid").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  consumedAt: tstz("consumed_at"),
  /**
   * Wrong guesses against this code. Not in IMPLEMENTATION §3's sketch, which
   * says it is "illustrative, not final", and added because without it §4's
   * "picking the wrong person fails safe" is only true against an attacker who
   * does not retry. The code goes to the client you picked, so guessing it is
   * the only way to claim someone else's TeamSpeak identity; a cap of a handful
   * of attempts is what makes that a dead end rather than a slow one.
   */
  attempts: integer("attempts").notNull().default(0),
}, (t) => [index("link_code_code_idx").on(t.code)]);

export type Member = typeof member.$inferSelect;
export type NewMember = typeof member.$inferInsert;
export type Assignable = typeof assignable.$inferSelect;
export type NewAssignable = typeof assignable.$inferInsert;
export type Operation = typeof operation.$inferSelect;
export type NewOperation = typeof operation.$inferInsert;
export type AttendanceSession = typeof attendanceSession.$inferSelect;
export type NewAttendanceSession = typeof attendanceSession.$inferInsert;
export type LinkCode = typeof linkCode.$inferSelect;
export type NewLinkCode = typeof linkCode.$inferInsert;
