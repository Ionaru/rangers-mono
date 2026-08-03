import {
  type DiscordBotConfig,
  getDiscordBotConfig,
  getOpsConfig,
  loadAll,
  type OpsConfig,
} from "@7r/config";
import { configureLogging } from "@7r/logging";
import {
  describeWeeklyEvent,
  EVENT_LOCATION,
  opScheduleFrom,
} from "./weekly-event.ts";

/**
 * `deno task op:preview`: the dry-run gate before the weekly event goes live,
 * the sibling of `sync:preview`. It prints the coming Saturday's event (title,
 * window, announce moment) and the exact @everyone message it would post,
 * including the witty line and image it picked, and writes NOTHING: no database
 * row, no Discord call, whatever OP_EVENT_DRY_RUN says.
 *
 * It needs no database or TeamSpeak connection: the whole plan is a pure function
 * of the clock and the config, and the announcement is read from local files.
 */

function isoInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

async function main(): Promise<void> {
  const [bot, ops] = loadAll<[DiscordBotConfig, OpsConfig]>([
    getDiscordBotConfig,
    getOpsConfig,
  ]);

  /**
   * Turn the shared code's own logging on, in text, on stderr (ADR 0019).
   *
   * `describeWeeklyEvent` reaches two log lines that this preview exists to
   * show: the announcement text file and the image folder each report here when
   * they are configured but unreadable. Without this the preview would print
   * "no witty line" and "cover image (none)" and an operator could not tell a
   * bad path from an empty folder, which is exactly the diagnosis they came for.
   * stderr keeps them out of the printed plan below, which is stdout.
   */
  configureLogging({ shape: "text" });

  const { plan, title, coverImageName, announcement } =
    await describeWeeklyEvent(
      {
        guildId: bot.DISCORD_GUILD_ID,
        schedule: opScheduleFrom(ops),
        textFile: ops.OP_ANNOUNCE_TEXT_PATH,
        imageDir: ops.OP_ANNOUNCE_IMAGE_DIR,
      },
      new Date(),
    );

  const tz = ops.OP_TIMEZONE;

  console.log("\nweekly event preview: the coming Saturday op\n");
  console.log(`  date            ${plan.saturdayDate}`);
  console.log(`  title           ${title}`);
  console.log(`  location        ${EVENT_LOCATION}`);
  console.log(
    `  event window    ${isoInZone(plan.attendanceStart, tz)} -> ${
      isoInZone(plan.eventEnd, tz)
    }  (${tz})`,
  );
  console.log(
    `  announce at     ${isoInZone(plan.announceAt, tz)}  (${tz})`,
  );
  console.log(
    `  cover image     ${
      coverImageName ?? "(none - no image dir set, or no image chosen)"
    }`,
  );
  console.log(`  channel id      ${ops.OP_ANNOUNCE_CHANNEL_ID}`);
  console.log("\n  announcement it would post:\n");
  for (const line of announcement.split("\n")) {
    console.log(`    | ${line}`);
  }

  console.log(
    plan.withinWindow
      ? "\n  A live pass RIGHT NOW is inside the window and would create + announce " +
        "(unless already done)."
      : "\n  A live pass right now is OUTSIDE the window and would do nothing yet; " +
        "it acts from the announce moment above until the op starts.",
  );
  console.log(
    ops.OP_EVENT_DRY_RUN
      ? "\n  OP_EVENT_DRY_RUN=true: the worker is only logging, not posting. " +
        "Flip it to false to go live."
      : "\n  OP_EVENT_DRY_RUN=false: the worker is LIVE and will post for real.",
  );
}

// No exit code to gate on, unlike `env:check`: the preview either prints the plan
// or throws (a missing required config key), and a throw already exits non-zero.
if (import.meta.main) await main();
