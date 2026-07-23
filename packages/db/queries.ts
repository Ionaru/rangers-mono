import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { assignable, attendanceSession, linkCode, member } from "./schema.ts";
import { authAccount } from "./auth-schema.ts";
import type { Assignable, LinkCode, Member } from "./schema.ts";
import type { AssignableKind } from "@7r/domain";

/** Queries live beside the schema (ADR 0008), so callers never import drizzle themselves. */

/** Round-trips to Postgres. Throws if the database is unreachable. */
export async function ping(db: Db): Promise<void> {
  await db.execute(sql`select 1`);
}

/** Postgres's SQLSTATE for a unique violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Postgres raised a unique violation.
 *
 * There is exactly one place this is not a bug: two people racing to link the
 * same identity. `/internal/ts/clients` already hides the TeamSpeak identities
 * that are taken, but it is a list rendered a moment ago, so the check and the
 * write are not atomic and the database is the only thing that can be. Callers
 * turn this into "that identity is already linked", not a 500.
 *
 * **It walks the cause chain, and that is not defensive programming, it is
 * required.** Drizzle 1.0 wraps every driver error in a `DrizzleQueryError`, so
 * the SQLSTATE that used to sit on the error now sits on its `cause`. Checking
 * only the top level compiles, passes review, and silently turns a handled
 * "someone else linked that first" into a 500 (ADR 0016).
 */
