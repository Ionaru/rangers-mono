import { assertEquals } from "@std/assert";
import { listGuildScheduledEventUsers } from "./events.ts";
import { ok, stubFetch } from "./fetch_stub_test_util.ts";

/**
 * The RSVP snapshot's pagination, against a stubbed `fetch`.
 *
 * Worth testing because the failure is silent and the data is unrecoverable:
 * Discord exposes no way to read an event's Interested list after the op, so a
 * pagination bug that drops page two is a permanently short RSVP list rather
 * than an error anyone sees. There is no test guild (ARCHITECTURE §9), so a stub
 * is as close as this gets.
 */

const OPTIONS = {
  botToken: "bot-token",
  retry: { backoffMs: [0, 0], timeoutMs: 5_000 },
};

/** `n` subscribers with sequential snowflake-shaped ids, starting at `from`. */
function page(from: number, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    user: {
      id: String(900000000000000000n + BigInt(from + i)),
      username: `user${from + i}`,
      global_name: `User ${from + i}`,
    },
  }));
}

Deno.test("an event nobody is interested in returns an empty list", async () => {
  const stub = stubFetch([ok([])]);
  try {
    assertEquals(
      await listGuildScheduledEventUsers(OPTIONS, "guild", "event"),
      [],
    );
    assertEquals(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

Deno.test("a short first page is the whole list and stops", async () => {
  const stub = stubFetch([ok(page(0, 3))]);
  try {
    const users = await listGuildScheduledEventUsers(OPTIONS, "guild", "event");
    assertEquals(users.length, 3);
    // One request, and no `after` on it: the first page has no cursor.
    assertEquals(stub.calls.length, 1);
    assertEquals(stub.calls[0].url.includes("after="), false);
    assertEquals(stub.calls[0].url.includes("limit=100"), true);
  } finally {
    stub.restore();
  }
});

Deno.test("a full page is followed by another, cursored on the highest id", async () => {
  const stub = stubFetch([ok(page(0, 100)), ok(page(100, 7))]);
  try {
    const users = await listGuildScheduledEventUsers(OPTIONS, "guild", "event");
    assertEquals(users.length, 107);
    assertEquals(stub.calls.length, 2);
    // The cursor is the last id of page one, compared as a BigInt rather than
    // as a Number, which snowflakes overflow.
    const expected = String(900000000000000000n + 99n);
    assertEquals(stub.calls[1].url.includes(`after=${expected}`), true);
    // `before` is never sent: Discord honours only `before` when both are given.
    assertEquals(stub.calls[1].url.includes("before="), false);
  } finally {
    stub.restore();
  }
});

Deno.test("global_name is preferred as the display name, and may be absent", async () => {
  const stub = stubFetch([ok([
    { user: { id: "1", username: "handle", global_name: "Display Name" } },
    { user: { id: "2", username: "legacy" } },
    { user: { id: "3", username: "cleared", global_name: null } },
  ])]);
  try {
    const users = await listGuildScheduledEventUsers(OPTIONS, "guild", "event");
    assertEquals(users, [
      { id: "1", username: "handle", displayName: "Display Name" },
      { id: "2", username: "legacy", displayName: null },
      { id: "3", username: "cleared", displayName: null },
    ]);
  } finally {
    stub.restore();
  }
});

Deno.test("the event's own id is in the path, not the guild's", async () => {
  const stub = stubFetch([ok([])]);
  try {
    await listGuildScheduledEventUsers(OPTIONS, "guild-id", "event-id");
    assertEquals(
      stub.calls[0].url.includes(
        "/guilds/guild-id/scheduled-events/event-id/users",
      ),
      true,
    );
  } finally {
    stub.restore();
  }
});
