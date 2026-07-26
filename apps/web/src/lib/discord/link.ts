import {
  completeTeamspeakLink,
  consumeLinkCode,
  createLinkCode,
  findLiveLinkCode,
  findMemberByDiscordId,
  getDb,
  isUniqueViolation,
  recordLinkCodeAttempt,
  upsertMemberOnLogin,
} from "@7r/db";
import {
  CODE_LENGTH,
  CODE_TTL_MS,
  generateLinkCode,
  pokeMessage,
  verifyLinkCode,
} from "@7r/identity";
import {
  actionRow,
  button,
  deferredComponentUpdate,
  deferredEphemeralReply,
  displayNameOf,
  extractModalValues,
  type Interaction,
  interactionUserId,
  label,
  messageEdit,
  modal,
  selectedValues,
  stringSelect,
  textInput,
} from "@7r/discord";
import {
  fetchOnlineClients,
  pokeLinkCode,
  WorkerUnavailableError,
} from "../worker-client.ts";
import { deferThen, editOriginal } from "./respond.ts";

/**
 * The `/link` flow, moved off the website into Discord (ADR 0017). Four
 * interactions, because Discord's constraints force at least that many: the code
 * only exists after the member picks a client, text can only be typed in a modal,
 * and a modal cannot be chained off a modal.
 *
 *   /link (command)      -> defer, list online clients, reply with a select
 *   link:pick (select)   -> defer, poke a code, offer an [Enter code] button
 *   link:enter (button)  -> open a modal (immediate; no slow work here)
 *   link:code (modal)    -> defer, verify, link, report
 *
 * This is the only place in the endpoint that touches the database, the identity
 * rules and the worker. The wire format lives in `@7r/discord`; the flow lives
 * here.
 *
 * Discord's custom_id namespace `link:*` routes these (endpoint dispatch).
 */

/** The Discord id and display name behind an interaction, or null if unidentifiable. */
function identify(
  interaction: Interaction,
): { discordId: string; displayName: string } | null {
  const discordId = interactionUserId(interaction);
  if (!discordId) return null;

  const username = interaction.member?.user?.username ??
    interaction.user?.username ?? "member";
  const displayName = interaction.member
    ? displayNameOf(interaction.member, username)
    : (interaction.user?.global_name ?? username);

  return { discordId, displayName };
}

/**
 * `/link`: list the online clients this member may claim and reply with a select.
 *
 * The member row is upserted here if missing: a member can reach `/link` without
 * ever visiting the site, and the interaction arriving from inside the guild is
 * the guild gate (ADR 0017). Deferred because listing clients hits the worker.
 */
export function linkCommand(interaction: Interaction): Response {
  return deferThen(deferredEphemeralReply(), interaction, async () => {
    const who = identify(interaction);
    if (!who) {
      await editOriginal(
        interaction,
        messageEdit({
          content: "Could not identify you. Try again.",
        }),
      );
      return;
    }

    const db = getDb();
    const member = await upsertMemberOnLogin(db, {
      discordId: who.discordId,
      displayName: who.displayName,
    });

    let clients;
    try {
      clients = await fetchOnlineClients(member.id);
    } catch (cause) {
      if (!(cause instanceof WorkerUnavailableError)) throw cause;
      // Say the connection is down, not that the list is empty. An empty list
      // would read as "you are not connected to TeamSpeak" and send them to debug
      // a client that was never broken.
      await editOriginal(
        interaction,
        messageEdit({
          content:
            "TeamSpeak is unreachable right now. Try again in a few minutes.",
        }),
      );
      return;
    }

    if (clients.length === 0) {
      await editOriginal(
        interaction,
        messageEdit({
          content:
            "No TeamSpeak users found that can be linked. Connect to TeamSpeak first.",
        }),
      );
      return;
    }

    // Select options cap at 25; more than 25 online unlinked clients is not a
    // realistic state for this unit (ADR 0017). Slice rather than risk a rejected
    // payload.
    const options = clients.slice(0, 25).map((client) => ({
      label: (client.nickname || "(no nickname)").slice(0, 100),
      value: client.clid,
      description: client.current ? "Your current link" : undefined,
    }));

    await editOriginal(
      interaction,
      messageEdit({
        content:
          "Pick yourself from the list. The code goes to the client you choose, " +
          "so a wrong pick cannot be completed. Already linked? Your current " +
          "identity is marked; choosing a different one replaces it.",
        components: [
          actionRow(
            stringSelect({
              customId: "link:pick",
              placeholder: "Choose your TeamSpeak client",
              options,
            }),
          ),
        ],
      }),
    );
  });
}

