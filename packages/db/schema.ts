import {
  date,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
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
  /**
   * When the mission makers were pinged to fill the event in, a day ahead of the
   * announcement. Null until they have been (and stays null for as long as no
   * mission-maker channel is configured, which is what turns the step off).
   */
  preparedAt: tstz("prepared_at"),
  /**
   * When the @everyone announcement was posted to #arma_general. Null until it
   * has been. The weekly job creates the event, pings the mission makers and posts
   * the announcement as three independently-idempotent steps: `discord_event_id`
   * guards the first, `prepared_at` the second and this the third, so a Discord
   * blip that lets one through but drops the next is retried on the following tick
   * rather than leaving nobody pinged.
   */
  announcedAt: tstz("announced_at"),
  /**
   * When the attendance sampler last successfully read the Operations channel
   * for this op. Null means it never did.
   *
   * Two jobs, and the second is why it exists at all. It is the instant a
   * restart closes still-open spans at, so a worker that was away for an hour
   * does not credit everybody for the hour it was blind (apps/worker/attendance.ts).
   * And it is the only way to answer "did the sampler run for this op?", which
   * ADR 0007 explicitly warns nobody will otherwise notice: the legacy recorder
   * died in July 2024 and the unit did not spot it for two years.
   */
  lastSampleAt: tstz("last_sample_at"),
  /**
   * When the Discord event's Interested list was last captured into
   * `operation_rsvp` (ADR 0020). Null means never, which is also what it stays
   * if the op has no `discord_event_id` to read a list from.
   *
   * A pacing marker rather than a one-shot guard, unlike `prepared_at` and
   * `announced_at`: the list is re-read every ATTENDANCE_RSVP_REFRESH_SECONDS
   * through the op, because people RSVP late and a worker that boots at 20:30
   * must still get a list.
   */
  rsvpRefreshedAt: tstz("rsvp_refreshed_at"),
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

/**
 * One Discord account that was on the op event's "Interested" list while the op
 * was running (ADR 0020).
 *
 * Stored, rather than read live, because Discord offers no way to ask an event
 * who was interested in it after the fact. Comparing "said they were coming" to
 * "turned up" therefore needs a snapshot, and the snapshot has to be taken
 * during the op or not at all.
 *
 * There is deliberately **no `member_id`**. The join to `member.discord_id`
 * happens at read time, so somebody who first logs in a month after an op is
 * still matched against it and no backfill is ever needed. `username` is kept
 * only so a responder who is not a member can still be named on the page.
 *
 * Captured from the attendance window's start, not from the announcement: a
 * member who RSVP'd on Wednesday and honestly withdrew on Saturday afternoon is
 * not a no-show, and capturing earlier would brand them one.
 */
export const operationRsvp = pgTable("operation_rsvp", {
  id: uuid("id").primaryKey().defaultRandom(),
  operationId: uuid("operation_id").notNull().references(() => operation.id, {
    onDelete: "cascade",
  }),
  /** The Discord user snowflake, as a string. Joined to `member.discord_id` on read. */
  discordId: text("discord_id").notNull(),
  /** Display-name snapshot, for a responder who resolves to no member. */
  username: text("username"),
  firstSeenAt: tstz("first_seen_at").notNull(),
  /**
   * The last refresh that still saw them on the list. Together with
   * `first_seen_at` this is what shows somebody who signed up mid-op, and what
   * would show a withdrawal if one ever needs reading.
   */
  lastSeenAt: tstz("last_seen_at").notNull(),
}, (t) => [
  index("operation_rsvp_operation_idx").on(t.operationId),
  // The refresh is an upsert on this key: one row per person per op, however
  // many times the list is re-read.
  uniqueIndex("operation_rsvp_operation_discord_idx").on(
    t.operationId,
    t.discordId,
  ),
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
export type OperationRsvp = typeof operationRsvp.$inferSelect;
export type NewOperationRsvp = typeof operationRsvp.$inferInsert;
