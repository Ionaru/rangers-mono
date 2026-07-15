import {
  ClientType,
  QueryProtocol,
  TeamSpeak,
  type TeamSpeakClient,
} from "ts3-nodejs-library";

/**
 * The ServerQuery connection. The worker holds exactly one, for the lifetime of
 * the process, and it is the only thing in the system that talks to TeamSpeak.
 *
 * `apps/web` must never import this package. That is the entire reason the
 * worker exposes /internal/ts/* over HTTP (ARCHITECTURE §2): the connection is
 * stateful and single, so it lives in one process and the website asks it
 * questions. This package therefore carries no package.json, only a deno.json,
 * which makes it unresolvable from Astro's bundler by construction (ADR 0006).
 *
 * None of this is covered by tests. There is no dockerised TeamSpeak and there
 * will not be one (ARCHITECTURE §9), so the transport is first exercised against
 * the live server. What that buys is bounded here: Phase 2 only *reads* the
 * client list and sends a poke. It writes nothing on TeamSpeak. The dangerous
 * writes are the group reconcile, and they arrive in Phase 4 behind
 * SYNC_DRY_RUN and the blast-radius guard.
 */

/**
 * The live connection, as far as the rest of the codebase is concerned.
 *
 * An alias for the library's own type, exported so that nothing outside this
 * package has to import `ts3-nodejs-library` to hold a connection. The worker
 * passes one of these around; it never names the library, and the library is
 * declared as a dependency of this package alone. That is what keeps the
 * transport swappable for TeamSpeak 6 (ARCHITECTURE §10) instead of leaking its
 * types into every file that touches it.
 */
export type TeamspeakConnection = TeamSpeak;

export interface TeamspeakConnectionOptions {
  host: string;
  /** SSH, and never 10011: see below. */
  queryport: number;
  username: string;
  password: string;
  /** The virtual server to select (`sid`), not a port. */
  virtualServerId: number;
  nickname: string;
}

/** An online TeamSpeak client, reduced to the three things the link flow needs. */
export interface OnlineClient {
  /** The *connection* id. Ephemeral: valid only while they stay connected, and what a poke is addressed to. */
  clid: string;
  /** The identity. Durable, and what gets stored on the member. */
  uid: string;
  nickname: string;
}

/**
 * Connect, log in, and select the virtual server.
 *
 * **SSH, always.** TeamSpeak is reached across the public internet
 * (`ts.7th-ranger.com`), so raw ServerQuery on 10011 would put the query
 * password in cleartext on the wire at every single reconnect. The config schema
 * refuses port 10011 outright (packages/config), and this function hardcodes the
 * SSH protocol rather than making it a parameter, so there is no argument anyone
 * can pass that downgrades it. The interface stays swappable for TeamSpeak 6
 * (ARCHITECTURE §10); it does not stay swappable for cleartext.
 */
export async function connectTeamspeak(
  options: TeamspeakConnectionOptions,
): Promise<TeamSpeak> {
  const teamspeak = await TeamSpeak.connect({
    host: options.host,
    protocol: QueryProtocol.SSH,
    queryport: options.queryport,
    username: options.username,
    password: options.password,
    // Idle ServerQuery connections get dropped. This is a process that may sit
    // untouched from Sunday to Saturday.
    keepAlive: true,
  });

  // Selecting the virtual server is what turns a bare query connection into one
  // that can see clients. The nickname is set in the same call, because a query
  // client has no nickname until it has a server to have one on.
  try {
    await teamspeak.useBySid(String(options.virtualServerId), options.nickname);
  } catch (cause) {
    /**
     * The most likely failure here, by some distance, is that
     * `TS_VIRTUALSERVER_ID` names a virtual server that does not exist, and
     * TeamSpeak's answer to that is the magnificently unhelpful "invalid
     * serverID" plus a stack trace through the library.
     *
     * The `sid` is an internal counter, not the port people connect to, and it is
     * NOT reliably 1: delete a virtual server and create another and the new one
     * gets the next number. This unit's TeamSpeak was rebuilt at some point
     * (MIGRATION.md notes the group ids come in two families because of it), so
     * "surely it is 1" is exactly the assumption that breaks here.
     *
     * `serverlist` is an instance-level command and needs no server selected, so
     * we can simply ask, and put the answer in the same message as the failure.
     * The worker crash-loops on this, so the fix has to be legible in the log the
     * operator is already staring at.
     */
    let available = "(could not list the virtual servers either)";
    try {
      const servers = await teamspeak.serverList();
      available = servers.length === 0
        ? "(this TeamSpeak instance has no virtual servers at all)"
        : servers
          .map((s) =>
            `sid=${s.id} port=${s.port} status=${s.status} name=${s.name}`
          )
          .join("\n  ");
    } catch {
      /* keep the original failure; the list is a bonus, not the point */
    }

    teamspeak.forceQuit();

    throw new Error(
      `TeamSpeak refused to select virtual server ${options.virtualServerId} ` +
        `(TS_VIRTUALSERVER_ID). The virtual servers this instance actually has:\n  ` +
        available +
        `\n\nThe sid is an internal id, not the voice port. Set TS_VIRTUALSERVER_ID to one of the sids above.`,
      { cause },
    );
  }

  return teamspeak;
}

