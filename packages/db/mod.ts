export * from "./schema.ts";
export * from "./auth-schema.ts";
export * from "./client.ts";
export * from "./queries.ts";

// Deliberately not exported: ./migrate.ts. It is a one-shot entry point, run as
// its own task and its own container (ADR 0008: migrations never run on boot),
// and it reaches for jsr: imports that have no business inside the bundle Astro
// builds from this package.
