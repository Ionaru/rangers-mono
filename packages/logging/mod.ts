import { AsyncLocalStorage } from "node:async_hooks";
import {
  configureSync,
  getConsoleSink,
  getJsonLinesFormatter,
  getTextFormatter,
  type LogLevel,
  type Sink,
} from "@logtape/logtape";

/**
 * Logging, for every process in the platform (ADR 0019).
 *
 * Two things live here and nowhere else: the one npm dependency
 * (`@logtape/logtape`, kept to a single manifest by the "one dependency, one
 * home" rule in the root deno.json), and the policy for what a log line looks
 * like and which ones survive.
 *
 * Everything that logs imports `getLogger` from here and nothing else. Getting a
 * logger is free and side-effect-free: an unconfigured LogTape logger is a
 * silent no-op, which is what makes a module-scope `getLogger(...)` safe in a
 * package that `astro build` executes at build time, and what keeps a library
 * from deciding logging policy for the process that imports it.
 *
 * The entry points decide the policy, exactly once, by calling
 * `configureLogging`.
 */

export { getLogger, withContext } from "@logtape/logtape";
export type { Logger } from "@logtape/logtape";

/**
 * The root of the category tree. Every logger in the platform hangs off it, so
 * one config entry can set a floor for the whole system and a deeper entry can
 * lift it for one subsystem.
 */
export const ROOT_CATEGORY = "7r";

/**
 * What the sink writes.
 *
 * - `json`: one JSON object per line, for the long-running services. Compose
 *   captures stdout and stderr into the `json-file` driver either way, and a
 *   line that is already structured survives a `grep` with its fields intact.
 * - `text`: one human line per record, all of it on **stderr**, for the one-shot
 *   operator CLIs. Those write their real output to stdout, so a log line that
 *   went there too would end up in the middle of the table somebody is reading.
 * - `off`: no sinks. For a CLI whose printed output IS the report
 *   (`sync:preview`), where the internal commentary is noise.
 */
export type LogShape = "json" | "text" | "off";

export interface LoggingOptions {
  /**
   * `LOG_LEVEL`, straight from `@7r/config`. Below this, nothing is emitted.
   *
   * The schema's four values are the ones an operator sets, not LogTape's six:
   * `warn` is spelled `warning` inside LogTape and is translated below. Adding
   * `trace` and `fatal` to the env schema would be offering levels that nothing
   * in this codebase logs at.
   */
  level?: "debug" | "info" | "warn" | "error";
  /** Defaults to `json`: the shape the services want, and the safer default. */
  shape?: LogShape;
}

/** The env schema's spelling, mapped onto LogTape's. */
const LEVELS: Record<NonNullable<LoggingOptions["level"]>, LogLevel> = {
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
};

/**
 * Everything on stderr, whatever the level.
 *
 * The default map splits a run across two streams (info to stdout, warnings and
 * errors to stderr), which is right for a service whose stdout nobody is reading
 * directly and wrong for a CLI, where stdout is the report.
 */
const ALL_TO_STDERR = {
  trace: "error",
  debug: "error",
  info: "error",
  warning: "error",
  error: "error",
  fatal: "error",
} as const;

/**
 * Whether `configureLogging` has already run. Not a courtesy: LogTape throws
 * `ConfigError` on a second `configureSync` without a reset, and the web app
 * calls this from middleware, which is to say on every single request.
 */
let configured = false;

/**
 * Install the logging policy for this process. First call wins; later calls are
 * no-ops.
 *
 * **Call it from an entry point, never from a package**, and never at module
 * scope in anything `astro build` might execute: it reads no environment itself,
 * but its caller passes `LOG_LEVEL` in, and parsing config at module scope is
 * what turns a missing production secret into a failed build (packages/config).
 *
 * Sync rather than async on purpose. `configure()` returns a promise and would
 * put an `await` in front of the first log line of every process, including the
 * Astro middleware where there is no startup hook to hide it in. The one thing
 * `configureSync` cannot take is an `AsyncDisposable` sink, and the console sink
 * is not one.
 */
export function configureLogging(options: LoggingOptions = {}): void {
  if (configured) return;
  configured = true;

  const shape = options.shape ?? "json";
  const lowestLevel = LEVELS[options.level ?? "info"];

  const sinks: Record<string, Sink> = shape === "off" ? {} : {
    out: getConsoleSink(
      shape === "json" ? { formatter: getJsonLinesFormatter() } : {
        levelMap: { ...ALL_TO_STDERR },
        formatter: getTextFormatter({
          timestamp: "time",
          // The properties are the point of a structured log line, and the
          // stock text formatter drops them: it renders only the message.
          format: ({ level, category, message, record }) =>
            Object.keys(record.properties).length === 0
              ? `${level} ${category}: ${message}`
              : `${level} ${category}: ${message} ${
                JSON.stringify(record.properties)
              }`,
        }),
      },
    ),
  };

  const sinkIds = shape === "off" ? [] : ["out"];

  configureSync({
    sinks,
    loggers: [
      { category: ROOT_CATEGORY, sinks: sinkIds, lowestLevel },
      /**
       * LogTape's own logger, which reports the one failure nothing else can:
       * a sink that threw. Kept at `warning` so it stays quiet in normal
       * operation, because at `info` it greets every boot with a paragraph
       * about how to configure the meta logger.
       */
      {
        category: ["logtape", "meta"],
        sinks: sinkIds,
        lowestLevel: "warning",
      },
    ],
    /**
     * What makes `withContext` work: properties attached once at the edge of a
     * request ride along with every line logged underneath it, including from
     * the detached deferred handlers the Discord interactions endpoint spawns,
     * which no threaded logger could reach.
     */
    contextLocalStorage: new AsyncLocalStorage(),
  });
}
