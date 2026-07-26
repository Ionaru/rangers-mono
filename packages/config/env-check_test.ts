import { assertEquals } from "@std/assert";
import { z } from "zod";
import {
  collectSchemaKeys,
  diffEnv,
  type KeySpec,
  parseEnvKeys,
} from "./env-check.ts";
import * as schemas from "./schemas.ts";

Deno.test("collectSchemaKeys classifies required/default/optional and merges", () => {
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
  assertEquals(known.get("REQUIRED"), { required: true, default: undefined });
  assertEquals(known.get("DEFAULTED"), { required: false, default: "x" });
  assertEquals(known.get("OPT"), { required: false, default: undefined });
  assertEquals(known.get("EXTRA"), { required: false, default: 5 });
  assertEquals(known.has("notASchema"), false);
});

Deno.test("parseEnvKeys: only non-blank keys, skipping comments and blanks", () => {
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

  assertEquals(
    [...parseEnvKeys(text)].sort(),
    ["DQ", "FOO", "QUOTED", "SPACED"],
  );
});

Deno.test("diffEnv: missing-required, missing-optional, unknown, and X_FILE satisfaction", () => {
  const known = new Map<string, KeySpec>([
    ["REQ", { required: true, default: undefined }],
    ["REQ_FILE_BACKED", { required: true, default: undefined }],
    ["OPT", { required: false, default: "d" }],
    ["ALSO_REQ", { required: true, default: undefined }],
  ]);
  const present = new Set(["ALSO_REQ", "REQ_FILE_BACKED_FILE", "STALE"]);

  const diff = diffEnv(known, present);
  assertEquals(diff.missingRequired, ["REQ"]);
  assertEquals(diff.missingOptional, [{ key: "OPT", default: "d" }]);
  assertEquals(diff.unknown, ["STALE"]);
});

Deno.test("collectSchemaKeys reads the real schemas (zod introspection smoke test)", () => {
  const known = collectSchemaKeys(schemas);

  // Required keys (no default, not optional).
  assertEquals(known.get("OP_ANNOUNCE_CHANNEL_ID")?.required, true);
  assertEquals(known.get("DISCORD_BOT_TOKEN")?.required, true);
  assertEquals(known.get("PUBLIC_BASE_URL")?.required, true);
  // Satisfied via DATABASE_URL_FILE at runtime, but the schema still requires it.
  assertEquals(known.get("DATABASE_URL")?.required, true);

  // Defaulted keys carry their default.
  assertEquals(known.get("LOG_LEVEL"), { required: false, default: "info" });
  assertEquals(known.get("SYNC_DRY_RUN"), { required: false, default: true });
  assertEquals(known.get("OP_EVENT_DRY_RUN"), {
    required: false,
    default: true,
  });

  // Optional-without-default.
  assertEquals(known.get("ERROR_ALERT_DISCORD_WEBHOOK"), {
    required: false,
    default: undefined,
  });
});

Deno.test("no config key ends in _FILE (the suffix is reserved for secret files)", () => {
  // A `*_FILE` key is intercepted by resolveSecretFiles (load.ts): it reads the
  // file at that path and sets the un-suffixed key. A config key named `X_FILE`
  // therefore never reaches its schema and forces a file read at boot that fails
  // wherever the file is not mounted. This bit production once (OP_ANNOUNCE_TEXT_FILE
  // crashed the web container, which has no assets mount); never again.
  const offenders = [...collectSchemaKeys(schemas).keys()].filter((key) =>
    key.endsWith("_FILE")
  );
  assertEquals(offenders, []);
});
