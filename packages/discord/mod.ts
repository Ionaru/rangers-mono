/**
 * Discord REST, for the parts of the platform that talk to Discord as `7R_Bot`.
 *
 * What is deliberately NOT here yet, so that it arrives with the phase that
 * needs it rather than as speculative surface:
 *
 * - the interactions endpoint and its Ed25519 verify, which must fail closed
 *   (Phase 5, ADR 0003).
 * - role writes beyond the single-role add, and the weekly scheduled event,
 *   which needs CREATE_EVENTS and not MANAGE_EVENTS (Phase 5).
 */
export * from "./rest.ts";
export * from "./guild.ts";
export * from "./roles.ts";
export * from "./members.ts";
