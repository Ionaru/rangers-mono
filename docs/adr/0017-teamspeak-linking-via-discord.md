# TeamSpeak linking is a Discord slash command (`/link`), replacing the web flow

Self-service TeamSpeak linking (and unlinking) moves from the website to the Discord
bot: a member-facing `/link` command (with `/unlink` as its counterpart), handled by
the interactions endpoint. The possession challenge itself is unchanged (Q10's
bot-initiated mechanic: pick yourself from the online-clients list, the worker pokes
that client a one-time code, you type the code back). Only the surface moves. The web
link/unlink pages for TeamSpeak are removed when `/link` ships (Phase 5), not before:
the web flow keeps serving until its replacement exists.

## Why

The member doing the linking is, by construction, in Discord and on TeamSpeak at that
moment. The web flow makes them open a browser and log in first, purely to reach a
form that talks to the same backend. `/link` removes that round-trip: the whole
exchange happens in the two apps the member already has open.

The cost of the move is small because both surfaces share one backend: the code
machinery (`packages/identity/link-code.ts`), the `link_code` table, and the worker's
internal API (`GET /internal/ts/clients`, `POST /internal/ts/poke`) are reused as-is.
No schema change, no new env, no new coupling: the interactions endpoint lives in
`apps/web`, which already holds the worker client. What `/link` does cost is carried
by Phase 5 anyway: the interactions endpoint must exist, and it must dispatch
message-component and modal-submit interactions, not just slash commands.

Keeping both surfaces was considered and rejected: two UIs over one flow is twice the
maintenance for a feature a member touches about once, and the web version is strictly
more friction. Replacing it also shrinks the member area toward what ARCHITECTURE
always said it was: read-only views. (Not all the way: Steam linking stays on the web,
because Steam OpenID is a browser redirect flow and cannot run inside Discord.)

## The Discord API constraints, recorded so nobody redesigns into them

- **Text input exists only in modals.** A message (ephemeral or not) can carry buttons
  and select menus, never a free-text field. Typing the code back requires a modal.
- **A modal is one-shot.** The bot cannot react to a dropdown selection *inside* an
  open modal (no mid-fill server round-trip), and a modal cannot be chained off a
  modal submission. Since the code only exists after the member picks a client, the
  ideal "one popup" flow is impossible; the flow is two interactions minimum.
- **A modal response cannot be deferred.** Type 9 must be the immediate response to
  the interaction that opens it, so anything feeding a modal has to fit in the
  3-second window.

Hence the shape:

1. `/link` → the handler fetches online, unlinked clients from the worker and replies
   with an **ephemeral message carrying a String Select** ("Which TeamSpeak user are
   you?"). Ephemeral message, not modal-with-select: a dismissed modal is gone for
   good, a message persists. (Select options cap at 25; more than 25 online unlinked
   clients is not a realistic state for this unit.)
2. Select interaction → resolve the ephemeral `clid` to the durable `uid` (the same
   re-fetch the web flow does), create the `link_code` row, poke the code, and update
   the message to "code sent to *nickname*" with an **[Enter code] button**.
3. Button → opens the modal with one text input. The button stays on the message, so
   a mistyped code or an accidentally dismissed modal is recovered by clicking again.
4. Modal submit → verify (`verifyLinkCode`), complete (`completeTeamspeakLink`),
   update the message with the outcome and attempts remaining.

Code TTL (5 minutes) sits comfortably inside Discord's 15-minute interaction-token
window.

## Member auto-create

A member row is currently only written on first web login (the guild gate in the web
middleware). A user can now reach `/link` without ever having visited the site, so a
first `/link` with no `member` row upserts one by `discord_id`: the interaction
arriving from inside the guild is the guild gate. This is a second creation path next
to web login, both keyed on `discord_id`; ADR 0001 (Discord as the identity hub) is
unchanged by it.

## Consequences

- The interactions endpoint dispatches `MESSAGE_COMPONENT` (type 3) and `MODAL_SUBMIT`
  (type 5) interactions in addition to PING and `APPLICATION_COMMAND`
  (IMPLEMENTATION §8).
- `/link` and `/unlink` are **member-facing, not admin-gated** — unlike every other
  planned write command. `/link-force` (admin, ADR 0009) is unaffected and stays.
- Phase 5 gains the removal of the web TeamSpeak link/unlink pages alongside its other
  deliverables. Until then the web flow keeps working; the docs describe the decided
  end state.
- The web member area becomes read-only plus Steam linking. Self-unlink (a privacy
  promise, ARCHITECTURE §7) is preserved via `/unlink`.
- Guest-attendance backfill on link is unchanged: it lives in
  `completeTeamspeakLink`, which both surfaces call.
- The poke message text ("enter it on the website") changes to point at Discord when
  the flow ships.
- ADR 0003 (HTTP-only bot) is unaffected: components and modals are ordinary HTTP
  interactions. ADR 0009 (no admin web UI) is unaffected: this is member self-service,
  not an admin surface.
