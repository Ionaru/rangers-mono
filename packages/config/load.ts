import type { z } from "zod";

export type EnvSource = Record<string, string | undefined>;

/**
 * Thrown at boot when the environment is not what the service needs. It lists
 * every problem at once, not the first one: fixing config one restart at a time
 * is how a five-minute deploy becomes an hour.
 */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * For any key `X`, `X_FILE` names a file whose contents are the real value.
 * This is the convention the postgres image itself uses, and it is how a
 * Docker Compose file-based secret, mounted at /run/secrets/*, becomes config.
 *
 * Only the database password and URL are mounted that way (ADR 0014). Every
 * other secret arrives as plain env, from the `.env` that Compose loads into
 * `web` and `worker`.
 *
 * **A mounted `X_FILE` beats an `X` set directly**, and that order is
 * load-bearing rather than arbitrary. The same `.env` also carries the
 * localhost `DATABASE_URL` that the host-side tasks (`deno task migrate`,
 * `web:dev`) need, so inside a container the two collide. Were the plain value
 * to win, `web` and `worker` would quietly dial `localhost:5432` inside their
 * own network namespace instead of reading the secret Compose mounted for them.
 *
 * Local development mounts nothing and sets no `X_FILE` at all, so a plain
 * `.env` still works there unchanged.
 */
function resolveSecretFiles(source: EnvSource): EnvSource {
  const resolved: EnvSource = { ...source };

  for (const [key, value] of Object.entries(source)) {
    if (!key.endsWith("_FILE") || value === undefined || value === "") continue;

    const target = key.slice(0, -"_FILE".length);

    try {
      resolved[target] = Deno.readTextFileSync(value).trim();
    } catch (cause) {
      throw new ConfigError([
        `${key}: cannot read the secret file at ${value} (${
          cause instanceof Error ? cause.message : String(cause)
        })`,
      ]);
    }
  }

  return resolved;
}

/**
 * Parse the environment against a schema and fail loud if it does not fit.
 *
 * Call this lazily (see mod.ts), never at module scope: `astro build` executes
 * module code, and CI has no environment, so a top-level parse turns a missing
 * production secret into a failed build.
 */
export function loadConfig<T extends z.ZodType>(
  schema: T,
  source: EnvSource = Deno.env.toObject(),
): z.infer<T> {
  // A key left blank in `.env` (`SYNC_DRY_RUN=`) arrives as "", which is
  // *defined*, and so beats the schema's `.default()` and fails the parse. An
  // unset key and a blank one mean the same thing to a human writing that file:
  // not configured. Treat them the same, or the safe default (SYNC_DRY_RUN
  // true) becomes a crash on a line someone meant to fill in later.
  const configured = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== ""),
  );

  const result = schema.safeParse(resolveSecretFiles(configured));

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const key = issue.path.join(".") || "(root)";
        return `${key}: ${issue.message}`;
      }),
    );
  }

  return result.data;
}

/** Wrap a loader so it parses once and reuses the result. */
export function memoize<T>(load: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= load());
}

/**
 * Run several loaders and report EVERY problem across all of them, not the first
 * group that happens to fail.
 *
 * A service needs more than one group of config (the worker needs a database, a
 * port, a shared token and a whole TeamSpeak connection), and each group is its
 * own schema. Calling them one after another means the first one throws and the
 * rest are never evaluated, so an operator setting the box up fixes one missing
 * variable, redeploys, and is told about the next: exactly the "five-minute
 * deploy becomes an hour" that `ConfigError` exists to prevent, reintroduced one
 * level up.
 *
 * Anything that is not a ConfigError is a real failure and is rethrown at once.
 */
export function loadAll<T extends readonly unknown[]>(
  loaders: { [K in keyof T]: () => T[K] },
): T {
  const values: unknown[] = [];
  const problems: string[] = [];

  for (const load of loaders) {
    try {
      values.push(load());
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(...error.problems);
      values.push(undefined);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return values as unknown as T;
}
