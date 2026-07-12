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
 * Docker Compose `secrets:` are files, mounted at /run/secrets/*, never
 * environment variables (IMPLEMENTATION.md §2: secrets never go in the image).
 * So for any key `X`, `X_FILE` names a file whose contents are the real value.
 * This is the convention the postgres image itself uses.
 *
 * `X` set directly still wins, which is what makes local development with a
 * plain .env file work unchanged.
 */
function resolveSecretFiles(source: EnvSource): EnvSource {
  const resolved: EnvSource = { ...source };

  for (const [key, value] of Object.entries(source)) {
    if (!key.endsWith("_FILE") || value === undefined || value === "") continue;

    const target = key.slice(0, -"_FILE".length);
    if (resolved[target] !== undefined && resolved[target] !== "") continue;

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
  const result = schema.safeParse(resolveSecretFiles(source));

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
