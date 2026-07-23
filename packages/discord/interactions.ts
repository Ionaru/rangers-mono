/**
 * The Discord interactions endpoint, the pure half.
 *
 * `packages/discord` is consumed by BOTH `apps/web` (the endpoint) and the
 * worker, so it carries no config and no database dependency by construction
 * (mod.ts). This file is therefore the signature check, the type constants, the
 * hand-written payload types, and the small builders that turn "reply with a
 * select" into the exact JSON Discord expects. The handlers that touch the
 * database and the worker live in `apps/web`; this is only the wire format.
 *
 * Types are hand-written rather than pulled from `discord-api-types` (a large
 * dependency for a handful of fields), exactly as `guild.ts` does for the REST
 * shapes.
 */

// ------------------------------------------------------------- wire constants

/** Interaction types Discord sends us (the `type` on the request). */
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  MODAL_SUBMIT: 5,
} as const;

/**
 * Response callback types (the `type` on our reply).
 *
 * Note what is NOT used for a modal submit: UPDATE_MESSAGE (7) and
 * DEFERRED_UPDATE_MESSAGE (6) are documented "Only valid for component-based
 * interactions", and Discord documents neither for MODAL_SUBMIT. So the modal
 * submit answers with DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (5) and edits its own
 * @original, rather than leaning on an undocumented update in a flow that is
 * first exercised in production (ADR 0017).
 */
export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  MODAL: 9,
} as const;

/** Component types. LABEL (18) wraps a text input in a modal; ACTION_ROW (1) wraps message components. */
export const ComponentType = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  LABEL: 18,
} as const;

/** `flags: 64` (1 << 6) makes a reply ephemeral: only the invoker sees it. */
export const MessageFlags = {
  EPHEMERAL: 1 << 6,
} as const;

export const ButtonStyle = {
  PRIMARY: 1,
  SECONDARY: 2,
} as const;

export const TextInputStyle = {
  SHORT: 1,
  PARAGRAPH: 2,
} as const;

// ------------------------------------------------------------- payload types

/** A Discord user, only the fields we read. */
export interface InteractionUser {
  id: string;
  username: string;
  global_name: string | null;
}

/**
 * The guild member behind a guild interaction. Structurally a `GuildMember`
 * (guild.ts) with `user` present, so `displayNameOf` reads it directly.
 */
export interface InteractionMember {
  user?: InteractionUser;
  nick: string | null;
  roles: string[];
}

/** One component as it appears in a request payload (a modal submit, a message). */
export interface ComponentPayload {
  type: number;
  custom_id?: string;
  value?: string;
  /** Action rows carry their children here. */
  components?: ComponentPayload[];
  /** A Label carries its single child here. */
  component?: ComponentPayload;
}

export interface InteractionData {
  /** APPLICATION_COMMAND: the command name. */
  name?: string;
  /** MESSAGE_COMPONENT / MODAL_SUBMIT: the component's namespaced id. */
  custom_id?: string;
  /** MESSAGE_COMPONENT (string select): the selected option values. */
  values?: string[];
  /** MODAL_SUBMIT: the submitted components, possibly nested. */
  components?: ComponentPayload[];
}

/** An inbound interaction, reduced to what the endpoint reads. */
export interface Interaction {
  id: string;
  application_id: string;
  type: number;
  token: string;
  guild_id?: string;
  member?: InteractionMember;
  user?: InteractionUser;
  data?: InteractionData;
}

// ------------------------------------------------------------- signature

/**
 * Hex to bytes, or null on anything that is not clean hex.
 *
 * Returns null rather than throwing so the one caller (`verifyInteractionSignature`)
 * can treat every malformed input as "does not verify" through a single path.
 */
function hexToBytes(hex: string): Uint8Array | null {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) {
    return null;
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Does this request genuinely come from Discord?
 *
 * Ed25519 over `timestamp + rawBody`, native on Deno (crypto.subtle, no flags,
 * verified against 2.9.2). The raw body BYTES matter: re-serialising parsed JSON
 * would not be byte-identical and would fail to verify (IMPLEMENTATION §8).
 *
 * **This never throws.** A malformed header, non-hex input, a wrong key length,
 * or a `subtle.verify` that rejects the key all resolve to `false`, so the
 * endpoint has exactly one thing to check and exactly one way to fail: closed.
 * Discord probes this with deliberately invalid signatures and removes the
 * endpoint URL if one is ever answered 200 (a silent, delayed bot death), so the
 * whole design is "return false unless everything is right".
 */
export async function verifyInteractionSignature(input: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: Uint8Array;
}): Promise<boolean> {
  try {
    if (!input.timestamp) return false;

    const publicKey = hexToBytes(input.publicKeyHex);
    if (!publicKey || publicKey.length !== 32) return false;

    const signature = hexToBytes(input.signatureHex);
    if (!signature || signature.length !== 64) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );

    const timestampBytes = new TextEncoder().encode(input.timestamp);
    const message = new Uint8Array(timestampBytes.length + input.body.length);
    message.set(timestampBytes, 0);
    message.set(input.body, timestampBytes.length);

    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature as BufferSource,
      message as BufferSource,
    );
  } catch {
    // A rejected key import, or anything else unexpected. Fail closed.
    return false;
  }
}

