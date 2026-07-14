/**
 * Discord REST, for the parts of the platform that talk to Discord as `7R_Bot`.
 *
 * Phase 2 uses exactly one endpoint, the guild-member lookup behind the login's
 * guild gate. What is deliberately NOT here yet, so that it arrives with the
 * phase that needs it rather than as speculative surface:
 *
 * - the paginated guild-member list (Phase 3's reconcile). When it lands, note
 *   that `GET /guilds/{id}/members` defaults to `limit=1`, which does not error,
 *   it just silently syncs exactly one person (IMPLEMENTATION §5).
 * - the interactions endpoint and its Ed25519 verify, which must fail closed
 *   (Phase 4, ADR 0003).
 * - role writes, and the weekly scheduled event, which needs CREATE_EVENTS and
 *   not MANAGE_EVENTS (Phase 4).
 */
export * from "./rest.ts";
export * from "./guild.ts";
export * from "./roles.ts";
