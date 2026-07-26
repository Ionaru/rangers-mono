import { discordJson, type DiscordRestOptions } from "./rest.ts";

/**
 * Posting a message to a channel, as `7R_Bot`.
 *
 * The one caller is the weekly op announcement (IMPLEMENTATION §7): an @everyone
 * ping in #arma_general carrying the event link, plus an optional witty line.
 * Posting the event's URL is what makes Discord unfurl the event card (with its
 * cover banner and its native "Interested" button), so the message body does the
 * RSVP plumbing for free and the in-game image rides along on the event itself
 * (events.ts), not as an attachment here.
 *
 * The bot needs **Send Messages** in the channel and **Mention @everyone** for the
 * ping to actually notify (without it the text renders but pings nobody).
 */

/**
 * Who a message is allowed to ping. Discord will not resolve an @everyone in the
 * content unless it is permitted here (or `allowed_mentions` is omitted entirely,
 * which also permits it); passing it explicitly keeps the intent visible and stops
 * a stray @role or @user in a witty line from pinging by accident.
 */
export interface AllowedMentions {
  parse: ("everyone" | "roles" | "users")[];
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