export function isUniqueViolation(error: unknown): boolean {
  // Bounded, because `cause` is an ordinary property and nothing stops it
  // pointing at itself. An unbounded walk would hang the request instead of
  // answering it, which is a worse bug than the one this function prevents.
  let cause: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cause !== "object" || cause === null) return false;
    if ((cause as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------- member

export async function findMemberByDiscordId(
  db: Db,
  discordId: string,
): Promise<Member | undefined> {
  const [row] = await db.select().from(member).where(
    eq(member.discordId, discordId),
  );
  return row;
}

/**
 * The member behind a Better Auth session, in one query.
 *
 * `auth_account.account_id` is the Discord snowflake for `provider_id =
 * 'discord'`, and `member.discord_id` is the same snowflake. That is the entire
 * join between the login and the domain (auth-schema.ts): no foreign key, no
 * column bolted onto Better Auth's user table, and nothing to keep in step.
 *
 * A LEFT join, because "signed in but no member row yet" is a real state and the
 * caller has to tell it apart from "not signed in". It happens on a first login,
 * and it is what the guild check gates.
 */
export async function findMemberForAuthUser(
  db: Db,
  authUserId: string,
): Promise<{ discordId: string; member: Member | null } | undefined> {
  const [row] = await db
    .select({ discordId: authAccount.accountId, member })
    .from(authAccount)
    .leftJoin(member, eq(member.discordId, authAccount.accountId))
    .where(
      and(
        eq(authAccount.userId, authUserId),
        eq(authAccount.providerId, "discord"),
      ),
    );
  return row;
}

/**
 * Create the member, or refresh the display name of the one that is already
 * there.
 *
 * Upsert rather than insert, because the row may well exist before its owner
 * ever logs in: the legacy import creates all 150 of them (MIGRATION.md). Their
 * first login is then an *update*, and it is the moment we can finally replace a
 * display name copied out of a 2020 database with the one Discord has today.
 */
export async function upsertMemberOnLogin(
  db: Db,
  input: { discordId: string; displayName: string },
): Promise<Member> {
  const [row] = await db
    .insert(member)
    .values(input)
    .onConflictDoUpdate({
      target: member.discordId,
      set: { displayName: input.displayName, updatedAt: new Date() },
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------- teamspeak link

/**
 * Every TeamSpeak identity already spoken for, and by whom.
 *
 * The worker subtracts these from the online-client list so nobody is offered
 * somebody else's identity to link, but it keeps the member id so it can offer a
 * member their *own* current identity back (a re-link: `pickableClients` in
 * `@7r/identity`). Returning bare uids was the re-link bug: with no way to tell
 * "yours" from "someone else's", the only safe rule was to hide them all.
 *
 * A whole-table scan of a column with ~100 non-null values, which is cheaper
 * than any cleverness would be.
 */
export async function listTeamspeakLinks(
  db: Db,
): Promise<{ memberId: string; tsUid: string }[]> {
  const rows = await db
    .select({ memberId: member.id, tsUid: member.tsUid })
    .from(member)
    .where(sql`${member.tsUid} is not null`);
  return rows.map((r) => ({ memberId: r.memberId, tsUid: r.tsUid! }));
}

/**
 * Issue a challenge, and kill any that is outstanding for this member.
 *
 * One live code at a time, on purpose. Leaving old ones valid would mean a
 * member who clicks "link" three times has three codes in flight, of which two
 * were poked at whoever they mis-picked the first two times, and any of the
 * three would complete the link. The newest intent is the only one that counts.
 */
export async function createLinkCode(
  db: Db,
  input: {
    memberId: string;
    targetTsUid: string;
    code: string;
    expiresAt: Date;
  },
): Promise<LinkCode> {
  return await db.transaction(async (tx) => {
    await tx
      .update(linkCode)
      .set({ consumedAt: new Date() })
      .where(
        and(eq(linkCode.memberId, input.memberId), isNull(linkCode.consumedAt)),
      );

    const [row] = await tx.insert(linkCode).values(input).returning();
    return row;
  });
}

/** The member's one live challenge: unconsumed, unexpired. Undefined if there is none. */
export async function findLiveLinkCode(
  db: Db,
  memberId: string,
): Promise<LinkCode | undefined> {
  const [row] = await db
    .select()
    .from(linkCode)
    .where(
      and(
        eq(linkCode.memberId, memberId),
        isNull(linkCode.consumedAt),
        gt(linkCode.expiresAt, new Date()),
      ),
    );
  return row;
}

/** A wrong guess. Returns the new count so the caller can enforce the cap. */
export async function recordLinkCodeAttempt(
  db: Db,
  linkCodeId: string,
): Promise<number> {
  const [row] = await db
    .update(linkCode)
    .set({ attempts: sql`${linkCode.attempts} + 1` })
    .where(eq(linkCode.id, linkCodeId))
    .returning({ attempts: linkCode.attempts });
  return row?.attempts ?? 0;
}

/** Burn a challenge without linking anything. Used when the attempt cap is hit. */
export async function consumeLinkCode(
  db: Db,
  linkCodeId: string,
): Promise<void> {
  await db.update(linkCode).set({ consumedAt: new Date() }).where(
    eq(linkCode.id, linkCodeId),
  );
}

/**
 * The link itself: burn the code, write the identity, and adopt the member's
 * past guest attendance. One transaction, and it has to be.
 *
 * The backfill is the part that is easy to leave out and expensive to add later:
 * a TeamSpeak identity that sat in the Operations channel before its owner ever
 * linked was recorded as a Guest (`member_id is null`), and this is the moment
 * it becomes theirs (IMPLEMENTATION §4 and §7, ADR 0007, ADR 0009). It writes
 * nothing today because attendance does not exist until Phase 6. It is here
 * anyway, because the alternative is remembering to come back for it.
 *
 * `member_id is null` in the WHERE is what makes it safe to run twice, and what
 * stops it stealing a session that some other member already owns.
 *
 * Throws a unique violation if that `ts_uid` belongs to someone else already.
 */
export async function completeTeamspeakLink(
  db: Db,
  input: {
    memberId: string;
    linkCodeId: string;
    tsUid: string;
    tsNickname: string | null;
  },
): Promise<{ backfilledSessions: number }> {
  return await db.transaction(async (tx) => {
    await tx
      .update(linkCode)
      .set({ consumedAt: new Date() })
      .where(eq(linkCode.id, input.linkCodeId));

    await tx
      .update(member)
      .set({
        tsUid: input.tsUid,
        tsNickname: input.tsNickname,
        tsVerifiedAt: new Date(),
        tsLinkMethod: "poke",
        updatedAt: new Date(),
      })
      .where(eq(member.id, input.memberId));

    const backfilled = await tx
      .update(attendanceSession)
      .set({ memberId: input.memberId })
      .where(
        and(
          eq(attendanceSession.tsUid, input.tsUid),
          isNull(attendanceSession.memberId),
        ),
      )
      .returning({ id: attendanceSession.id });

    return { backfilledSessions: backfilled.length };
  });
}

/**
 * Unlink.
 *
 * Deliberately does NOT un-attribute attendance already credited to this member.
 * The docs leave this undefined, so: the backfill only ever fills nulls, and
 * unlinking only ever clears the identity. Attendance is a statistic about
 * evenings a person actually attended (ADR 0010), and they still attended them.
 * Making unlink retroactive would also make it a way to rewrite history.
 */
export async function clearTeamspeakLink(
  db: Db,
  memberId: string,
): Promise<void> {
  await db
    .update(member)
    .set({
      tsUid: null,
      tsNickname: null,
      tsVerifiedAt: null,
      tsLinkMethod: null,
      updatedAt: new Date(),
    })
    .where(eq(member.id, memberId));
}

// ---------------------------------------------------------------- steam link

/**
 * Steam OpenID proved this SteamID64 belongs to them.
 *
 * This is also the upgrade path for the 23 links the legacy import seeded as
 * `manual`: re-linking through OpenID overwrites the method and finally stamps a
 * real `steam_verified_at`.
 *
 * Throws a unique violation if that Steam account is already on another member.
 */
export async function setSteamLink(
  db: Db,
  input: { memberId: string; steamId: string },
): Promise<void> {
  await db
    .update(member)
    .set({
      steamId: input.steamId,
      steamVerifiedAt: new Date(),
      steamLinkMethod: "openid",
      updatedAt: new Date(),
    })
    .where(eq(member.id, input.memberId));
}

export async function clearSteamLink(db: Db, memberId: string): Promise<void> {
  await db
    .update(member)
    .set({
      steamId: null,
      steamVerifiedAt: null,
      steamLinkMethod: null,
      updatedAt: new Date(),
    })
    .where(eq(member.id, memberId));
}

// ---------------------------------------------------------------- legacy import

/**
 * One row of the legacy import (MIGRATION.md).
 *
 * Idempotent by `discordId`, so the whole import can be re-run: it is a one-shot
 * script, and a one-shot script that cannot be run twice is a one-shot script
 * you are afraid of.
 *
 * It only ever *fills* identity columns, never clears them, and never touches a
 * link that has since been verified for real. A member who has already linked
 * TeamSpeak through the poke flow must not be demoted back to `legacy_import` by
 * someone re-running the importer, which is what a naive upsert would do.
 */
export async function upsertLegacyMember(
  db: Db,
  input: {
    discordId: string;
    displayName: string;
    tsUid: string | null;
    tsNickname: string | null;
    steamId: string | null;
  },
): Promise<{ inserted: boolean }> {
  const values = {
    discordId: input.discordId,
    displayName: input.displayName,
    ...(input.tsUid
      ? {
        tsUid: input.tsUid,
        tsNickname: input.tsNickname,
        tsLinkMethod: "legacy_import" as const,
      }
      : {}),
    ...(input.steamId
      ? { steamId: input.steamId, steamLinkMethod: "manual" as const }
      : {}),
  };

  const [row] = await db
    .insert(member)
    .values(values)
    .onConflictDoUpdate({
      target: member.discordId,
      set: {
        displayName: input.displayName,
        updatedAt: new Date(),
        // `coalesce(existing, new)`: fill a gap, never overwrite. A member who
        // has verified their identity for real keeps it.
        tsUid: sql`coalesce(${member.tsUid}, ${input.tsUid})`,
        tsNickname: sql`coalesce(${member.tsNickname}, ${input.tsNickname})`,
        tsLinkMethod: sql`coalesce(${member.tsLinkMethod}, ${
          input.tsUid ? "legacy_import" : null
        })`,
        steamId: sql`coalesce(${member.steamId}, ${input.steamId})`,
        steamLinkMethod: sql`coalesce(${member.steamLinkMethod}, ${
          input.steamId ? "manual" : null
        })`,
      },
    })
    .returning({ createdAt: member.createdAt, updatedAt: member.updatedAt });

  // An insert stamps both from the same `now()`; an update moves updatedAt on.
  return {
    inserted: row.createdAt.getTime() === row.updatedAt.getTime(),
  };
}

/**
 * Every member who has a linked TeamSpeak identity, keyed by that identity.
 *
 * This is the bridge that lets TeamSpeak answer a question about Discord. It is
 * needed exactly once, for the badge backfill: badges never existed as Discord
 * roles, so the live TeamSpeak groups are the only current record of who has
 * earned what, and this is what turns a TeamSpeak uid back into a person we can
 * give a Discord role to.
 *
 * After that backfill, the arrow reverses for good: Discord becomes authoritative
 * for badges like every other Assignable (ADR 0002), and the sync only ever
 * writes TeamSpeak.
 */
export async function membersByTsUid(
  db: Db,
): Promise<
  Map<string, { id: string; discordId: string; displayName: string }>
> {
  const rows = await db
    .select({
      id: member.id,
      discordId: member.discordId,
      displayName: member.displayName,
      tsUid: member.tsUid,
    })
    .from(member)
    .where(sql`${member.tsUid} is not null`);

  return new Map(
    rows.map((row) => [row.tsUid!, {
      id: row.id,
      discordId: row.discordId,
      displayName: row.displayName,
    }]),
  );
}

// ---------------------------------------------------------------- assignable

/** The whole mapping, in display order. The reconcile reads this once per pass. */
export async function listAssignables(db: Db): Promise<Assignable[]> {
  return await db
    .select()
    .from(assignable)
    .orderBy(asc(assignable.kind), asc(assignable.sortOrder));
}

/**
 * One row of the Assignable seed (ADR 0009): the git-tracked config is the
 * source of record, and this is how it is applied.
 *
 * Idempotent by `discordRoleId`, and unlike `upsertLegacyMember` it OVERWRITES:
 * a re-run after a corrected sgid mapping must correct the row, not politely
 * keep the wrong number. The table is derived state; the config file is the
 * truth (MIGRATION.md wants exactly this: re-runnable after a sgid fix).
 */
export async function upsertAssignable(
  db: Db,
  input: {
    kind: AssignableKind;
    name: string;
    discordRoleId: string;
    tsSgid: number | null;
    sortOrder: number;
  },
): Promise<void> {
  await db
    .insert(assignable)
    .values(input)
    .onConflictDoUpdate({
      target: assignable.discordRoleId,
      set: {
        kind: input.kind,
        name: input.name,
        tsSgid: input.tsSgid,
        sortOrder: input.sortOrder,
      },
    });
}

// ---------------------------------------------------------------- role sync

/** A member as the reconcile iterates them: linked, with their disabled state. */
export interface SyncMember {
  id: string;
  discordId: string;
  displayName: string;
  tsUid: string;
  disabledAt: Date | null;
}

/**
 * Every member with a linked TeamSpeak identity: the set the reconcile
 * iterates. OUR members, never the guild list, which is the leaver fix the
 * design hangs on (§4.4): a leaver vanishes from the guild poll but not from
 * here, so their desired set is empty and every owned group comes off.
 */
export async function listSyncMembers(db: Db): Promise<SyncMember[]> {
  const rows = await db
    .select({
      id: member.id,
      discordId: member.discordId,
      displayName: member.displayName,
      tsUid: member.tsUid,
      disabledAt: member.disabledAt,
    })
    .from(member)
    .where(sql`${member.tsUid} is not null`);

  return rows.map((r) => ({ ...r, tsUid: r.tsUid! }));
}

/** Stamp `disabled_at`: first seen missing from the guild (§4.4). */
export async function setMemberDisabledAt(
  db: Db,
  memberId: string,
): Promise<void> {
  await db
    .update(member)
    .set({ disabledAt: new Date(), updatedAt: new Date() })
    .where(eq(member.id, memberId));
}

/** Clear `disabled_at`: seen back in the guild (reconcile.ts says why). */
export async function clearMemberDisabledAt(
  db: Db,
  memberId: string,
): Promise<void> {
  await db
    .update(member)
    .set({ disabledAt: null, updatedAt: new Date() })
    .where(eq(member.id, memberId));
}

/** A linked member, reduced to what nickname triage needs. */
export interface LinkedMemberLite {
  displayName: string;
  tsNickname: string | null;
  tsUid: string;
}

/**
 * Every linked member, for matching an unlinked TeamSpeak nickname against people
 * we already know.
 *
 * The badge backfill uses this to triage its unmapped holders: an unmapped
 * TeamSpeak identity whose nickname matches a member who is linked under a
 * *different* uid is almost certainly that member on a reinstalled client, which
 * is a very different problem (grant the Discord role, they keep it) from a
 * stranger who left the unit (ignore). Names are a hint, not proof: a human
 * confirms before granting.
 */
export async function listLinkedMembers(db: Db): Promise<LinkedMemberLite[]> {
  const rows = await db
    .select({
      displayName: member.displayName,
      tsNickname: member.tsNickname,
      tsUid: member.tsUid,
    })
    .from(member)
    .where(sql`${member.tsUid} is not null`);

  return rows.map((r) => ({
    displayName: r.displayName,
    tsNickname: r.tsNickname,
    tsUid: r.tsUid!,
  }));
}
