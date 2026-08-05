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
 * window, prep and announce moments) and the exact messages it would post: the
 * mission-maker ping and the @everyone announcement, including the witty line and
 * image it picked. It writes NOTHING: no database row, no Discord call, whatever
 * OP_EVENT_DRY_RUN says.
 *
 * The prep ping's deadline prints as raw `<t:…>` markup, which is what goes on the
 * wire; Discord renders it as a local date and time in the reader's own timezone.
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

  const { plan, title, coverImageName, prepPing, announcement } =
    await describeWeeklyEvent(
      {
        guildId: bot.DISCORD_GUILD_ID,
        schedule: opScheduleFrom(ops),
        textFile: ops.OP_ANNOUNCE_TEXT_PATH,
        imageDir: ops.OP_ANNOUNCE_IMAGE_DIR,
        prepMentionRoleId: ops.OP_PREP_MENTION_ROLE_ID,
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
    `  prep at         ${isoInZone(plan.prepareAt, tz)}  (${tz})${
      ops.OP_PREP_CHANNEL_ID
        ? ""
        : "  (no OP_PREP_CHANNEL_ID: no prep step, same moment as the announcement)"
    }`,
  );
  console.log(
    `  announce at     ${isoInZone(plan.announceAt, tz)}  (${tz})`,
  );
  console.log(
    `  cover image     ${
      coverImageName ?? "(none - no image dir set, or no image chosen)"
    }`,
  );
  console.log(
    `  prep ping to    ${ops.OP_PREP_CHANNEL_ID ?? "(none - step disabled)"}`,
  );
  console.log(`  announce to     ${ops.OP_ANNOUNCE_CHANNEL_ID}`);

  if (ops.OP_PREP_CHANNEL_ID) {
    console.log("\n  mission-maker ping it would post at the prep moment:\n");
    for (const line of prepPing.split("\n")) {
      console.log(`    | ${line}`);
    }
    if (!ops.OP_PREP_MENTION_ROLE_ID) {
      console.log(
        "\n  (no OP_PREP_MENTION_ROLE_ID: the ping mentions nobody and so notifies nobody)",
      );
    }
  }

  console.log("\n  announcement it would post:\n");
  for (const line of announcement.split("\n")) {
    console.log(`    | ${line}`);
  }

  console.log(
    plan.withinWindow
      ? plan.withinAnnounceWindow
        ? "\n  A live pass RIGHT NOW is past the announce moment and would create + announce " +
          "(unless already done)."
        : "\n  A live pass RIGHT NOW is between the prep and announce moments: it would " +
          "create the event and ping the mission makers, and hold the @everyone back."
      : "\n  A live pass right now is OUTSIDE the window and would do nothing yet; " +
        "it acts from the prep moment above until the op starts.",
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
