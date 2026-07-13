/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    /** Better Auth's user. The login, not the person: see `member`. */
    user: import("better-auth").User | null;
    session: import("better-auth").Session | null;
    /**
     * The Member (CONTEXT.md): the person, and the hub every external identity
     * hangs off. Non-null on every page behind the middleware's guild gate, so a
     * page that has a session has a Member.
     */
    member: import("@7r/db").Member | null;
  }
}
