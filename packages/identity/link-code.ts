/**
 * The TeamSpeak possession challenge: generating a code, and deciding whether
 * one that came back is good.
 *
 * Pure. No database, no clock of its own, no I/O. That is what makes it the one
 * part of the link flow that can actually be tested, in a project with no live
 * test environment (ARCHITECTURE §9).
 */

/**
 * No `O`/`0`, no `I`/`1`. Someone is reading this out of a TeamSpeak poke dialog
 * and typing it into a browser, and the two most common ways to fail at that are
 * a zero that looks like an O and a one that looks like an I.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const CODE_LENGTH = 6;

/** Five minutes, per IMPLEMENTATION §4. Long enough to alt-tab, short enough to matter. */
export const CODE_TTL_MS = 5 * 60 * 1000;

/**
 * Wrong guesses allowed before the challenge is dead.
 *
 * 32^6 is about a billion, so this is not really about brute force in the
 * arithmetic sense. It is about making "guess someone else's code" a dead end
 * rather than a slow one, and about the fact that the only person who can even
 * try is a member who has already picked a victim from the list and had a code
 * poked at them. Five is generous for a human retyping a code they can see.
 */
export const MAX_ATTEMPTS = 5;

/**
 * A fresh challenge code.
 *
 * `crypto.getRandomValues`, not `Math.random`, and the rejection loop below is
 * not pedantry: taking `byte % 32` over a uniform 0-255 would be fine for a
 * 32-character alphabet (256 divides evenly), but it stops being fine the moment
 * someone edits ALPHABET to have 30 characters in it, and it fails silently when
 * they do. Reject the tail instead, and the code stays uniform whatever the
 * alphabet is.
 */
export function generateLinkCode(length: number = CODE_LENGTH): string {
  const limit = 256 - (256 % ALPHABET.length);
  const out: string[] = [];
  const buffer = new Uint8Array(length * 2);

  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (out.length === length) break;
      if (byte >= limit) continue;
      out.push(ALPHABET[byte % ALPHABET.length]);
    }
  }

  return out.join("");
}

/** What the member typed, tidied. They will paste spaces and they will type lowercase. */
export function normalizeLinkCode(input: string): string {
  return input.trim().toUpperCase().replaceAll(/[\s-]/g, "");
}

/** The stored challenge, reduced to what the decision actually depends on. */
export interface LinkCodeChallenge {
  code: string;
  targetTsUid: string;
  expiresAt: Date;
  consumedAt: Date | null;
  attempts: number;
}

export type LinkCodeVerdict =
  /** Link it. */
  | { ok: true }
  /** The code was wrong, and they may try again. */
  | { ok: false; reason: "wrong_code"; attemptsLeft: number }
  /** Out of attempts. The challenge is dead and must be burned. */
  | { ok: false; reason: "too_many_attempts" }
  | { ok: false; reason: "expired" }
  | { ok: false; reason: "already_used" };

/**
 * Is this the right code for this challenge?
 *
 * The order matters. Expiry and consumption are checked before the code itself,
 * so a dead challenge cannot be used as a free oracle to test guesses against,
 * and an out-of-attempts challenge stays out of attempts.
 *
 * `now` is a parameter rather than a call to `new Date()`, which is what lets
 * the expiry rules be tested at all.
 */
export function verifyLinkCode(
  challenge: LinkCodeChallenge,
  submitted: string,
  now: Date,
): LinkCodeVerdict {
  if (challenge.consumedAt !== null) {
    return { ok: false, reason: "already_used" };
  }

  if (challenge.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }

  if (!timingSafeEqual(normalizeLinkCode(submitted), challenge.code)) {
    const attemptsLeft = MAX_ATTEMPTS - (challenge.attempts + 1);
    return attemptsLeft <= 0
      ? { ok: false, reason: "too_many_attempts" }
      : { ok: false, reason: "wrong_code", attemptsLeft };
  }

  return { ok: true };
}

/**
 * Constant-time-ish string compare.
 *
 * The timing side-channel on a 6-character code that dies after 5 guesses and 5
 * minutes is not a realistic attack, and this is cheap enough that arguing about
 * it costs more than doing it. It compares every character regardless of an
 * early mismatch; it does still leak the length, which is a constant.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The text of the poke. It has to be intelligible in a small dialog box. */
export function pokeMessage(code: string): string {
  return `7R link code: ${code} - enter it on the website to link this TeamSpeak identity.`;
}
