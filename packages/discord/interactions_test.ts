import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  extractModalValues,
  type InteractionData,
  optionValue,
  parseCustomId,
  selectedValues,
  subcommandOf,
  verifyInteractionSignature,
} from "./interactions.ts";

/**
 * The interactions endpoint has exactly one part that is both security-critical
 * and pure: the signature check. Discord actively probes it with deliberately
 * invalid signatures and removes the endpoint URL if one is ever answered with a
 * 200 (IMPLEMENTATION §8), so "fail closed on anything unexpected" is not a
 * nicety, it is the contract, and it is testable without a live Discord.
 *
 * The rest of what is covered here is payload parsing: the modal-submit walk and
 * `parseCustomId`, both of which route real interactions and both of which are
 * pure.
 */

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A key pair plus the hex public key Discord would hand us. */
async function keypair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  const raw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return { pair, publicKeyHex: bytesToHex(raw) };
}

/** Sign `timestamp + body` exactly as Discord does. */
async function sign(
  privateKey: CryptoKey,
  timestamp: string,
  body: string,
): Promise<string> {
  const message = new TextEncoder().encode(timestamp + body);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, privateKey, message),
  );
  return bytesToHex(sig);
}

const TIMESTAMP = "1700000000";
const BODY = JSON.stringify({ type: 1 });

Deno.test("a genuine signature verifies", async () => {
  const { pair, publicKeyHex } = await keypair();
  const signatureHex = await sign(pair.privateKey, TIMESTAMP, BODY);

  assert(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp: TIMESTAMP,
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("a tampered body is rejected", async () => {
  const { pair, publicKeyHex } = await keypair();
  const signatureHex = await sign(pair.privateKey, TIMESTAMP, BODY);

  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp: TIMESTAMP,
      body: new TextEncoder().encode(BODY + " "),
    }),
  );
});

