import { assertEquals, assertLess } from "@std/assert";
import { type BriefingInput, buildBriefingSqf, cleanText } from "./briefing.ts";

/**
 * The oracle: `EXPECTED` is transcribed by hand from the legacy Nuxt tool's
 * template (not produced by buildBriefingSqf), so this is a genuine byte-for-byte
 * check, not a tautology. If the builder's whitespace, ordering, `<br/>`s or the
 * single-quoted `<font>` tags ever drift, this fails.
 */
const SAMPLE: BriefingInput = {
  situation: "Enemy activity reported.",
  enemyForces: "OPFOR infantry.",
  friendlyForces: "BLUFOR squad.",
  mission: "Secure the objective.",
  commandersIntent: "Move fast, hit hard.",
  movementPlan: "Insert by helicopter.",
  fireSupportPlan: "Mortar support on call.",
  credits: "Zeus",
};

const EXPECTED = `player createDiaryRecord ["diary", ["Credits","
Mission created by Zeus
<br/><br/>
Using 7R Framework
<br/><br/>
Briefing made with 7R Briefing Generator (https://www.7th-ranger.com/briefing-generator)
"]];

player createDiaryRecord ["diary", ["Execution","
<font size='18'>COMMANDER'S INTENT</font>
<br/>
Move fast, hit hard.
<br/><br/>
<font size='18'>MOVEMENT PLAN</font>
<br/>
Insert by helicopter.
<br/><br/>
<font size='18'>FIRE SUPPORT PLAN</font>
<br/>
Mortar support on call.
"]];

player createDiaryRecord ["diary", ["Mission","
Secure the objective.
"]];

player createDiaryRecord ["diary", ["Situation","
Enemy activity reported.
<br/><br/>
<font size='18'>ENEMY FORCES</font>
<br/>
OPFOR infantry.
<br/><br/>
<font size='18'>FRIENDLY FORCES</font>
<br/>
BLUFOR squad.
"]];`;

Deno.test("buildBriefingSqf reproduces the legacy SQF byte-for-byte", () => {
  assertEquals(buildBriefingSqf(SAMPLE), EXPECTED);
});

Deno.test("output is trimmed: no leading or trailing whitespace", () => {
  const out = buildBriefingSqf(SAMPLE);
  assertEquals(out, out.trim());
});

Deno.test("records are emitted in reverse reading order (Arma prepends)", () => {
  const out = buildBriefingSqf(SAMPLE);
  // Credits is written first so it renders last; Situation last so it renders first.
  assertLess(out.indexOf('["Credits"'), out.indexOf('["Execution"'));
  assertLess(out.indexOf('["Execution"'), out.indexOf('["Mission"'));
  assertLess(out.indexOf('["Mission"'), out.indexOf('["Situation"'));
});

Deno.test("cleanText escapes as HTML entities, & first", () => {
  assertEquals(cleanText("&"), "&amp;");
  // & must be escaped before the entities we insert, or they double-escape.
  assertEquals(cleanText("&lt;"), "&amp;lt;");
  assertEquals(cleanText("<tag>"), "&lt;tag&gt;");
  assertEquals(cleanText(`"q" 'a'`), "&quot;q&quot; &#039;a&#039;");
});

Deno.test("cleanText is NOT SQF quote-doubling", () => {
  // A double quote becomes an entity, never "" — that is what keeps the SQF
  // "…" literal from breaking.
  assertEquals(cleanText(`say "hi"`), "say &quot;hi&quot;");
});

Deno.test("cleanText expands newlines to a literal <br/> between real newlines", () => {
  assertEquals(cleanText("a\nb"), "a\n<br/>\nb");
});

Deno.test("cleanText trims each field", () => {
  assertEquals(cleanText("   padded   "), "padded");
});
