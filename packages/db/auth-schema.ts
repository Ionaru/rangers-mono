import { boolean, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Better Auth's own tables. Not ours: we do not get to design these, we only
 * host them.
 *
 * **These are not the Member.** `member` (schema.ts) is the domain record and
 * the hub every external identity hangs off (CONTEXT.md). What lives here is the
 * login: an `authUser` row, its sessions, and the `authAccount` row that records
 * *which Discord account* signed in. The two are joined by the Discord snowflake
 * and by nothing else: `authAccount.accountId` holds it, and `member.discordId`
 * matches it. Deliberately no foreign key between them (IMPLEMENTATION §3), so
 * neither table constrains the other's lifecycle. The tables are named `authX`
 * for the same reason CONTEXT.md tells you to avoid "User": in this codebase a
 * person is a Member, and `user` is a Better Auth implementation detail.
 *
 * They are hand-written because Better Auth's schema generator **does not run on
 * Deno**: `@better-auth/cli generate` dies in its jiti/c12 config loader with
 * `Import "@better-auth/core/utils" not a dependency` (better-auth#8154, open).
 * Nothing in the runtime path needs the CLI, so the cost is only this file. The
 * field list below was transcribed from the shipped
 * `@better-auth/core/dist/db/get-tables.mjs`, not from the docs, and it must
 * keep matching it: check that file after any Better Auth upgrade.
 *
 * Two rules govern the shape, and breaking either is a silent runtime failure:
 *
 * 1. **The property keys must be Better Auth's field names** (`emailVerified`,
 *    `userId`, `accountId`, ...). Its Drizzle adapter looks a column up as
 *    `schema[model][fieldName]`, so a renamed property is a column the adapter
 *    cannot find. The *column* literals are ours to choose, and they are
 *    snake_case like every other column in this schema. That split is exactly
 *    why the global `casing` option is not needed and stays off (ADR 0008).
 * 2. **`id` is `text`, not `uuid`.** Better Auth generates the id itself and
 *    hands us a string. `member.id` stays `uuid`. The two conventions never meet.
 */

/**
 * timestamptz, like every other timestamp in this database (see schema.ts).
 * Better Auth's own generator emits a naive `timestamp`; we do not, because a
 * session expiry that silently shifts by an hour twice a year is a session
 * expiry that is wrong twice a year. Better Auth only ever hands us a `Date` and
 * reads one back, so it cannot tell the difference, and the correct one is free.
 */
const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" });

/** The login. One per person who has ever signed in. */
export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /**
   * Required and unique, and that is Better Auth's rule, not ours: it refuses a
   * sign-in with no email (`error=email_not_found`). Discord returns a null
   * email for phone-only accounts even when the `email` scope is granted, so the
   * Discord provider is configured with a placeholder fallback (apps/web). We
   * never read this column.
   */
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
});

/** Better Auth's session table. It owns this, and its signed cookie carries `token`. */
export const authSession = pgTable("auth_session", {
  id: text("id").primaryKey(),
  expiresAt: tstz("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => authUser.id, {
    onDelete: "cascade",
  }),
}, (t) => [index("auth_session_user_id_idx").on(t.userId)]);

/**
 * The link between a login and an external provider. This is the load-bearing
 * one for us: for `providerId = 'discord'`, **`accountId` is the Discord
 * snowflake**, which is what `member.discordId` is matched against. That join is
 * how a session becomes a Member, and it is why nothing needed to be bolted onto
 * `authUser`.
 */
export const authAccount = pgTable("auth_account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => authUser.id, {
    onDelete: "cascade",
  }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: tstz("access_token_expires_at"),
  refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
  scope: text("scope"),
  /** Better Auth's column for password auth, which we do not use. Always null. */
  password: text("password"),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
}, (t) => [
  index("auth_account_user_id_idx").on(t.userId),
  // Every authenticated request resolves the member by (providerId, accountId).
  index("auth_account_provider_account_idx").on(t.providerId, t.accountId),
]);

/** Better Auth's generic verification-token table. Unused by a pure OAuth setup, but it expects it to exist. */
export const authVerification = pgTable("auth_verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: tstz("expires_at").notNull(),
  createdAt: tstz("created_at").notNull().defaultNow(),
  updatedAt: tstz("updated_at").notNull().defaultNow(),
}, (t) => [index("auth_verification_identifier_idx").on(t.identifier)]);

/**
 * What `drizzleAdapter(db, { schema })` is handed.
 *
 * The keys are Better Auth's **model names**, which is what it looks tables up
 * by, and they are not the table names (`user` -> `auth_user`). Passing this
 * explicitly is not optional: the adapter falls back to `db._.fullSchema`, which
 * only exists when `drizzle()` is called with `{ schema }`, and client.ts
 * deliberately does not do that so the relational query builder stays
 * unreachable (ADR 0008). Omit it and the adapter throws "The model 'user' was
 * not found in the schema object" on the first login.
 */
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
};
