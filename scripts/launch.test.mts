import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = readFileSync(path.join(REPO_ROOT, "scripts", "launch.vbs"), "utf8");

/**
 * Every double-quoted run on a line that is not a whole-line comment.
 *
 * Crude by design. VBScript has no escape for a quote inside a string other
 * than doubling it, and launch.vbs has no such string, so pairing quotes left
 * to right is exact here. Comments in that file are always whole lines, which
 * is what makes skipping them on the first character correct.
 */
export function stringLiterals(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("'"))
    .flatMap((line) => [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? ""));
}

test("every string the launcher can display is plain ASCII", () => {
  // The Windows Script Host reads a .vbs through the system ANSI codepage
  // rather than as UTF-8, so an em dash written into a message arrives in the
  // dialog as the three characters its UTF-8 bytes spell. It looks correct in
  // the source and wrong only on screen, which is the kind of defect that
  // survives review, so it is pinned here instead.
  const offenders = stringLiterals(LAUNCHER)
    .filter((literal) => [...literal].some((char) => char.charCodeAt(0) > 127))
    .map((literal) => literal.trim());

  assert.deepEqual(offenders, [], `non-ASCII in a launcher string: ${offenders.join(" | ")}`);
});

test("the ASCII check reads strings and ignores comments", () => {
  // The negative control. A scan like the one above passes just as happily when
  // it is finding nothing because it is looking in the wrong place, and the
  // first version of this file did exactly that — so the extractor is pinned
  // against a sample with the answer known, rather than only against a file
  // that is expected to be clean.
  const sample = [
    `' a comment containing — an em dash, which never renders`,
    `    message = "plain ascii"`,
    `    other = "has — a dash"`,
  ].join("\n");

  assert.deepEqual(stringLiterals(sample), ["plain ascii", "has — a dash"]);

  const offenders = stringLiterals(sample).filter((s) =>
    [...s].some((c) => c.charCodeAt(0) > 127),
  );
  assert.deepEqual(offenders, ["has — a dash"]);
});

test("the launcher and the checker agree on what the exit codes mean", () => {
  // The two files are the only pair in the repo with a numeric contract between
  // them, and nothing else would notice if one side renumbered. check-updates
  // exports the codes; this asserts the launcher still branches on the same set.
  for (const code of [2, 3, 4]) {
    assert.ok(
      new RegExp(`verdict = ${code}`).test(LAUNCHER),
      `launch.vbs no longer handles verdict ${code}`,
    );
  }
});

test("the launcher starts the app before it checks for updates", () => {
  // The whole reason the check is worth having is that it costs nothing at
  // startup. Reordering these two would reintroduce the wait the shortcut was
  // built to remove, and would do it invisibly.
  const launch = LAUNCHER.indexOf("shell.Run \"\"\"\" & electronExe");
  const check = LAUNCHER.indexOf("check-updates.mts");

  assert.ok(launch !== -1 && check !== -1, "expected both the launch and the check to be present");
  assert.ok(launch < check, "the update check must not run before the app is started");
});
