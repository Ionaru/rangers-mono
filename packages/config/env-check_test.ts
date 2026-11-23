import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  collectSchemaKeys,
  diffEnv,
  type KeySpec,
  parseEnvKeys,
} from "./env-check.ts";
import * as schemas from "./schemas.ts";

test("collectSchemaKeys classifies required/default/optional and merges", () => {
  const fake = {
    a: z.object({
      REQUIRED: z.string().min(1),
      DEFAULTED: z.string().default("x"),
      OPT: z.string().optional(),
    }),
    b: z.object({
      REQUIRED: z.string().min(1), // same key, still required -> merges required
      EXTRA: z.number().default(5),
    }),
    notASchema: 42, // ignored: not a ZodObject
  };

  const known = collectSchemaKeys(fake);
  assert.deepStrictEqual(known.get("REQUIRED"), {
    required: true,
    default: undefined,
  });
  assert.deepStrictEqual(known.get("DEFAULTED"), {
    required: false,
    default: "x",
  });
  assert.deepStrictEqual(known.get("OPT"), {
    required: false,
    default: undefined,
  });
  assert.deepStrictEqual(known.get("EXTRA"), { required: false, default: 5 });
  assert.deepStrictEqual(known.has("notASchema"), false);
});

test("parseEnvKeys: only non-blank keys, skipping comments and blanks", () => {
  const text = [
    "# comment",
    "",
    "FOO=bar",
    "BAZ=", // blank -> unset
    "QUX=''", // quoted-empty -> unset
    "QUOTED='has spaces'",
    'DQ="v"',
    "  SPACED = x ", // trimmed both sides
    "NOEQ", // no '=' -> skipped
  ].join("\n");

  assert.deepStrictEqual([...parseEnvKeys(text)].sort(), [
    "DQ",
    "FOO",
    "QUOTED",
    "SPACED",
  ]);
});

test("diffEnv: missing-required, missing-optional, unknown, and X_FILE satisfaction", () => {
  const known = new Map<string, KeySpec>([
    ["REQ", { required: true, default: undefined }],
    ["REQ_FILE_BACKED", { required: true, default: undefined }],
    ["OPT", { required: false, default: "d" }],
    ["ALSO_REQ", { required: true, default: undefined }],
  ]);
  const present = new Set(["ALSO_REQ", "REQ_FILE_BACKED_FILE", "STALE"]);

  const diff = diffEnv(known, present);
  assert.deepStrictEqual(diff.missingRequired, ["REQ"]);
  assert.deepStrictEqual(diff.missingOptional, [{ key: "OPT", default: "d" }]);
  assert.deepStrictEqual(diff.unknown, ["STALE"]);
});

test("collectSchemaKeys reads the real schemas (zod introspection smoke test)", () => {
  const known = collectSchemaKeys(schemas);

  // Required keys (no default, not optional).
  assert.deepStrictEqual(known.get("OP_ANNOUNCE_CHANNEL_ID")?.required, true);
  assert.deepStrictEqual(known.get("DISCORD_BOT_TOKEN")?.required, true);
  assert.deepStrictEqual(known.get("PUBLIC_BASE_URL")?.required, true);
  // Satisfied via DATABASE_URL_FILE at runtime, but the schema still requires it.
  assert.deepStrictEqual(known.get("DATABASE_URL")?.required, true);

  // Defaulted keys carry their default.
  assert.deepStrictEqual(known.get("LOG_LEVEL"), {
    required: false,
    default: "info",
  });
  assert.deepStrictEqual(known.get("SYNC_DRY_RUN"), {
    required: false,
    default: true,
  });
  assert.deepStrictEqual(known.get("OP_EVENT_DRY_RUN"), {
    required: false,
    default: true,
  });

  // Optional-without-default.
  assert.deepStrictEqual(known.get("ERROR_ALERT_DISCORD_WEBHOOK"), {
    required: false,
    default: undefined,
  });
  // The mission-maker prep step is opt-in: required here would fail every deploy
  // that has not added the channel yet, for a step whose absence is the old
  // behaviour.
  assert.deepStrictEqual(known.get("OP_PREP_CHANNEL_ID"), {
    required: false,
    default: undefined,
  });
  assert.deepStrictEqual(known.get("OP_PREP_LEAD_DAYS"), {
    required: false,
    default: 1,
  });
});

test("no config key ends in _FILE (the suffix is reserved for secret files)", () => {
  // A `*_FILE` key is intercepted by resolveSecretFiles (load.ts): it reads the
  // file at that path and sets the un-suffixed key. A config key named `X_FILE`
  // therefore never reaches its schema and forces a file read at boot that fails
  // wherever the file is not mounted. This bit production once (OP_ANNOUNCE_TEXT_FILE
  // crashed the web container, which has no assets mount); never again.
  const offenders = [...collectSchemaKeys(schemas).keys()].filter((key) =>
    key.endsWith("_FILE"),
  );
  assert.deepStrictEqual(offenders, []);
});
