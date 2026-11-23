import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bareSpecifiers, missingExternals } from "./check-externals.ts";

test("bareSpecifiers: default import", () => {
  assert.deepEqual(bareSpecifiers(`import x from "zod";`), ["zod"]);
});

test("bareSpecifiers: named imports, single quotes", () => {
  assert.deepEqual(bareSpecifiers(`import {a, b} from 'postgres';`), ["postgres"]);
});

test("bareSpecifiers: named imports spread over several lines", () => {
  const src = `import {\n  a,\n  b,\n  c\n} from "drizzle-orm";\n`;
  assert.deepEqual(bareSpecifiers(src), ["drizzle-orm"]);
});

test("bareSpecifiers: namespace import", () => {
  assert.deepEqual(bareSpecifiers(`import * as n from "zod";`), ["zod"]);
});

test("bareSpecifiers: side-effect import", () => {
  assert.deepEqual(bareSpecifiers(`import "some-polyfill";`), ["some-polyfill"]);
});

test("bareSpecifiers: export * from", () => {
  assert.deepEqual(bareSpecifiers(`export * from "zod";`), ["zod"]);
});

test("bareSpecifiers: export { a } from", () => {
  assert.deepEqual(bareSpecifiers(`export { a } from "zod";`), ["zod"]);
});

test("bareSpecifiers: dynamic import with a literal", () => {
  assert.deepEqual(bareSpecifiers(`const m = await import("zod");`), ["zod"]);
});

test("bareSpecifiers: minified forms without spaces", () => {
  assert.deepEqual(bareSpecifiers(`import{a as b}from"zod";`), ["zod"]);
  assert.deepEqual(bareSpecifiers(`import"side-effect";`), ["side-effect"]);
  assert.deepEqual(bareSpecifiers(`export*from"star-pkg";`), ["star-pkg"]);
  assert.deepEqual(bareSpecifiers(`export{a}from"named-pkg";`), ["named-pkg"]);
  assert.deepEqual(bareSpecifiers(`const m=import("dyn-pkg");`), ["dyn-pkg"]);
});

test("bareSpecifiers: excludes relative and absolute specifiers", () => {
  const src = [
    `import a from "./x.mjs";`,
    `import b from "../x.mjs";`,
    `import c from "/x.mjs";`,
  ].join("\n");
  assert.deepEqual(bareSpecifiers(src), []);
});

test("bareSpecifiers: excludes node: specifiers and builtin names", () => {
  const src = [
    `import fs from "node:fs";`,
    `import { createHash } from "crypto";`,
    `import path from "path";`,
    `import "fs";`,
  ].join("\n");
  assert.deepEqual(bareSpecifiers(src), []);
});

test("bareSpecifiers: excludes data: and http(s): URLs", () => {
  const src = [
    `import a from "data:text/javascript,export default 1";`,
    `import b from "http://example.com/x.mjs";`,
    `import c from "https://example.com/x.mjs";`,
  ].join("\n");
  assert.deepEqual(bareSpecifiers(src), []);
});

test("bareSpecifiers: keeps the full specifier including a subpath", () => {
  const src = [
    `import a from "better-auth/adapters/drizzle";`,
    `import b from "@scope/pkg/sub";`,
    `import c from "@scope/pkg";`,
  ].join("\n");
  assert.deepEqual(bareSpecifiers(src), [
    "better-auth/adapters/drizzle",
    "@scope/pkg/sub",
    "@scope/pkg",
  ]);
});

test("bareSpecifiers: ignores dynamic imports with a non-literal argument", () => {
  const src = `const m = await import(x);\nawait import(\`./\${y}.mjs\`);\n`;
  assert.deepEqual(bareSpecifiers(src), []);
});

test("bareSpecifiers: distinct, in first-seen order", () => {
  const src = [
    `import a from "zod";`,
    `import b from "postgres";`,
    `import { c } from "zod";`,
    `const d = await import("drizzle-orm");`,
    `import e from "postgres";`,
  ].join("\n");
  assert.deepEqual(bareSpecifiers(src), ["zod", "postgres", "drizzle-orm"]);
});

test("bareSpecifiers: empty source has no specifiers", () => {
  assert.deepEqual(bareSpecifiers(""), []);
});

test("missingExternals: returns only the unresolvable bare specifiers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-externals-"));
  try {
    await mkdir(join(dir, "chunks"));
    await writeFile(
      join(dir, "entry.mjs"),
      [
        `import { z } from "zod";`,
        `import nope from "@7r-nonexistent/pkg";`,
        `import rel from "./chunks/other.mjs";`,
        `import fs from "node:fs";`,
        `export { z, nope, rel, fs };`,
      ].join("\n"),
    );
    await writeFile(join(dir, "chunks", "other.mjs"), `export default 1;\n`);
    assert.deepEqual(await missingExternals(dir), ["@7r-nonexistent/pkg"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missingExternals: walks subdirectories and .js files, sorted and distinct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-externals-"));
  try {
    await mkdir(join(dir, "a", "b"), { recursive: true });
    await writeFile(join(dir, "z.mjs"), `import "@7r-nonexistent/zeta";\n`);
    await writeFile(join(dir, "a", "b", "deep.js"), `import "@7r-nonexistent/alpha";\nimport "@7r-nonexistent/zeta";\n`);
    await writeFile(join(dir, "a", "ignored.txt"), `import "@7r-nonexistent/ignored";\n`);
    assert.deepEqual(await missingExternals(dir), [
      "@7r-nonexistent/alpha",
      "@7r-nonexistent/zeta",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missingExternals: nothing missing returns an empty list", async () => {
  const dir = await mkdtemp(join(tmpdir(), "check-externals-"));
  try {
    await writeFile(join(dir, "entry.mjs"), `import "zod";\nimport "node:fs";\n`);
    assert.deepEqual(await missingExternals(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
