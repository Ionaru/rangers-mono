import {
  type AttendanceChannelConfig,
  type DiscordBotConfig,
  getAttendanceChannelConfig,
  getDiscordBotConfig,
  getOpsConfig,
  getTeamspeakConfig,
  loadAll,
  type OpsConfig,
  type TeamspeakConfig,
} from "@7r/config";
import {
  closeDb,
  findOperationByDate,
  getDb,
  listRecentOperations,
  membersByTsUid,
} from "@7r/db";
import { listGuildScheduledEventUsers } from "@7r/discord";
import { isoInZone, planWeeklyOp } from "@7r/domain";
import { configureLogging } from "@7r/logging";
import {
  connectTeamspeak,
  getChannel,
  listChannelClients,
  listClients,
} from "@7r/teamspeak";
import { opScheduleFrom } from "./weekly-event.ts";

/**
 * `deno task attendance:preview`: prove the sampler is pointed at the right
 * channel, before a Saturday proves it is not.
 *
 * This is the sibling of `sync:preview` and `op:preview`, and it exists because
 * attendance has no dry-run switch and the way it fails is silent. A wrong
 * `TS_OPERATIONS_CHANNEL_CID` does not error, does not warn, and does not look
 * any different from an op nobody came to: `clientList`'s channel filter is
 * applied client-side, so an id that matches nothing simply returns an empty
 * list, every ninety seconds, forever. ADR 0007 already accepts that nobody will
 * notice quickly (the legacy recorder died in July 2024 and went unremarked for
 * two years), so the check has to happen up front.
 *
 * Hence the two numbers below: how many people are on the server, and how many
 * of them the channel filter kept. "0 of 0" is a quiet evening. "0 of 14" is a
 * wrong channel id.
 *
 * It writes NOTHING: no session, no RSVP row, no sample stamp.
 */

