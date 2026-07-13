/**
 * Errors go where somebody will see them.
 *
 * The worker is a background process on a box nobody logs into. Without this, a
 * dropped TeamSpeak connection or a failing job is a line in a log file that is
 * read for the first time when a member complains, weeks later. That is the
 * failure mode the whole "observability" bullet in ARCHITECTURE §6 exists to
 * prevent, and a Discord webhook is the cheapest thing that prevents it.
 *
 * Best-effort by construction. An alert that throws, or that blocks, would turn
 * "something went wrong" into "something went wrong and the worker died", which
 * is strictly worse than a lost alert. It also no-ops when no webhook is
 * configured (packages/config), because refusing to boot over a missing webhook
 * would be a lie about how important it is.
 */
export function makeAlerter(
  webhookUrl: string | undefined,
  log: (message: string, extra?: Record<string, unknown>) => void,
): (summary: string, detail?: unknown) => void {
  if (!webhookUrl) {
    log("no ERROR_ALERT_DISCORD_WEBHOOK configured, alerts go to stdout only");
    return (summary, detail) =>
      log(`ALERT: ${summary}`, { detail: String(detail ?? "") });
  }

  return (summary, detail) => {
    log(`ALERT: ${summary}`, { detail: String(detail ?? "") });

    const content = [
      `**worker**: ${summary}`,
      detail ? "```" + String(detail).slice(0, 1500) + "```" : "",
    ].filter(Boolean).join("\n");

    // Deliberately not awaited: an alert must never be on the critical path of
    // the thing it is reporting on. Failures are swallowed, because the only
    // thing we could do about a failed alert is log it, which we already did.
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((cause) => {
      log("failed to post alert to Discord", { error: String(cause) });
    });
  };
}
