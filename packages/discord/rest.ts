/**
 * The Discord REST client: plain `fetch`, and it stays plain `fetch`.
 *
 * Not `@discordjs/rest`, which brings 9 transitive dependencies including a
 * second HTTP stack, to buy rate-limit bucketing worth nothing at roughly one
 * request every three minutes (IMPLEMENTATION §1). There is no gateway either
 * (ADR 0003).
 */

const API_BASE = "https://discord.com/api/v10";

/** A non-2xx from Discord, carrying the status so callers can tell 404 from 403. */
export class DiscordApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, path: string, body: string) {
    super(`Discord API ${status} for ${path}: ${body.slice(0, 300)}`);
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
  }
}

export interface DiscordRestOptions {
  botToken: string;
}

/**
 * One request, as the bot.
 *
 * `Authorization: Bot <token>` is the whole auth story: the bot token is not an
 * OAuth token and carries no user's consent. It is also why guild roles come
 * from here rather than from the login (IMPLEMENTATION §4): this works with the
 * user absent, needs no scope, and never expires.
 */
export async function discordFetch(
  { botToken }: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

/** As `discordFetch`, but a non-2xx throws and the body is parsed. */
export async function discordJson<T>(
  options: DiscordRestOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await discordFetch(options, path, init);
  if (!response.ok) {
    throw new DiscordApiError(response.status, path, await response.text());
  }
  return await response.json() as T;
}
