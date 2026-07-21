/**
 * The ServerQuery command budget.
 *
 * TeamSpeak refuses a query client that sends more than
 * `serverinstance_serverquery_flood_commands` (default 10) commands in
 * `serverinstance_serverquery_flood_time` (default 3) seconds. It answers error
 * 524, and `ts3-nodejs-library` reacts by re-sending the *same* command about a
 * second later, forever, with no backoff and no attempt counter. So a burst does
 * not fail loudly: it degrades to roughly one command per second and stays there
 * until the burst drains, holding the single ServerQuery connection the whole
 * time. Phase 4 shipped a reconcile that issued two commands per member, which
 * on a hundred members meant three and a half minutes of that, every five
 * minutes, with the link flow's own commands queued behind it.
 *
 * The documented answer is to IP-allowlist the query login, which lifts the
 * limit entirely (ARCHITECTURE §4.4). That is an operator action on a server we
 * do not deploy, it was not in force when this was written, and nothing in the
 * codebase can tell whether it is. So the worker paces itself instead: correct
 * with or without the allowlist, and with it the ceiling simply never binds.
 *
 * No I/O and no dependency on the library, so the one thing here that can be
 * wrong (the arithmetic of the sliding window) is unit-testable, which nothing
 * else in this package is (ARCHITECTURE §9).
 */

/** The seam that makes this testable: virtual time in tests, real time in the worker. */
export interface ThrottleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * `performance.now()`, not `Date.now()`: it is monotonic. A wall clock that
 * steps backwards over an NTP correction would release a burst early, and one
 * that steps forwards would stall the worker for the size of the jump.
 */
export const systemClock: ThrottleClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** TeamSpeak's `serverinstance_serverquery_flood_time`, in milliseconds. */
export const FLOOD_WINDOW_MS = 3_000;

/**
 * Eight of TeamSpeak's ten. The missing two are not caution for its own sake:
 * they pay for the commands that reach the wire without passing through here,
 * which is the library's own 524 re-sends (it re-sends from a bare timer,
 * bypassing its queue) and the priorized handshake commands below.
 */
export const MAX_COMMANDS_PER_WINDOW = 8;

export interface CommandThrottleOptions {
  /** Commands allowed per window. Must be at least 1. */
  maxCommands?: number;
  windowMs?: number;
  clock?: ThrottleClock;
}

/** What the throttle has done, for the logs. Cumulative, never reset. */
export interface CommandThrottleStats {
  /** Commands charged against the budget, gated or not. */
  commands: number;
  /** Total time spent waiting for a slot. The pressure signal. */
  waitedMs: number;
}

export interface CommandThrottle {
  /** Run `send` when the budget allows, one command at a time. */
  run<T>(send: () => Promise<T>): Promise<T>;
  /**
   * Charge the budget for a command that is being sent WITHOUT waiting. The
   * escape hatch for commands that cannot be deferred (see client.ts): they
   * still count against the window, they just do not queue behind it.
   */
  charge(): void;
  stats(): CommandThrottleStats;
}

export function createCommandThrottle(
  options: CommandThrottleOptions = {},
): CommandThrottle {
  const maxCommands = options.maxCommands ?? MAX_COMMANDS_PER_WINDOW;
  const windowMs = options.windowMs ?? FLOOD_WINDOW_MS;
  const clock = options.clock ?? systemClock;

  // Refuse rather than degrade. A zero here would disable the throttle silently
  // (an empty window is always "not full"), and the operator most likely to set
  // it is the one trying to make an incident go away at two in the morning.
  if (!Number.isInteger(maxCommands) || maxCommands < 1) {
    throw new Error(
      `command throttle: maxCommands must be a whole number >= 1, got ${maxCommands}`,
    );
  }
  if (!(windowMs > 0)) {
    throw new Error(`command throttle: windowMs must be > 0, got ${windowMs}`);
  }

  /** Send times of the last `maxCommands` commands, oldest first. */
  const sent: number[] = [];
  let commands = 0;
  let waitedMs = 0;

  /**
   * The serialization tail.
   *
   * The library already keeps exactly one command in flight, so waiting for the
   * previous command to SETTLE costs nothing in throughput and buys the thing a
   * send-only spacer cannot: commands never pile up inside the library. A spacer
   * that only counts departures would spend a whole window feeding commands into
   * a queue stalled behind a 524 re-send, and then release them in one burst the
   * moment it cleared, which is the flood it was installed to prevent.
   */
  let tail: Promise<unknown> = Promise.resolve();

  const waitForSlot = async (): Promise<void> => {
    while (true) {
      const cutoff = clock.now() - windowMs;
      while (sent.length > 0 && sent[0] <= cutoff) sent.shift();
      if (sent.length < maxCommands) return;
      // Always positive: anything at or before the cutoff was just dropped.
      const wait = sent[0] + windowMs - clock.now();
      waitedMs += wait;
      await clock.sleep(wait);
    }
  };

  const charge = () => {
    commands++;
    sent.push(clock.now());
    while (sent.length > maxCommands) sent.shift();
  };

  return {
    run<T>(send: () => Promise<T>): Promise<T> {
      const result = tail.then(async () => {
        await waitForSlot();
        charge();
        return await send();
      });
      // Swallow here and here only: `result` is handed to the caller, who owns
      // the rejection. Without this the tail would reject too, poisoning every
      // command behind it and surfacing as an unhandled rejection besides.
      tail = result.then(() => {}, () => {});
      return result;
    },
    charge,
    stats: () => ({ commands, waitedMs }),
  };
}
