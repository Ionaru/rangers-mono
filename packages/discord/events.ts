import { discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * Guild scheduled events: the weekly Saturday Operation (ARCHITECTURE §4.2,
 * IMPLEMENTATION §7).
 *
 * The op is an EXTERNAL event (it happens on TeamSpeak and the game server, not in
 * a Discord voice channel), and creating one needs **`CREATE_EVENTS` (1<<44)**,
 * not `MANAGE_EVENTS` (1<<33): the latter only edits and deletes events that
 * already exist and 403s on create. `phase0:check` reported `7R_Bot` was missing
 * `CREATE_EVENTS`, so this 403s until that grant is added.
 */

/** Discord's `entity_type` for an event with a free-text location. */
const ENTITY_TYPE_EXTERNAL = 3;
/** `privacy_level`: the only value Discord accepts for a guild event. */
const PRIVACY_LEVEL_GUILD_ONLY = 2;

/** A scheduled event, reduced to what the weekly job reads back. */
export interface ScheduledEvent {
  id: string;
  name: string;
  /** ISO-8601, as Discord returns it. Used to match our own event on a re-run. */
  scheduled_start_time: string;
}

/**
 * The event's cover banner: raw image bytes and their MIME type. Discord takes it
 * as "image data" (a base64 data URI), so the caller passes bytes and this module
 * does the Discord-specific encoding. Supported types are PNG, JPG and GIF
 * (reference#image-data).
 */
export interface EventCoverImage {
  /** `<ArrayBuffer>`-backed, as `Deno.readFile` returns. */
  bytes: Uint8Array<ArrayBuffer>;
  /** e.g. "image/png". Becomes the data URI's media type. */
  contentType: string;
}

/**
 * Base64-encode raw bytes, dependency-free.
 *
 * `btoa` is a web standard present in both Deno and the Astro/Deno SSR bundle, so
 * this stays resolvable when `apps/web` imports the `@7r/discord` barrel that
 * re-exports this module. A `jsr:@std/encoding` import would not: Astro's bundler
 * reads only the npm side of the workspace and `deno task web:build` fails with
 * "Rolldown failed to resolve import" on a bare `jsr:` specifier (ADR 0006). The
 * chunking keeps a large image from overflowing `String.fromCharCode`'s argument
 * list.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Create the Saturday op's scheduled event.
 *
 * `scheduled_start_time`/`scheduled_end_time` are ISO-8601 instants; the caller
 * computes them DST-correct from the op's local wall clock (`@7r/domain`
 * `planWeeklyOp`). `channel_id` is deliberately omitted: it must be null for an
 * EXTERNAL event, and Discord rejects the create if it is set.
 *
 * The optional `image` is the event's cover banner, encoded here into Discord's
 * "image data" data URI. It is decorative: the caller (weekly-event.ts) sends it
 * on the create and, if Discord rejects it (a 400 for too-large or an unsupported
 * type), retries without it so a bad image never blocks the op event itself.
 *
 * A plain POST, so it is never auto-retried (rest.ts replays only idempotent
 * methods): a transient 5xx that actually created the event would otherwise make
 * a duplicate. The caller guards against that by listing events and adopting an
 * existing match before it creates (`listGuildScheduledEvents`).
 */
export function createGuildScheduledEvent(
  options: DiscordRestOptions,
  guildId: string,
  event: {
    name: string;
    description: string;
    location: string;
    start: Date;
    end: Date;
    reason: string;
    image?: EventCoverImage;
  },
): Promise<ScheduledEvent> {
  const body: Record<string, unknown> = {
    name: event.name,
    description: event.description,
    entity_type: ENTITY_TYPE_EXTERNAL,
    privacy_level: PRIVACY_LEVEL_GUILD_ONLY,
    entity_metadata: { location: event.location },
    scheduled_start_time: event.start.toISOString(),
    scheduled_end_time: event.end.toISOString(),
  };

  if (event.image) {
    // Discord "image data": a base64 data URI (reference#image-data).
    body.image = `data:${event.image.contentType};base64,${
      bytesToBase64(event.image.bytes)
    }`;
  }

  return discordJson<ScheduledEvent>(
    options,
    `/guilds/${guildId}/scheduled-events`,
    {
      method: "POST",
      headers: { "X-Audit-Log-Reason": event.reason },
      body: JSON.stringify(body),
    },
  );
}

/**
 * The public link to a guild's scheduled event, the one Discord unfurls into an
 * event card with its cover banner and its native "Interested" button.
 *
 * Here rather than at the call site because it is not only display text: the
 * weekly job finds its own prior announcement by matching this exact URL in the
 * channel history, so the poster and the finder have to agree on the shape or the
 * guard against a second @everyone ping silently stops matching.
 */
export function guildScheduledEventUrl(
  guildId: string,
  eventId: string,
): string {
  return `https://discord.com/events/${guildId}/${eventId}`;
}

/**
 * Every scheduled event currently on the guild.
 *
 * The weekly job lists these before it creates, so a pass that crashed after
 * creating the event but before recording its id in the database adopts the
 * existing event next time instead of making a duplicate (IMPLEMENTATION §7). A
 * bot may list a guild's events with no special permission.
 */
export function listGuildScheduledEvents(
  options: DiscordRestOptions,
  guildId: string,
): Promise<ScheduledEvent[]> {
  return discordJson<ScheduledEvent[]>(
    options,
    `/guilds/${guildId}/scheduled-events`,
  );
}

/**
 * One entry on an event's "Interested" list, reduced to what the RSVP snapshot
 * stores.
 *
 * `global_name` is Discord's display name and is what a reader recognises;
 * `username` is the handle and is always present. Both are snapshots: they are
 * stored so a responder who is not a member can still be named on the page, and
 * anyone who *is* a member is named from `member.display_name` instead.
 */
export interface ScheduledEventSubscriber {
  id: string;
  username: string;
  displayName: string | null;
}

/** The raw shape Discord returns, before it is reduced. */
interface ScheduledEventUser {
  user: { id: string; username: string; global_name?: string | null };
}

/** Discord's cap on this endpoint, and also its default. */
const EVENT_USERS_PAGE = 100;

/**
 * Everyone currently subscribed ("Interested") to one scheduled event.
 *
 * This is the RSVP snapshot the attendance pass takes during the op (ADR 0020).
 * Discord exposes no way to read an event's RSVP list after the fact, which is
 * the whole reason it is captured live and stored rather than read on demand.
 *
 * Paginated exactly as `listGuildMembers` is, and for the same reason: the cap
 * is 100 per page, users come back ascending by id, and `after` is the cursor.
 * `before` is deliberately never sent: Discord respects only `before` when both
 * are given, which would silently paginate backwards forever.
 *
 * The docs name no permission for this endpoint and `7R_Bot` created the event
 * itself, so it is expected to read. That is an expectation and not a
 * measurement (there is no test guild, ARCHITECTURE §9), so the caller must
 * treat a 403 as a missing grant rather than a reason to abandon the pass: the
 * attendance sample matters more than the RSVP list does.
 */
export async function listGuildScheduledEventUsers(
  options: DiscordRestOptions,
  guildId: string,
  eventId: string,
): Promise<ScheduledEventSubscriber[]> {
  const subscribers: ScheduledEventSubscriber[] = [];
  let after: string | null = null;

  while (true) {
    const query = `limit=${EVENT_USERS_PAGE}` +
      (after === null ? "" : `&after=${after}`);
    const page: ScheduledEventUser[] = await discordJson<ScheduledEventUser[]>(
      options,
      `/guilds/${guildId}/scheduled-events/${eventId}/users?${query}`,
    );

    for (const entry of page) {
      subscribers.push({
        id: entry.user.id,
        username: entry.user.username,
        displayName: entry.user.global_name ?? null,
      });
    }

    if (page.length < EVENT_USERS_PAGE) return subscribers;
    // Snowflakes exceed Number range, so the cursor is compared as BigInt. The
    // list is documented as ascending, but taking the max rather than the last
    // element costs nothing and cannot loop if it ever stops being.
    after = page
      .map((entry) => entry.user.id)
      .reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  }
}