// ------------------------------------------------------------- routing helpers

/**
 * Split a component `custom_id` into the namespace and action the dispatcher
 * routes on. `link:pick` -> `{ namespace: "link", action: "pick" }`. Everything
 * after the first colon is the action, so an action may itself contain a colon.
 * Null when there is no namespace to route on.
 */
export function parseCustomId(
  customId: string,
): { namespace: string; action: string } | null {
  const colon = customId.indexOf(":");
  if (colon <= 0 || colon === customId.length - 1) return null;
  return {
    namespace: customId.slice(0, colon),
    action: customId.slice(colon + 1),
  };
}

/** The values a string select submitted. Empty when there are none. */
export function selectedValues(
  interaction: { data?: { values?: string[] } },
): string[] {
  return interaction.data?.values ?? [];
}

/**
 * Every `custom_id -> value` a modal submission carried, found wherever it sits.
 *
 * Discord wraps a modal's text input in a Label (type 18) now, and used to wrap
 * it in an Action Row (type 1). Rather than commit to one nesting for a payload
 * shape the docs do not pin down, this walks the tree: an action row's
 * `.components`, a label's `.component`, or a flat component, all yield their
 * `{ custom_id, value }`. Robust to whichever shape the server actually sends.
 */
export function extractModalValues(
  data: { components?: ComponentPayload[] } | undefined,
): Map<string, string> {
  const values = new Map<string, string>();

  const walk = (component: ComponentPayload): void => {
    if (component.custom_id !== undefined && component.value !== undefined) {
      values.set(component.custom_id, component.value);
    }
    if (component.component) walk(component.component);
    for (const child of component.components ?? []) walk(child);
  };

  for (const component of data?.components ?? []) walk(component);
  return values;
}

/**
 * The invoking user's Discord snowflake, from the guild member or (in a DM) the
 * top-level user. Null if neither is present, which the caller treats as "could
 * not identify you" rather than crashing.
 */
export function interactionUserId(interaction: Interaction): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

// ------------------------------------------------------------- response builders

/** ACK a PING. */
export function pong(): { type: number } {
  return { type: InteractionResponseType.PONG };
}

/**
 * ACK now, ephemerally, and edit the reply once the slow work is done. The
 * invoker sees a loading state. Used by `/link`, `/unlink` and the modal submit,
 * all of which touch TeamSpeak or the database and cannot fit in 3 seconds on a
 * cold start.
 */
export function deferredEphemeralReply(): {
  type: number;
  data: { flags: number };
} {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: MessageFlags.EPHEMERAL },
  };
}

/**
 * ACK a component interaction and edit its message later, with no loading state.
 * Used by the select: it pokes a code (slow) and then rewrites the ephemeral
 * message to the "code sent" state.
 */
export function deferredComponentUpdate(): { type: number } {
  return { type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE };
}

/**
 * Open a modal. Type 9 MUST be the immediate response to the interaction that
 * opens it and cannot be deferred, so a handler that returns this does no slow
 * work (the `/link` button handler does none; the poke already happened in the
 * select).
 */
export function modal(input: {
  customId: string;
  title: string;
  components: unknown[];
}): {
  type: number;
  data: { custom_id: string; title: string; components: unknown[] };
} {
  return {
    type: InteractionResponseType.MODAL,
    data: {
      custom_id: input.customId,
      title: input.title,
      components: input.components,
    },
  };
}

// ------------------------------------------------------------- component builders

/** A row of message components (a select, or up to five buttons). */
export function actionRow(...components: unknown[]): {
  type: number;
  components: unknown[];
} {
  return { type: ComponentType.ACTION_ROW, components };
}

/** A string select. `options` is capped by Discord at 25; the caller keeps under it. */
export function stringSelect(input: {
  customId: string;
  placeholder?: string;
  options: { label: string; value: string; description?: string }[];
}): unknown {
  return {
    type: ComponentType.STRING_SELECT,
    custom_id: input.customId,
    placeholder: input.placeholder,
    options: input.options,
  };
}

export function button(input: {
  customId: string;
  label: string;
  style?: number;
}): unknown {
  return {
    type: ComponentType.BUTTON,
    custom_id: input.customId,
    label: input.label,
    style: input.style ?? ButtonStyle.PRIMARY,
  };
}

/** A modal label wrapping one component (a text input). Replaces the deprecated action-row wrapping. */
export function label(input: {
  label: string;
  description?: string;
  component: unknown;
}): unknown {
  return {
    type: ComponentType.LABEL,
    label: input.label,
    description: input.description,
    component: input.component,
  };
}

export function textInput(input: {
  customId: string;
  style?: number;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
}): unknown {
  return {
    type: ComponentType.TEXT_INPUT,
    custom_id: input.customId,
    style: input.style ?? TextInputStyle.SHORT,
    placeholder: input.placeholder,
    min_length: input.minLength,
    max_length: input.maxLength,
    required: input.required ?? true,
  };
}

/**
 * The body of an edit to the interaction's @original message (followup.ts). Not
 * an interaction response, so it carries no `type`: content, and optionally the
 * components to leave on the message (an empty array clears them).
 */
export function messageEdit(input: {
  content: string;
  components?: unknown[];
}): { content: string; components: unknown[] } {
  return { content: input.content, components: input.components ?? [] };
}
