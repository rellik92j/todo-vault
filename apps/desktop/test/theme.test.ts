import assert from "node:assert/strict";
import test from "node:test";

import {
  THEME_CYCLE,
  THEME_DESCRIPTIONS,
  THEME_LABELS,
  nextTheme,
  type ThemePreference,
} from "../src/renderer/src/theme.js";

test("three presses from any state come back to it", () => {
  for (const start of THEME_CYCLE) {
    assert.equal(nextTheme(nextTheme(nextTheme(start))), start, `${start} did not close its cycle`);
  }
});

test("the cycle holds each of the three preferences exactly once", () => {
  assert.equal(THEME_CYCLE.length, 3);
  assert.deepEqual([...THEME_CYCLE].sort(), ["dark", "light", "system"]);
});

test("system is where the cycle starts, so a fresh install cycles away from the default", () => {
  assert.equal(THEME_CYCLE[0], "system");
});

/*
 * The check that earns its place: a fourth state added to the union would be
 * a compile error in THEME_LABELS (it is a Record over ThemePreference), but a
 * fourth entry added to THEME_CYCLE alone would not be, and would render a
 * button reading "undefined undefined".
 */
test("every state in the cycle has a label and a spoken description", () => {
  for (const preference of THEME_CYCLE) {
    assert.ok(THEME_LABELS[preference], `${preference} has no label`);
    assert.ok(THEME_LABELS[preference].glyph, `${preference} has no glyph`);
    assert.ok(THEME_LABELS[preference].label, `${preference} has no words`);
    assert.ok(THEME_DESCRIPTIONS[preference], `${preference} has no description`);
  }
});

test("an unrecognised preference recovers to system rather than sticking", () => {
  assert.equal(nextTheme("sepia" as ThemePreference), "system");
});
