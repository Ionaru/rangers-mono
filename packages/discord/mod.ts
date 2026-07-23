/**
 * Discord REST, for the parts of the platform that talk to Discord as `7R_Bot`.
 *
 * Phase 5 adds the interactions endpoint's pure half: the fail-closed Ed25519
 * verify, the wire-format constants and builders, the command definitions, and
 * the followup edit (`interactions.ts`, `commands.ts`, `followup.ts`). The
 * handlers that touch the database and the worker live in `apps/web`; this
 * package stays free of config and database dependencies (ADR 0006). The
 * command-registration entry point (`register.ts`) is deliberately not exported:
 * it is a task with a config dependency, like `phase0-check.ts`.
 *
 * What is deliberately NOT here yet:
 *
 * - role writes beyond the single-role add, and the weekly scheduled event,
 *   which needs CREATE_EVENTS and not MANAGE_EVENTS (Phase 5, later slices).
 */
export * from "./rest.ts";
export * from "./guild.ts";
export * from "./roles.ts";
export * from "./members.ts";
export * from "./interactions.ts";
export * from "./followup.ts";
export * from "./commands.ts";
