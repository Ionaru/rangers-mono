/**
 * The TeamSpeak ServerQuery transport. Worker-only, by design: see client.ts.
 *
 * Phase 2 needs exactly two operations, and both are read-only as far as the
 * TeamSpeak server is concerned: list the online clients, and poke one of them.
 * Phase 3 adds the group reconcile on top of this same connection, and Phase 5
 * the Operations-channel sampling.
 */
export * from "./client.ts";
