/**
 * The briefing generator's SQF builder. Pure: plain data in, a string out, no
 * DOM and no I/O, so it is unit-testable (briefing.test.ts) and reused verbatim
 * by the client `<script>` on /briefing-generator.
 *
 * This reproduces the legacy Nuxt tool's output **byte-for-byte** (ARCHITECTURE
 * §4.1). Two rules that look wrong but are not:
 *
 * - `cleanText` is **HTML-entity escaping, not SQF quote-doubling.** A user `"`
 *   becomes `&quot;`, never `""`. The Arma diary renders the entity, and the SQF
 *   `"…"` string literal never sees a bare quote to break on. The replace order
 *   matters: `&` must go first, or the entities inserted afterwards get
 *   double-escaped.
 * - The four records are emitted **Credits → Execution → Mission → Situation**,
 *   which is the reverse of how they read in-game. `createDiaryRecord` prepends,
 *   so the last one written (Situation) shows first. Do not "fix" the order.
 */

export interface BriefingInput {
  situation: string;
  enemyForces: string;
  friendlyForces: string;
  mission: string;
  commandersIntent: string;
  movementPlan: string;
  fireSupportPlan: string;
  credits: string;
}

/** The eight fields, in form order. Shared by the page UI and validation. */
export const BRIEFING_FIELDS: readonly (keyof BriefingInput)[] = [
  "situation",
  "enemyForces",
  "friendlyForces",
  "mission",
  "commandersIntent",
  "movementPlan",
  "fireSupportPlan",
  "credits",
];

/**
 * Escape one field for embedding in the SQF diary string. HTML entities (the
 * Arma diary is HTML-ish), each newline expanded to a literal `<br/>` kept
 * between real newlines. `&` first. Ported verbatim from the legacy tool.
 */
export function cleanText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("\n", "\n<br/>\n")
    .trim();
}

/**
 * Build the SQF a mission maker pastes into `briefing.sqf`. The returned string
 * is trimmed, matching what the legacy tool put on the clipboard.
 */
export function buildBriefingSqf(input: BriefingInput): string {
  const situation = cleanText(input.situation);
  const enemyForces = cleanText(input.enemyForces);
  const friendlyForces = cleanText(input.friendlyForces);
  const mission = cleanText(input.mission);
  const commandersIntent = cleanText(input.commandersIntent);
  const movementPlan = cleanText(input.movementPlan);
  const fireSupportPlan = cleanText(input.fireSupportPlan);
  const credits = cleanText(input.credits);

  const sqf = `
player createDiaryRecord ["diary", ["Credits","
Mission created by ${credits}
<br/><br/>
Using 7R Framework
<br/><br/>
Briefing made with 7R Briefing Generator (https://www.7th-ranger.com/briefing-generator)
"]];

player createDiaryRecord ["diary", ["Execution","
<font size='18'>COMMANDER'S INTENT</font>
<br/>
${commandersIntent}
<br/><br/>
<font size='18'>MOVEMENT PLAN</font>
<br/>
${movementPlan}
<br/><br/>
<font size='18'>FIRE SUPPORT PLAN</font>
<br/>
${fireSupportPlan}
"]];

player createDiaryRecord ["diary", ["Mission","
${mission}
"]];

player createDiaryRecord ["diary", ["Situation","
${situation}
<br/><br/>
<font size='18'>ENEMY FORCES</font>
<br/>
${enemyForces}
<br/><br/>
<font size='18'>FRIENDLY FORCES</font>
<br/>
${friendlyForces}
"]];
`;

  return sqf.trim();
}
