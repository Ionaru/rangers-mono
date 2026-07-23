import { assertEquals } from "@std/assert";
import { pickableClients } from "./link-candidates.ts";

/**
 * The re-link rule, in isolation. This is the one part of the pick-list logic
 * worth testing, and the bug that prompted the whole slice lived here: a member
 * who was already linked could not pick their own identity, because every linked
 * uid was subtracted from the list, their own included.
 *
 * `online` and `links` are plain data in, decisions out, so it needs no worker
 * and no database (ARCHITECTURE §9).
 */

const alice = "alice-member-id";
const bob = "bob-member-id";

function client(
  over: Partial<{ clid: string; uid: string; nickname: string }> = {},
) {
  return {
    clid: "10",
    uid: "AAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    nickname: "Someone",
    ...over,
  };
}

Deno.test("an unlinked client is offered to anyone", () => {
  const online = [client({ clid: "10", uid: "unlinked=" })];
  const picked = pickableClients({ online, links: [], memberId: alice });
  assertEquals(picked, [
    { clid: "10", uid: "unlinked=", nickname: "Someone", current: false },
  ]);
});

Deno.test("another member's identity is never offered", () => {
  const online = [client({ clid: "10", uid: "bobs-uid=" })];
  const links = [{ memberId: bob, tsUid: "bobs-uid=" }];
  const picked = pickableClients({ online, links, memberId: alice });
  assertEquals(picked, []);
});

Deno.test("your own current identity IS offered, and marked current", () => {
  const online = [
    client({ clid: "10", uid: "alices-uid=", nickname: "Alice" }),
  ];
  const links = [{ memberId: alice, tsUid: "alices-uid=" }];
  const picked = pickableClients({ online, links, memberId: alice });
  assertEquals(picked, [
    { clid: "10", uid: "alices-uid=", nickname: "Alice", current: true },
  ]);
});

Deno.test("a mixed list keeps mine (marked) and strangers' out", () => {
  const online = [
    client({ clid: "10", uid: "alices-uid=", nickname: "Alice" }),
    client({ clid: "11", uid: "bobs-uid=", nickname: "Bob" }),
    client({ clid: "12", uid: "fresh-uid=", nickname: "New" }),
  ];
  const links = [
    { memberId: alice, tsUid: "alices-uid=" },
    { memberId: bob, tsUid: "bobs-uid=" },
  ];
  const picked = pickableClients({ online, links, memberId: alice });
  assertEquals(picked, [
    { clid: "10", uid: "alices-uid=", nickname: "Alice", current: true },
    { clid: "12", uid: "fresh-uid=", nickname: "New", current: false },
  ]);
});

Deno.test("without a memberId every linked identity is hidden (the web-page behaviour)", () => {
  // The old web flow does not identify the requester, so it may claim nothing
  // that is already linked. This is what keeps those pages working unchanged
  // while both surfaces coexist.
  const online = [
    client({ clid: "10", uid: "alices-uid=" }),
    client({ clid: "11", uid: "fresh-uid=" }),
  ];
  const links = [{ memberId: alice, tsUid: "alices-uid=" }];
  const picked = pickableClients({ online, links });
  assertEquals(picked, [
    { clid: "11", uid: "fresh-uid=", nickname: "Someone", current: false },
  ]);
});

Deno.test("an empty online list stays empty", () => {
  assertEquals(
    pickableClients({
      online: [],
      links: [{ memberId: alice, tsUid: "x=" }],
      memberId: alice,
    }),
    [],
  );
});

Deno.test("a member linked to an identity that is not online gets an empty list, not a crash", () => {
  const online = [client({ clid: "10", uid: "bobs-uid=" })];
  const links = [
    { memberId: alice, tsUid: "alice-offline=" },
    { memberId: bob, tsUid: "bobs-uid=" },
  ];
  assertEquals(pickableClients({ online, links, memberId: alice }), []);
});
