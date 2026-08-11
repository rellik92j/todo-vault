import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/**
 * The colour palette, checked against both grounds rather than against taste.
 *
 * This exists because prose could not hold the rule. `--disregard` was added to
 * `:root` a day after light mode already existed and never got a light value,
 * and nothing failed — not a test, not a typecheck, not a review. The palette
 * has two halves and only one of them was ever being maintained.
 *
 * So the invariant is enforced here instead: every colour in `:root` appears in
 * the light block too, and every one of them clears a contrast floor against
 * the surfaces it can actually land on. A new token cannot be added to one side
 * alone, and a hue cannot be picked that vanishes on one of the two grounds.
 *
 * `__dirname` rather than `import.meta.url`: this workspace has no
 * `"type": "module"`, so tsx transpiles `test/*.ts` to CJS — the same reason
 * `e2e/*.mts` carry the `.mts` extension.
 */
const CSS = readFileSync(path.join(__dirname, "../src/renderer/src/index.css"), "utf8");

/** The two `:root` blocks, in source order: dark first, then the light override. */
function rootBlocks(): [Record<string, string>, Record<string, string>] {
  // `[^}]*` is safe because neither block nests braces. If one ever does, this
  // returns short and the parity assertion below fails loudly rather than
  // quietly passing on a truncated read.
  const blocks = [...CSS.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) => m[1] ?? "");
  assert.equal(blocks.length, 2, `expected exactly two :root blocks, found ${blocks.length}`);
  return blocks.map((body) => {
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[name!] = value!.trim();
    }
    return tokens;
  }) as [Record<string, string>, Record<string, string>];
}

const [DARK, LIGHT] = rootBlocks();
const isColour = (value: string): boolean => /^#[0-9a-f]{3,8}$/i.test(value);

// ------------------------------------------------------------------ contrast

function channels(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG 1.4.11: non-text UI needs 3:1. A 6px status dot and the 2px priority
 * stripe down a card are both exactly that — the stripe especially, since it is
 * the only place priority is carried with no word beside it.
 */
const UI_FLOOR = 3;
/** WCAG 1.4.3 AA for body text. */
const TEXT_FLOOR = 4.5;

/** The grounds an identity colour can land on. `--accent-dim` is excluded — see below. */
const GROUNDS = ["--bg", "--bg-raised", "--bg-inset"] as const;

const IDENTITY = [
  "--highest", "--high", "--medium", "--low", "--lowest",
  "--todo", "--in_progress", "--in_review", "--blocked", "--done", "--disregard",
  "--overdue",
] as const;

/** Identity tokens that are also rendered as text, so they owe the higher floor. */
const AS_TEXT: Record<string, string[]> = {
  // .history-diff-add sits on --bg-raised; .history-after on the page --bg.
  "--done": ["--bg", "--bg-raised"],
  // .history-before, .history-diff-remove.
  "--highest": ["--bg", "--bg-raised"],
  // .due-overdue, .field-note.due-overdue, .section-range.due-overdue, .clear-btn:hover.
  "--overdue": ["--bg", "--bg-raised", "--bg-inset"],
};

// --------------------------------------------------------------------- tests

test("every colour in :root is answered in the light block", () => {
  const missing = Object.entries(DARK)
    .filter(([name, value]) => isColour(value) && !(name in LIGHT))
    .map(([name]) => name);
  assert.deepEqual(
    missing,
    [],
    `these have no light value, which is how --disregard went unnoticed: ${missing.join(", ")}`,
  );
});

test("the light block introduces no colour the dark block does not have", () => {
  const stray = Object.keys(LIGHT).filter((name) => !(name in DARK));
  assert.deepEqual(stray, [], `only defined under light, so dark falls back to nothing: ${stray}`);
});

test("every identity colour clears 3:1 on all three grounds, in both schemes", () => {
  for (const [scheme, tokens] of [["dark", DARK], ["light", LIGHT]] as const) {
    for (const token of IDENTITY) {
      const colour = tokens[token];
      assert.ok(colour, `${scheme} has no ${token}`);
      for (const ground of GROUNDS) {
        const ratio = contrast(colour!, tokens[ground]!);
        assert.ok(
          ratio >= UI_FLOOR,
          `${scheme} ${token} (${colour}) on ${ground} is ${ratio.toFixed(2)}:1, under ${UI_FLOOR}`,
        );
      }
    }
  }
});

test("identity colours that render as text clear 4.5:1 where they render", () => {
  for (const [scheme, tokens] of [["dark", DARK], ["light", LIGHT]] as const) {
    for (const [token, grounds] of Object.entries(AS_TEXT)) {
      for (const ground of grounds) {
        const ratio = contrast(tokens[token]!, tokens[ground]!);
        assert.ok(
          ratio >= TEXT_FLOOR,
          `${scheme} ${token} as text on ${ground} is ${ratio.toFixed(2)}:1, under ${TEXT_FLOOR}`,
        );
      }
    }
  }
});

test("--on-fill is readable on every fill it is painted onto", () => {
  // .btn-primary fills with --accent; .btn-danger:hover fills with --overdue.
  // This is the check that would have caught white-on-#6ea8fe at 2.4:1.
  for (const [scheme, tokens] of [["dark", DARK], ["light", LIGHT]] as const) {
    for (const fill of ["--accent", "--overdue"]) {
      const ratio = contrast(tokens["--on-fill"]!, tokens[fill]!);
      assert.ok(
        ratio >= TEXT_FLOOR,
        `${scheme} --on-fill on ${fill} is ${ratio.toFixed(2)}:1, under ${TEXT_FLOOR}`,
      );
    }
  }
});

test("no rule outside the two :root blocks hardcodes white or black as a colour", () => {
  // The scrims and box-shadows are deliberately exempt: `rgb(0 0 0 / …)` behind
  // a modal is a scrim in both schemes and means the same thing in both. This
  // is about `color:` and `background:` literals, which are the ones that stop
  // tracking the scheme.
  const outside = CSS.replace(/:root\s*\{[^}]*\}/g, "");
  const literals = [...outside.matchAll(/(?:^|\s)(?:color|background(?:-color)?)\s*:\s*(#[0-9a-f]{3,8})/gi)];
  assert.deepEqual(
    literals.map((m) => m[1]),
    [],
    "a colour literal outside the token blocks cannot follow the scheme",
  );
});