/**
 * The select: resolve the ephemeral `clid` to the durable `uid`, poke a code,
 * and offer the [Enter code] button.
 *
 * The list is re-fetched rather than trusting the posted `clid`, exactly as the
 * web flow does: a `clid` is a connection id and it is ephemeral, so a member may
 * only complete against one that is genuinely online and genuinely theirs to
 * claim right now.
 */
export function linkPick(interaction: Interaction): Response {
  return deferThen(deferredComponentUpdate(), interaction, async () => {
    const who = identify(interaction);
    if (!who) {
      await editOriginal(
        interaction,
        messageEdit({
          content: "Could not identify you. Try again.",
        }),
      );
      return;
    }

    const db = getDb();
    const member = await findMemberByDiscordId(db, who.discordId);
    if (!member) {
      await editOriginal(
        interaction,
        messageEdit({ content: "Please run /link again." }),
      );
      return;
    }

    const clid = selectedValues(interaction)[0];
    if (!clid) {
      await editOriginal(
        interaction,
        messageEdit({ content: "Nothing was selected. Run /link again." }),
      );
      return;
    }

    let picked;
    try {
      const online = await fetchOnlineClients(member.id);
      picked = online.find((client) => client.clid === clid);
    } catch (cause) {
      if (!(cause instanceof WorkerUnavailableError)) throw cause;
      await editOriginal(
        interaction,
        messageEdit({
          content:
            "TeamSpeak is unreachable right now. Run /link again in a few minutes.",
        }),
      );
      return;
    }

    if (!picked) {
      // Too slow, they disconnected, or the clid is stale. Start over.
      await editOriginal(
        interaction,
        messageEdit({
          content:
            "That client is no longer online. Reconnect to TeamSpeak and run " +
            "/link again.",
        }),
      );
      return;
    }

    const code = generateLinkCode();

    // The row first, then the poke: an unused code that expires in five minutes
    // is harmless, but a code poked and then not stored can never work.
    await createLinkCode(db, {
      memberId: member.id,
      targetTsUid: picked.uid,
      code,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });

    try {
      await pokeLinkCode(picked.clid, pokeMessage(code));
    } catch (cause) {
      if (!(cause instanceof WorkerUnavailableError)) throw cause;
      await editOriginal(
        interaction,
        messageEdit({
          content:
            "TeamSpeak is unreachable, so the code was not sent. Run /link again in a few minutes.",
        }),
      );
      return;
    }

    await editOriginal(
      interaction,
      messageEdit({
        content:
          `A code was sent to **${picked.nickname || "your client"}** on ` +
          "TeamSpeak. Copy it, and click *Enter code* below.",
        components: [
          actionRow(button({ customId: "link:enter", label: "Enter code" })),
        ],
      }),
    );
  });
}

/**
 * The button: open the code modal. Immediate, and it must be: a modal (type 9)
 * cannot be deferred, so this handler does no slow work. The poke already
 * happened in the select, and the button stays on the message so a dismissed
 * modal or a wrong code is recovered by clicking again.
 */