Deno.test("a tampered timestamp is rejected", async () => {
  const { pair, publicKeyHex } = await keypair();
  const signatureHex = await sign(pair.privateKey, TIMESTAMP, BODY);

  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp: "1700000001",
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("a signature from a different key is rejected", async () => {
  const signer = await keypair();
  const other = await keypair();
  const signatureHex = await sign(signer.pair.privateKey, TIMESTAMP, BODY);

  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex: other.publicKeyHex,
      signatureHex,
      timestamp: TIMESTAMP,
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("a non-hex signature is rejected, not thrown", async () => {
  const { publicKeyHex } = await keypair();
  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex: "not-hex-at-all",
      timestamp: TIMESTAMP,
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("a signature of the wrong length is rejected", async () => {
  const { publicKeyHex } = await keypair();
  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex: "abcd",
      timestamp: TIMESTAMP,
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("a malformed public key is rejected, not thrown", async () => {
  const { pair } = await keypair();
  const signatureHex = await sign(pair.privateKey, TIMESTAMP, BODY);
  for (const publicKeyHex of ["", "zz", "abc", "ab".repeat(31)]) {
    assertFalse(
      await verifyInteractionSignature({
        publicKeyHex,
        signatureHex,
        timestamp: TIMESTAMP,
        body: new TextEncoder().encode(BODY),
      }),
    );
  }
});

Deno.test("an empty timestamp is rejected", async () => {
  const { pair, publicKeyHex } = await keypair();
  const signatureHex = await sign(pair.privateKey, "", BODY);
  // Even a signature that is genuine for an empty timestamp is refused: an empty
  // timestamp is not a request Discord makes, so it is not one we honour.
  assertFalse(
    await verifyInteractionSignature({
      publicKeyHex,
      signatureHex,
      timestamp: "",
      body: new TextEncoder().encode(BODY),
    }),
  );
});

Deno.test("parseCustomId splits namespace from action", () => {
  assertEquals(parseCustomId("link:pick"), {
    namespace: "link",
    action: "pick",
  });
  assertEquals(parseCustomId("link:enter"), {
    namespace: "link",
    action: "enter",
  });
  // Everything after the first colon is the action, so a colon in the action survives.
  assertEquals(parseCustomId("link:code:extra"), {
    namespace: "link",
    action: "code:extra",
  });
});

Deno.test("parseCustomId returns null for something unroutable", () => {
  assertEquals(parseCustomId("nocolon"), null);
  assertEquals(parseCustomId(""), null);
  assertEquals(parseCustomId(":pick"), null);
});

Deno.test("selectedValues reads a string-select submission", () => {
  assertEquals(
    selectedValues({ data: { values: ["42"] } }),
    ["42"],
  );
  assertEquals(selectedValues({ data: {} }), []);
  assertEquals(selectedValues({}), []);
});

Deno.test("extractModalValues finds a value nested in a Label component", () => {
  // The shape Discord sends when a Text Input is wrapped in a Label (type 18).
  const data = {
    custom_id: "link:code",
    components: [
      { type: 18, component: { type: 4, custom_id: "code", value: "ABC234" } },
    ],
  };
  assertEquals(extractModalValues(data).get("code"), "ABC234");
});

Deno.test("extractModalValues finds a value nested in an Action Row", () => {
  // The legacy shape, in case Discord still sends it: robust to either.
  const data = {
    custom_id: "link:code",
    components: [
      {
        type: 1,
        components: [{ type: 4, custom_id: "code", value: "XYZ789" }],
      },
    ],
  };
  assertEquals(extractModalValues(data).get("code"), "XYZ789");
});

Deno.test("extractModalValues tolerates a flat component and missing data", () => {
  assertEquals(
    extractModalValues({
      components: [{ type: 4, custom_id: "code", value: "FLAT12" }],
    })
      .get("code"),
    "FLAT12",
  );
  assertEquals(extractModalValues({}).size, 0);
  assertEquals(extractModalValues({ components: [] }).size, 0);
});

// ------------------------------------------------------- command options

/** `/attendance claim ts_uid:<uid> member:<id>` as Discord actually sends it. */
function claimData(
  options: { ts_uid?: string; member?: string } = {},
): InteractionData {
  const args = [];
  if (options.ts_uid !== undefined) {
    args.push({ name: "ts_uid", type: 3, value: options.ts_uid });
  }
  if (options.member !== undefined) {
    args.push({ name: "member", type: 6, value: options.member });
  }
  return {
    name: "attendance",
    options: [{ name: "claim", type: 1, options: args }],
  };
}

Deno.test("a subcommand is found by its option type, not its position", () => {
  const data: InteractionData = {
    name: "attendance",
    // A top-level option that is not a subcommand, sitting in front of one.
    options: [
      { name: "noise", type: 3, value: "x" },
      { name: "claim", type: 1, options: [] },
    ],
  };
  assertEquals(subcommandOf(data)?.name, "claim");
});

Deno.test("a command with no subcommand reports none", () => {
  assertEquals(subcommandOf({ name: "link" }), null);
  assertEquals(subcommandOf({ name: "link", options: [] }), null);
  assertEquals(subcommandOf(undefined), null);
});

Deno.test("a subcommand's options are read by name", () => {
  const sub = subcommandOf(claimData({ ts_uid: "abc=", member: "123" }));
  assertEquals(optionValue(sub?.options, "ts_uid"), "abc=");
  assertEquals(optionValue(sub?.options, "member"), "123");
});

Deno.test("a user option's snowflake survives as a string", () => {
  // The id exceeds Number range, so anything that round-trips it through a
  // number loses the last digits and claims sessions for the wrong person.
  const id = "305471712546390017";
  const sub = subcommandOf(claimData({ ts_uid: "u", member: id }));
  assertEquals(optionValue(sub?.options, "member"), id);
});

Deno.test("an option Discord did not send reads as undefined", () => {
  const sub = subcommandOf(claimData({ ts_uid: "abc=" }));
  assertEquals(optionValue(sub?.options, "member"), undefined);
});

Deno.test("an option array that is absent entirely reads as undefined", () => {
  assertEquals(optionValue(undefined, "ts_uid"), undefined);
  assertEquals(optionValue([], "ts_uid"), undefined);
});

Deno.test("an empty option value is the same as an absent one", () => {
  // A handler must not try to claim sessions for the empty identity.
  const sub = subcommandOf(claimData({ ts_uid: "", member: "1" }));
  assertEquals(optionValue(sub?.options, "ts_uid"), undefined);
});
