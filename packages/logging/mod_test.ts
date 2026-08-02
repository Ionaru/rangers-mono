import { assert, assertThrows } from "@std/assert";
import { configureSync, getConfig, resetSync } from "@logtape/logtape";
import { configureLogging } from "./mod.ts";

/**
 * One test, and it is about a latch rather than about logging.
 *
 * `configureLogging` remembers that it has run so the web app can call it from
 * middleware on every request. The dangerous version of that memory is the one
 * that records the attempt instead of the success: `configureSync` throws on a
 * double-configure, and a flag set before the call would leave the process
 * latched as "configured" with no sinks installed. An unconfigured LogTape
 * logger is silent, so every line in the process would then be dropped, for the
 * life of the process, with nothing anywhere saying why.
 *
 * Deliberately a single test rather than several. It walks global state
 * (LogTape's, and this module's own one-shot flag) through failure and back,
 * and splitting it would leave the halves depending on the order Deno happened
 * to run them in.
 */
Deno.test("a failed configure does not latch the process into silence", () => {
  // Occupy LogTape's global config so the next configureSync has to throw. The
  // meta logger is named with no sinks only to keep LogTape's "loggers are
  // configured" banner out of the test output.
  configureSync({
    sinks: {},
    loggers: [{ category: ["logtape", "meta"], sinks: [], lowestLevel: null }],
  });

  try {
    assertThrows(() => configureLogging({ shape: "off" }));
  } finally {
    resetSync();
  }

  // The point: the failure above must not have consumed the one-shot.
  configureLogging({ shape: "off" });
  assert(getConfig() !== null, "logging should be configured after a retry");

  // And now it really is a one-shot: a second call is a no-op, not a throw.
  configureLogging({ shape: "off" });

  resetSync();
});
