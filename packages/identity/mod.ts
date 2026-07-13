/**
 * Identity linking: the rules, kept apart from the I/O that applies them.
 *
 * A Member is one person across three namespaces (CONTEXT.md). Discord is proven
 * by the login itself, and is the hub. The other two are proven here:
 *
 * - **TeamSpeak**, by a possession challenge. The member picks themselves out of
 *   the online-client list, the worker pokes that client a one-time code, and
 *   the member types it back. Picking the wrong person fails safe, because the
 *   code goes to the person they picked.
 * - **Steam**, by OpenID. It proves account ownership and yields a SteamID64.
 *   Optional, and it gates nothing.
 *
 * Everything here is pure, or takes its I/O as a parameter. That is what lets it
 * be tested in a project with no live test environment, and it is why the
 * database writes these rules authorise live in `@7r/db` rather than in here.
 */
export * from "./link-code.ts";
export * from "./steam.ts";
