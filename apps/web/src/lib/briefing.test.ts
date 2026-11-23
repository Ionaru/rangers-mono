import assert from "node:assert/strict";
import { test } from "node:test";
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

test("buildBriefingSqf reproduces the legacy SQF byte-for-byte", () => {
  assert.deepStrictEqual(buildBriefingSqf(SAMPLE), EXPECTED);
});

test("output is trimmed: no leading or trailing whitespace", () => {
  const out = buildBriefingSqf(SAMPLE);
  assert.deepStrictEqual(out, out.trim());
});

test("records are emitted in reverse reading order (Arma prepends)", () => {
  const out = buildBriefingSqf(SAMPLE);
  // Credits is written first so it renders last; Situation last so it renders first.
  const first0 = out.indexOf('["Credits"');
  const second0 = out.indexOf('["Execution"');
  assert.ok(
    first0 >= 0 && first0 < second0,
    `expected "Credits" (${first0}) before "Execution" (${second0})`,
  );
  const first1 = out.indexOf('["Execution"');
  const second1 = out.indexOf('["Mission"');
  assert.ok(
    first1 >= 0 && first1 < second1,
    `expected "Execution" (${first1}) before "Mission" (${second1})`,
  );
  const first2 = out.indexOf('["Mission"');
  const second2 = out.indexOf('["Situation"');
  assert.ok(
    first2 >= 0 && first2 < second2,
    `expected "Mission" (${first2}) before "Situation" (${second2})`,
  );
});

test("cleanText escapes as HTML entities, & first", () => {
  assert.deepStrictEqual(cleanText("&"), "&amp;");
  // & must be escaped before the entities we insert, or they double-escape.
  assert.deepStrictEqual(cleanText("&lt;"), "&amp;lt;");
  assert.deepStrictEqual(cleanText("<tag>"), "&lt;tag&gt;");
  assert.deepStrictEqual(cleanText(`"q" 'a'`), "&quot;q&quot; &#039;a&#039;");
});

test("cleanText is NOT SQF quote-doubling", () => {
  // A double quote becomes an entity, never "" — that is what keeps the SQF
  // "…" literal from breaking.
  assert.deepStrictEqual(cleanText(`say "hi"`), "say &quot;hi&quot;");
});

test("cleanText expands newlines to a literal <br/> between real newlines", () => {
  assert.deepStrictEqual(cleanText("a\nb"), "a\n<br/>\nb");
});

test("cleanText trims each field", () => {
  assert.deepStrictEqual(cleanText("   padded   "), "padded");
});
