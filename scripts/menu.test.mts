import assert from "node:assert/strict";
import test from "node:test";

import { tokenize } from "./menu.mjs";

test("splits a plain command line on whitespace", () => {
  assert.deepEqual(tokenize("agenda week"), ["agenda", "week"]);
  assert.deepEqual(tokenize("  list   --project   ENG  "), ["list", "--project", "ENG"]);
});

test("keeps a quoted value as one argument", () => {
  // The case a plain .split(/\s+/) gets wrong, and the reason this exists.
  assert.deepEqual(tokenize('new --summary "Two words"'), ["new", "--summary", "Two words"]);
  assert.deepEqual(tokenize("new --summary 'Two words'"), ["new", "--summary", "Two words"]);
});

test("handles a quote that starts mid-argument", () => {
  assert.deepEqual(tokenize('--summary="Two words"'), ["--summary=Two words"]);
});

test("preserves a deliberately empty argument", () => {
  assert.deepEqual(tokenize('--summary ""'), ["--summary", ""]);
});

test("returns nothing for blank input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("does not treat an inner apostrophe as a quote when already quoted", () => {
  assert.deepEqual(tokenize(`--summary "it's fine"`), ["--summary", "it's fine"]);
});