/**
 * Keep the connection alive across drops, forever.
 *
 * The listeners are registered **once, here**, and never again. That is the
 * point of doing it in one place: the legacy's reconnect had to call
 * `removeAllListeners` before re-adding handlers precisely because it re-bound
 * them on every reconnect and leaked a set each time. `reconnect()` restores the
 * library's own context (it re-selects the server and re-registers its
 * subscriptions), so there is nothing for us to re-bind and nothing to clean up.
 *
 * `reconnect(-1, ...)` retries indefinitely. It has to: a TeamSpeak server that
 * is down for an hour must not leave a worker that never reconnects, because the
 * only thing that would fix it is somebody noticing.
 */
export function keepConnected(
  teamspeak: TeamSpeak,
  log: (message: string, extra?: Record<string, unknown>) => void,
): void {
  teamspeak.on("error", (error) => {
    log("teamspeak error", { error: String(error) });
  });

  teamspeak.on("close", async (error) => {
    log("teamspeak connection closed, reconnecting", {
      error: error ? String(error) : undefined,
    });
    try {
      await teamspeak.reconnect(-1, 5_000);
      log("teamspeak reconnected");
    } catch (cause) {
      // reconnect(-1) does not give up, so arriving here means it was told to
      // stop (a deliberate quit) or something threw outside the retry loop.
      log("teamspeak reconnect failed", { error: String(cause) });
    }
  });

  teamspeak.on("flooding", (error) => {
    // The library backs off and retries on its own (524). Worth a line, because
    // an IP that is not allowlisted hits the 10-commands-per-3-seconds limit and
    // this is the only symptom (ARCHITECTURE §4.4).
    log("teamspeak flood limit hit, backing off", { error: String(error) });
  });
}

/**
 * The real people currently connected.
 *
 * Filtered to `ClientType.Regular`, which excludes ServerQuery clients: our own
 * bot is one, and offering a member the chance to link their identity to the bot
 * would be a memorable bug.
 */
export async function listClients(
  teamspeak: TeamSpeak,
): Promise<OnlineClient[]> {
  const clients: TeamSpeakClient[] = await teamspeak.clientList({
    clientType: ClientType.Regular,
  });

  return clients.map((client) => ({
    clid: client.clid,
    uid: client.uniqueIdentifier,
    nickname: client.nickname,
  }));
}

/** A server group, reduced to what the mapping needs. */
export interface ServerGroup {
  sgid: string;
  name: string;
}

/**
 * Every server group on the virtual server.
 *
 * Resolved by NAME, never by the ids in the legacy dump: that dump holds two
 * families of ids for the same group names, because the server was rebuilt at
 * some point, and the stored numbers may be dead (MIGRATION.md).
 */
export async function listServerGroups(
  teamspeak: TeamspeakConnection,
): Promise<ServerGroup[]> {
  const groups = await teamspeak.serverGroupList();
  return groups.map((group) => ({ sgid: group.sgid, name: group.name }));
}

/** A TeamSpeak identity that holds a server group. */
export interface ServerGroupMember {
  /** The durable database id on the TeamSpeak server. */
  cldbid: string;
  /** The identity, which is what `member.ts_uid` stores. */
  uid: string;
  nickname: string;
}

/**
 * Who currently holds a server group.
 *
 * This is what makes TeamSpeak usable as a *source* of truth for the one thing it
 * is still the truth for: the badges. Badges never existed as Discord roles, so
 * the live TeamSpeak groups are the only current record of who has earned what
 * (the legacy database's grants are years out of date).
 *
 * `servergroupclientlist -names` hands back the client's unique identifier
 * directly, so the uid needs no second lookup and this stays one call per group.
 */
export async function listServerGroupMembers(
  teamspeak: TeamspeakConnection,
  sgid: string,
): Promise<ServerGroupMember[]> {
  const entries = await teamspeak.serverGroupClientList(sgid);
  return entries.map((entry) => ({
    cldbid: entry.cldbid,
    uid: entry.clientUniqueIdentifier,
    nickname: entry.clientNickname,
  }));
}

/**
 * Poke a client: a dialog box in their TeamSpeak, which is the only channel we
 * have to them.
 *
 * A poke, specifically, and not a text message. Members cannot see the query
 * client in the tree without an obscure setting, so they cannot message it and a
 * reply-based flow was a dead end (OPEN-QUESTIONS Q10). A poke arrives whether
 * or not they can see the sender.
 *
 * Addressed by `clid`, the connection id, so it goes to that connection and
 * nobody else's. If the member picked the wrong person from the list, the code
 * goes to *that* person and the link simply cannot be completed. That is the
 * whole safety argument for the flow, and it rests on this line.
 */
export async function pokeClient(
  teamspeak: TeamSpeak,
  clid: string,
  message: string,
): Promise<void> {
  await teamspeak.clientPoke(clid, message);
}
