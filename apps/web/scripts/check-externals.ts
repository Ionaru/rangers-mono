import { readdir, readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { join } from "node:path";

/**
 * Fails when the SSR bundle imports a package the runtime cannot resolve.
 *
 * `astro build` leaves some packages external (they are `import`ed from
 * `dist/server` at runtime) and inlines the rest. An external that is not
 * installed in the image only fails when the server first loads it, which is
 * after deploy. Run as `node scripts/check-externals.ts [dir]` (default
 * `dist/server`) inside the runtime image, it turns that into a failed build.
 *
 * Node builtins only: it has to run in an image that has nothing else.
 */

// `import x from "s"`, `import {a} from "s"`, `import * as n from "s"`,
// `export * from "s"`, `export {a} from "s"`, including minified forms and
// clauses spread over several lines. The clause may not contain a quote or a
// semicolon, so it cannot run on into a different statement.
const STATIC_FROM =
  /\b(?:import|export)\s*(?:type\s+)?[^"'`;]*?\bfrom\s*(["'])([^"'\n]+)\1/g;
// `import "s"`: a side-effect import has no clause.
const SIDE_EFFECT = /\bimport\s*(["'])([^"'\n]+)\1/g;
// `import("s")`: only a string literal; `import(x)` is ignored.
const DYNAMIC = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;
// `require("s")` and the bundler's `__require("s")`: only a string literal, and
// only where `require` is not the tail of a longer identifier (`xrequire`) or a
// property (`module.require`); `__require` is the one prefix allowed.
const REQUIRE = /(?<![\w$.])(?:__)?require\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

/**
 * Requires that are allowed to be missing at runtime: the bundler output wraps
 * each in a try/catch, so a copy that is not installed is harmless. A string is
 * an exact specifier, a RegExp is tested against it.
 */
export const OPTIONAL_REQUIRES: readonly (string | RegExp)[] = [
  // `debug` requires it inside a try/catch to colour its output, and falls back
  // to plain output when it is not installed.
  "supports-color",
  // `sharp` requires `@img/sharp-libvips-dev/<dir>` inside a try/catch to find
  // a development libvips, which only exists on a machine that built one.
  /^@img\/sharp-libvips-dev\//,
];

function isBare(specifier: string): boolean {
  if (
    specifier === "" ||
    specifier.startsWith(".") ||
    specifier.startsWith("/")
  ) {
    return false;
  }
  if (/^(?:data|https?|file|node):/.test(specifier)) return false;
  return !isBuiltin(specifier);
}

/** The distinct bare package specifiers a module imports or requires, in first-seen order. */
export function bareSpecifiers(source: string): string[] {
  const found: { index: number; specifier: string }[] = [];
  for (const pattern of [STATIC_FROM, SIDE_EFFECT, DYNAMIC, REQUIRE]) {
    for (const match of source.matchAll(pattern)) {
      found.push({ index: match.index, specifier: match[2] });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const result: string[] = [];
  for (const { specifier } of found) {
    if (isBare(specifier) && !result.includes(specifier))
      result.push(specifier);
  }
  return result;
}

function isOptional(specifier: string): boolean {
  return OPTIONAL_REQUIRES.some((optional) =>
    typeof optional === "string"
      ? optional === specifier
      : optional.test(specifier),
  );
}

async function* moduleFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* moduleFiles(path);
    else if (/\.(?:mjs|js)$/.test(entry.name)) {
      yield path;
    }
  }
}

async function externals(dir: string): Promise<string[]> {
  const all = new Set<string>();
  for await (const file of moduleFiles(dir)) {
    for (const specifier of bareSpecifiers(await readFile(file, "utf8"))) {
      all.add(specifier);
    }
  }
  return [...all].sort();
}

/** The bare specifiers under `dir` that cannot be resolved from this script's location, sorted. */
export async function missingExternals(dir: string): Promise<string[]> {
  const missing: string[] = [];
  for (const specifier of await externals(dir)) {
    if (isOptional(specifier)) continue;
    try {
      import.meta.resolve(specifier);
    } catch {
      missing.push(specifier);
    }
  }
  return missing;
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "dist/server";
  try {
    const missing = await missingExternals(dir);
    if (missing.length > 0) {
      for (const specifier of missing) console.log(`missing: ${specifier}`);
      process.exit(1);
    }
    console.log(
      `${(await externals(dir)).length} externals checked, none missing`,
    );
  } catch (error) {
    console.error(
      `check-externals: cannot scan ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
