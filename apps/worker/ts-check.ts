import { getTeamspeakConfig } from "@7r/config";
import { connectTeamspeak } from "@7r/teamspeak";
import { QueryProtocol, TeamSpeak } from "ts3-nodejs-library";

/**
 * TeamSpeak preflight. Read-only, and it asks the server rather than asking you.
 *
 *   deno task ts:check
 *
 * The worker treats a failed TeamSpeak connect at boot as fatal, so a wrong
 * `TS_VIRTUALSERVER_ID` or a bad query login does not merely break the link flow:
 * it crash-loops the worker, which fails the container healthcheck, which fails
 * `docker compose up --wait`, which fails the whole deploy. That is the intended
 * behaviour (a worker that cannot reach TeamSpeak can serve neither of its
 * routes), but it makes "is the TeamSpeak config right?" a question worth being
 * able to answer in five seconds instead of a deploy cycle.
 *
 * It connects, prints who we are and what virtual servers exist, and leaves.
 * It writes nothing.
 */

async function main() {
  const ts = getTeamspeakConfig();

  console.log(
    `connecting to ${ts.TS_QUERY_HOST}:${ts.TS_QUERY_PORT} over SSH as ${ts.TS_QUERY_USER}...\n`,
  );

  /**
   * Deliberately NOT `connectTeamspeak()`: that selects the virtual server, which
   * is the very thing we are here to diagnose. Connect, and stop short of the
   * step that fails.
   */
  const teamspeak = await TeamSpeak.connect({
    host: ts.TS_QUERY_HOST,
    protocol: QueryProtocol.SSH,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
  });

  try {
    const me = await teamspeak.whoami();
    console.log("the query login works:");
    console.log(`  client_login_name = ${me.clientLoginName}`);
    console.log(
      `  virtualserver_id  = ${me.virtualserverId ?? "(none selected)"}\n`,
    );

    const servers = await teamspeak.serverList();

    if (servers.length === 0) {
      console.log(
        "This instance has NO virtual servers. Nothing can be selected.",
      );
    } else {
      console.log("virtual servers on this instance:\n");
      for (const server of servers) {
        const chosen = String(server.id) === String(ts.TS_VIRTUALSERVER_ID)
          ? "  <-- TS_VIRTUALSERVER_ID points here"
          : "";
        console.log(
          `  sid=${server.id}  port=${server.port}  status=${server.status}  clients=${server.clientsonline}  "${server.name}"${chosen}`,
        );
      }

      const match = servers.find(
        (s) => String(s.id) === String(ts.TS_VIRTUALSERVER_ID),
      );

      console.log();
      if (!match) {
        console.log(
          `TS_VIRTUALSERVER_ID=${ts.TS_VIRTUALSERVER_ID} matches NONE of them, which is why the worker dies with "invalid serverID".`,
        );
        console.log(
          "The sid is an internal counter, not the voice port, and it is not reliably 1:",
        );
        console.log(
          "delete a virtual server and create another and the new one takes the next number.",
        );
        console.log(
          `\nSet TS_VIRTUALSERVER_ID to one of: ${
            servers.map((s) => s.id).join(", ")
          }`,
        );
      } else if (match.status !== "online") {
        console.log(
          `sid ${match.id} exists but its status is "${match.status}". A stopped virtual server cannot be selected.`,
        );
      } else {
        console.log(
          `TS_VIRTUALSERVER_ID=${ts.TS_VIRTUALSERVER_ID} is correct and that server is online.`,
        );

        // If the sid is right, prove the whole connect path the worker uses.
        const full = await connectTeamspeak({
          host: ts.TS_QUERY_HOST,
          queryport: ts.TS_QUERY_PORT,
          username: ts.TS_QUERY_USER,
          password: ts.TS_QUERY_PASS,
          virtualServerId: ts.TS_VIRTUALSERVER_ID,
          nickname: ts.TS_BOT_NICKNAME,
        });
        const clients = await full.clientList({ clientType: 0 });
        console.log(
          `\nThe worker's exact connect path works. ${clients.length} regular client(s) online.`,
        );
        full.forceQuit();
      }
    }
  } finally {
    teamspeak.forceQuit();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error("\nTeamSpeak preflight failed:\n");
    console.error(error);
    console.error(
      "\nIf the SSH connection itself was refused: check TS_QUERY_HOST, that the query port is the SSH one (10022, never 10011), that ServerQuery over SSH is enabled on the server, and that this box's IP is allowlisted rather than flood-banned.",
    );
    Deno.exit(1);
  }
  Deno.exit(0);
}
