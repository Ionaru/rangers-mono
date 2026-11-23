import js from "@eslint/js";
import tseslint from "typescript-eslint";
import astro from "eslint-plugin-astro";

export default [
  {
    // Build output, generated SQL and local state. Same set deno lint skipped,
    // plus the runtime directories that never hold source.
    ignores: [
      "**/dist",
      "**/.astro",
      "**/node_modules",
      "packages/db/drizzle",
      "data",
      "backups",
      "secrets",
    ],
  },
  js.configs.recommended,
  // Not type-aware: deno lint was not either.
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,
  {
    // deno lint let a leading underscore mark a binding as deliberately
    // unused (a handler that keeps the shared signature but ignores its
    // argument). Keep that convention rather than scattering disables.
    rules: {
      // deno lint flags an async function with no await in it; keep that.
      "require-await": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
];
