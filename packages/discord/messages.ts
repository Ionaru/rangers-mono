import { discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * Posting a message to a channel, as `7R_Bot`.
 *
 * Both callers are the weekly op (IMPLEMENTATION §7): the mission-maker ping that
 * asks for the event to be filled in, and the @everyone announcement in
 * #arma_general a day later. Both carry the event link, and posting that URL is
 * what makes Discord unfurl the event card (with its cover banner and its native
 * "Interested" button), so the message body does the RSVP plumbing for free and
 * the in-game image rides along on the event itself (events.ts), not as an
 * attachment here.
 *
 * The bot needs **Send Messages** in each channel, and **Mention @everyone** for a
 * ping to actually notify (without it the text renders but pings nobody: that
 * permission covers a non-mentionable role too, not just @everyone).
 */

/**
 * Who a message is allowed to ping. Discord will not resolve an @everyone in the
 * content unless it is permitted here (or `allowed_mentions` is omitted entirely,
 * which also permits it); passing it explicitly keeps the intent visible and stops
 * a stray @role or @user in a witty line from pinging by accident.
 *
 * `roles` is the by-id allowlist and is deliberately preferred over
 * `parse: ["roles"]` for the mission-maker ping: it names the one role that may be
 * notified rather than "whatever role mentions the content happens to contain".
 * Discord rejects a request that both parses a category and lists ids for it, so
 * the two are set one or the other, never together.
 */
export interface AllowedMentions {
  parse?: ("everyone" | "roles" | "users")[];
  /** Role ids permitted to ping. Must not be combined with `parse: ["roles"]`. */
  roles?: string[];
}

/**
 * A Discord timestamp markup for an instant, e.g. `<t:1753459200:F>`.
 *
 * Rendered by every client in the *reader's* own timezone and locale, which is
 * the point: the mission-maker ping states its deadline once and a member in
 * another country still reads it correctly, with no timezone label to explain.
 * Styles are Discord's: `F` long date+time, `f` short, `R` relative.
 */
export function discordTimestamp(
  date: Date,
  style: "F" | "f" | "R" = "F",
): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

/** Send a message to a channel. */
export async function createMessage(
  options: DiscordRestOptions,
  channelId: string,
  message: {
    content: string;
    allowedMentions?: AllowedMentions;
  },
): Promise<void> {
  await discordJson(options, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: message.content,
      allowed_mentions: message.allowedMentions,
    }),
  });
}

/** A channel message, reduced to what the announcement dedup reads. */
export interface ChannelMessage {
  id: string;
  content: string;
}

/**
 * The most recent `limit` messages in a channel (newest first, Discord's default
 * order).
 *
 * The weekly job reads these before it posts its @everyone, so a pass that posted
 * the announcement but crashed before recording `announced_at` does not re-ping the
 * whole guild: it finds its own prior message (by the event link it contains) and
 * skips (IMPLEMENTATION §7). Needs **View Channel + Read Message History**; the
 * caller treats a failure here as "not found" and posts, so a missing permission
 * only forfeits the dedup, it does not block the announcement.
 */
export function listChannelMessages(
  options: DiscordRestOptions,
  channelId: string,
  limit: number,
): Promise<ChannelMessage[]> {
  return discordJson<ChannelMessage[]>(
    options,
    `/channels/${channelId}/messages?limit=${limit}`,
  );
}