export function linkEnter(_interaction: Interaction): Response {
  return Response.json(
    modal({
      customId: "link:code",
      title: "Enter your TeamSpeak link code",
      components: [
        label({
          label: "Link code",
          component: textInput({
            customId: "code",
            placeholder: "ABC234",
            // Loose bounds: the member may paste spaces or hyphens, which
            // `verifyLinkCode` strips. The code itself is six characters.
            minLength: CODE_LENGTH,
            maxLength: 16,
          }),
        }),
      ],
    }),
  );
}

/**
 * The modal submit: verify the code and link the identity.
 *
 * The decision is `verifyLinkCode`, the pure function in `@7r/identity` with
 * tests against every way it can go wrong. This handler does the I/O the verdict
 * asks for and nothing else, exactly as the web `verify.ts` route does.
 */
export function linkCode(interaction: Interaction): Response {
  return deferThen(deferredEphemeralReply(), interaction, async () => {
    const who = identify(interaction);
    if (!who) {
      await editOriginal(
        interaction,
        messageEdit({
          content: "Could not identify you. Try again.",
        }),
      );
      return;
    }

    const db = getDb();
    const member = await findMemberByDiscordId(db, who.discordId);
    if (!member) {
      await editOriginal(
        interaction,
        messageEdit({ content: "Please run /link again." }),
      );
      return;
    }

    const submitted = extractModalValues(interaction.data).get("code") ?? "";

    const challenge = await findLiveLinkCode(db, member.id);
    if (!challenge) {
      await editOriginal(
        interaction,
        messageEdit({ content: "No code waiting. Run /link again." }),
      );
      return;
    }

    const verdict = verifyLinkCode(challenge, submitted, new Date());

    if (!verdict.ok) {
      // A wrong guess costs an attempt; running out burns the challenge so it
      // cannot be ground down across several submits.
      if (verdict.reason === "wrong_code") {
        await recordLinkCodeAttempt(db, challenge.id);
      } else if (verdict.reason === "too_many_attempts") {
        await recordLinkCodeAttempt(db, challenge.id);
        await consumeLinkCode(db, challenge.id);
      }

      await editOriginal(
        interaction,
        messageEdit({ content: verdictMessage(verdict) }),
      );
      return;
    }

    // The nickname is decoration (the uid is the identity), so it is best-effort:
    // a worker blip between the poke and the code must not fail a member who did
    // everything right.
    let tsNickname: string | null = null;
    try {
      const online = await fetchOnlineClients(member.id);
      tsNickname = online.find((c) =>
        c.uid === challenge.targetTsUid
      )?.nickname ??
        null;
    } catch {
      // Deliberately swallowed.
    }

    try {
      await completeTeamspeakLink(db, {
        memberId: member.id,
        linkCodeId: challenge.id,
        tsUid: challenge.targetTsUid,
        tsNickname,
      });
    } catch (cause) {
      // Somebody else linked that identity between the pick-list and this write.
      // The list hides taken identities, but that check and this write are not
      // atomic; only the database is.
      if (isUniqueViolation(cause)) {
        await consumeLinkCode(db, challenge.id);
        await editOriginal(
          interaction,
          messageEdit({
            content:
              "That TeamSpeak identity is already linked to another member. " +
              "If it is yours, ask an admin.",
          }),
        );
        return;
      }
      throw cause;
    }

    await editOriginal(
      interaction,
      messageEdit({ content: "Link successful! ✅" }),
    );
  });
}

/** The member-facing text for a failed verdict. */
function verdictMessage(
  verdict: Exclude<ReturnType<typeof verifyLinkCode>, { ok: true }>,
): string {
  switch (verdict.reason) {
    case "wrong_code":
      return `Wrong code. ${verdict.attemptsLeft} ${
        verdict.attemptsLeft === 1 ? "try" : "tries"
      } left. Click *Enter code* to try again.`;
    case "too_many_attempts":
      return "Too many wrong attempts. Run /link again.";
    case "expired":
      return "Code expired. Run /link again.";
    case "already_used":
      return "Code already used. Run /link again.";
  }
}