async function main(): Promise<number> {
  const [bot, ops, ts, attendance] = loadAll<
    [DiscordBotConfig, OpsConfig, TeamspeakConfig, AttendanceChannelConfig]
  >([
    getDiscordBotConfig,
    getOpsConfig,
    getTeamspeakConfig,
    getAttendanceChannelConfig,
  ]);

  // Text, on stderr, so the connection's own log lines stay out of the report
  // that stdout is (ADR 0019, as op:preview).
  configureLogging({ shape: "text" });

  const now = new Date();
  const tz = ops.OP_TIMEZONE;
  const plan = planWeeklyOp(now, opScheduleFrom(ops));
  const inWindow = now >= plan.attendanceStart && now < plan.attendanceEnd;
  const cid = attendance.TS_OPERATIONS_CHANNEL_CID;

  const db = getDb();
  const teamspeak = await connectTeamspeak({
    host: ts.TS_QUERY_HOST,
    queryport: ts.TS_QUERY_PORT,
    username: ts.TS_QUERY_USER,
    password: ts.TS_QUERY_PASS,
    virtualServerId: ts.TS_VIRTUALSERVER_ID,
    nickname: ts.TS_BOT_NICKNAME,
  });

  try {
    console.log(
      "\nattendance preview: is the sampler pointed at the right channel?\n",
    );

    console.log(`  op date         ${plan.saturdayDate}`);
    console.log(
      `  window          ${isoInZone(plan.attendanceStart, tz)} -> ${
        isoInZone(plan.attendanceEnd, tz)
      }  (${tz})`,
    );
    console.log(
      `  right now       ${
        inWindow
          ? "INSIDE the window: a live worker would be sampling"
          : "outside the window: a live worker would be idle"
      }`,
    );
    console.log(`  sample every    ${ops.ATTENDANCE_SAMPLE_SECONDS}s`);
    console.log(
      `  credit at       ${ops.ATTENDANCE_MIN_MINUTES} in-window minutes`,
    );

    // ------------------------------------------------------------ the channel

    const channel = await getChannel(teamspeak, cid);
    console.log(`\n  channel id      ${cid}`);
    if (channel === null) {
      console.log(
        `  channel name    *** NO CHANNEL WITH THIS ID ***`,
      );
    } else {
      console.log(`  channel name    ${channel.name}`);
    }

    const onServer = await listClients(teamspeak);
    const inChannel = await listChannelClients(teamspeak, cid);
    console.log(
      `  occupants       ${inChannel.length} of ${onServer.length} on the server`,
    );

    if (channel === null) {
      console.log(
        "\n*** TS_OPERATIONS_CHANNEL_CID NAMES NO CHANNEL. ***\n" +
          "Every op would be recorded as empty, silently. Fix it before the next Saturday.",
      );
      return 1;
    }

    if (inChannel.length === 0 && onServer.length > 0) {
      console.log(
        "\nNote: nobody is in this channel, but people are on the server. That is " +
          "normal outside an op. Check the channel NAME above is the Operations " +
          "channel, because an empty result is also what a wrong id looks like.",
      );
    }

    // ---------------------------------------------------------- who they are

    if (inChannel.length > 0) {
      const members = await membersByTsUid(db);
      console.log("\n  in the channel now:");
      for (const client of inChannel) {
        const member = members.get(client.uid);
        console.log(
          `    ${member ? member.displayName : client.nickname}` +
            `${
              member ? "" : "   (GUEST: this identity is linked to no member)"
            }`,
        );
      }
      const guests = inChannel.filter((c) => !members.has(c.uid)).length;
      if (guests > 0) {
        console.log(
          `\n  ${guests} unlinked. Their sessions are recorded as guests and adopt ` +
            `themselves\n  the moment that person runs /link; a leftover is ` +
            `claimed with /attendance claim.`,
        );
      }
    }

    // ------------------------------------------------------------ the RSVP list

    const [lastOp] = await listRecentOperations(db, 1);
    console.log(
      "\n  last op run     " + (lastOp?.date ?? "(none recorded yet)"),
    );
    if (lastOp) {
      console.log(
        `  last sampled    ${
          lastOp.lastSampleAt?.toISOString() ??
            "NEVER: the sampler has not recorded a single sample for it"
        }`,
      );
    }

    /**
     * The COMING op, looked up by its date rather than taken from the list
     * above: `listRecentOperations` only returns ops that have already started,
     * so on the Tuesday or Wednesday somebody actually runs this check, the op
     * whose Interested list we want to prove is readable is precisely the one
     * that list excludes. A read-only lookup, so previewing never creates a row.
     *
     * A 403 below is a missing grant on 7R_Bot, not a bug in this code.
     */
    const upcoming = await findOperationByDate(db, plan.saturdayDate);
    if (upcoming?.discordEventId) {
      try {
        const interested = await listGuildScheduledEventUsers(
          { botToken: bot.DISCORD_BOT_TOKEN },
          bot.DISCORD_GUILD_ID,
          upcoming.discordEventId,
        );
        console.log(`  interested      ${interested.length} on the event`);
      } catch (error) {
        console.log(`  interested      COULD NOT READ: ${error}`);
        console.log(
          "\n  The Interested list is the RSVP half of the feature and it is the " +
            "half\n  that can be lost without losing attendance. A 403 here is a " +
            "missing grant\n  on 7R_Bot, not a code fault; the sampler logs it and " +
            "carries on recording.",
        );
      }
    } else {
      console.log(
        "  interested      (no Discord event on the coming op yet, so no list to read)",
      );
    }

    console.log(
      "\nNothing was written. If the channel name above is the Operations channel, " +
        "the\nsampler will record the next op. There is no flag to flip: attendance " +
        "has no\ndry-run (see startAttendanceLoop).",
    );

    return 0;
  } finally {
    teamspeak.forceQuit();
  }
}

if (import.meta.main) {
  let code = 1;
  try {
    code = await main();
  } finally {
    await closeDb();
  }
  if (code > 0) Deno.exit(code);
}
