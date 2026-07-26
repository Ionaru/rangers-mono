import { z } from "zod";
import * as schemas from "./schemas.ts";

/**
 * `deno task env:check`: a read-only config doctor.
 *
 * Since config moved to per-key GitHub Environment variables and secrets (ADR
 * 0018), the box `.env` is generated at deploy and nobody hand-maintains it. This
 * tells an operator, without a deploy, whether a `.env` (their intended one, or the
 * one the deploy assembled) has everything the platform needs: what is missing and
 * required (a boot failure), what is missing but defaulted (fine), and what is set
 * but read by no schema (stale, or ahead of the code).
 *
 * The zod schemas are the single source of truth for the key set, so this cannot
 * drift from what the services actually parse. It prints key **names** only, never
 * values, so it is safe to run in the deploy log.
 */

/** What a schema says about one key. */
export interface KeySpec {
  /** No default and not optional: absence is a boot failure. */
  required: boolean;
  /** The value used when the key is absent, or undefined if there is none. */
  default: unknown;
}

/**
 * Every config key across every schema, merged.
 *
 * Auto-discovers the schemas by scanning the module for `ZodObject`s, so a new
 * schema is covered the moment it is exported (no list to keep in step). Each field
 * is classified by parsing `undefined` against it: a schema field that rejects
 * `undefined` is required; one that accepts it is optional or defaulted, and the
 * parsed result is its default. Keys repeat across schemas that `.extend()` one
 * another; the merge keeps "required if required anywhere" and any default seen.
 */
export function collectSchemaKeys(
  modules: Record<string, unknown>,
): Map<string, KeySpec> {
  const known = new Map<string, KeySpec>();

  for (const value of Object.values(modules)) {
    if (!(value instanceof z.ZodObject)) continue;
    const shape = value.shape as Record<string, z.ZodType>;

    for (const [key, field] of Object.entries(shape)) {
      const probe = field.safeParse(undefined);
      const spec: KeySpec = {
        required: !probe.success,
        default: probe.success ? probe.data : undefined,
      };
      const existing = known.get(key);
      known.set(
        key,
        existing
          ? {
            required: existing.required || spec.required,
            default: existing.default ?? spec.default,
          }
          : spec,
      );
    }
  }

  return known;
}

/**
 * The keys a `.env` file actually sets (non-blank).
 *
 * Mirrors `loadConfig`'s rule that a blank value is not a set value: `FOO=` means
 * "not configured", so it is not reported as present. Comments and blank lines are
 * skipped, and surrounding quotes are stripped before the blank test so `FOO=''`
 * also reads as unset.
 */
export function parseEnvKeys(text: string): Set<string> {
  const keys = new Set<string>();

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    if (value !== "") keys.add(key);
  }

  return keys;
}

export interface EnvDiff {
  /** Required keys with no value and no `_FILE`: these break boot. */
  missingRequired: string[];
  /** Optional/defaulted keys not set: the default applies. */
  missingOptional: { key: string; default: unknown }[];
  /** Keys the file sets that no schema reads: stale, or ahead of the code. */
  unknown: string[];
}

/**
 * Compare what the schemas want against what a file sets.
 *
 * A key `X` counts as satisfied by either `X` or `X_FILE` (the mounted-secret
 * convention `loadConfig`/`resolveSecretFiles` honour), so `DATABASE_URL` provided
 * only as `DATABASE_URL_FILE` is not reported missing, and the `_FILE` partner of a
 * known key is not reported as unknown.
 */
export function diffEnv(
  known: Map<string, KeySpec>,
  present: Set<string>,
): EnvDiff {
  const satisfied = (key: string) =>
    present.has(key) || present.has(`${key}_FILE`);

  const missingRequired: string[] = [];
  const missingOptional: { key: string; default: unknown }[] = [];
  for (const [key, spec] of known) {
    if (satisfied(key)) continue;
    if (spec.required) missingRequired.push(key);
    else missingOptional.push({ key, default: spec.default });
  }

  const unknown: string[] = [];
  for (const key of present) {
    if (known.has(key)) continue;
    if (
      key.endsWith("_FILE") && known.has(key.slice(0, -"_FILE".length))
    ) continue;
    unknown.push(key);
  }

  return {
    missingRequired: missingRequired.sort(),
    missingOptional: missingOptional.sort((a, b) => a.key.localeCompare(b.key)),
    unknown: unknown.sort(),
  };
}

/** Render a default for display without ever printing a real configured value. */
function showDefault(value: unknown): string {
  if (value === undefined) return "(none)";
  return `default ${JSON.stringify(value)}`;
}

function fileArg(args: string[]): string {
  const flag = args.indexOf("--file");
  if (flag >= 0 && args[flag + 1]) return args[flag + 1];
  // Default matches the task's cwd (packages/config): the repo-root `.env`.
  return "../../.env";
}

async function main(): Promise<number> {
  const path = fileArg(Deno.args);

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    console.error(
      `env:check: cannot read ${path} (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
    console.error("Pass --file <path> to point at the .env to check.");
    return 1;
  }

  const diff = diffEnv(collectSchemaKeys(schemas), parseEnvKeys(text));

  console.log(`\nenv:check on ${path} (key names only, never values)\n`);

  if (diff.missingRequired.length > 0) {
    console.log("MISSING and REQUIRED (these break boot):");
    for (const key of diff.missingRequired) console.log(`  ! ${key}`);
    console.log("");
  }

  if (diff.missingOptional.length > 0) {
    console.log("missing, but optional (the default applies):");
    for (const { key, default: def } of diff.missingOptional) {
      console.log(`  - ${key}  (${showDefault(def)})`);
    }
    console.log("");
  }

  if (diff.unknown.length > 0) {
    console.log("set, but read by no schema (stale, or ahead of the code):");
    for (const key of diff.unknown) console.log(`  ? ${key}`);
    console.log("");
  }

  if (diff.missingRequired.length === 0) {
    console.log(
      diff.missingOptional.length === 0 && diff.unknown.length === 0
        ? "OK: every key is accounted for."
        : "OK: no required key is missing (see notes above).",
    );
    return 0;
  }

  console.log(
    `FAIL: ${diff.missingRequired.length} required key(s) missing; the worker or ` +
      `web app would fail to boot.`,
  );
  return 1;
}

if (import.meta.main) {
  const code = await main();
  if (code > 0) Deno.exit(code);
}
