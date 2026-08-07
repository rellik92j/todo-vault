import assert from "node:assert/strict";
import test from "node:test";

import {
  BOTH,
  BUILD_STALE,
  countCommits,
  isBuildStale,
  REMOTE_AHEAD,
  UP_TO_DATE,
  verdictCode,
} from "./check-updates.mjs";

test("a source newer than the build is stale", () => {
  assert.equal(isBuildStale([200], [100]), true);
  assert.equal(isBuildStale([50], [100]), false);
});

test("a half-finished build reads as stale", () => {
  // The three outputs come from one `electron-vite build`, but a build that
  // failed partway leaves some rewritten and the rest as they were. Comparing
  // against the *oldest* output is what stops one fresh file vouching for two
  // stale ones.
  assert.equal(isBuildStale([150], [100, 200, 300]), true);
});

test("equal timestamps are not stale", () => {
  // A build writes its outputs after reading its inputs, so equality is the
  // boundary of a build that did happen — treating it as stale would nag after
  // every successful build on a coarse filesystem clock.
  assert.equal(isBuildStale([100], [100]), false);
});

test("nothing built is not this script's verdict to give", () => {
  // launch.vbs already refuses to start an unbuilt app and says so. Reporting
  // it here as well would put the same rule in two places, and the second one
  // would be reached only when the first had let it through.
  assert.equal(isBuildStale([100], []), false);
});

test("unreadable sources produce no verdict rather than a guess", () => {
  // A tree that is not shaped the way this expects should launch the app in
  // silence. Inventing staleness from an empty list is exactly the unfounded
  // nagging the whole design is trying to avoid.
  assert.equal(isBuildStale([], [100]), false);
  assert.equal(isBuildStale([], []), false);
});

test("a commit count is read off git's single number", () => {
  assert.equal(countCommits("3\n"), 3);
  assert.equal(countCommits("  12  "), 12);
  assert.equal(countCommits("0\n"), 0);
});

test("anything unparseable counts as nothing to report", () => {
  // Every caller treats "could not tell" and "nothing to say" identically, and
  // a git answering in an unexpected shape is not grounds for a dialog.
  assert.equal(countCommits(""), 0);
  assert.equal(countCommits("fatal: no upstream configured"), 0);
  assert.equal(countCommits("-1"), 0);
});

test("the verdict codes are the ones launch.vbs switches on", () => {
  assert.equal(verdictCode(false, 0), UP_TO_DATE);
  assert.equal(verdictCode(true, 0), BUILD_STALE);
  assert.equal(verdictCode(false, 4), REMOTE_AHEAD);
  assert.equal(verdictCode(true, 4), BOTH);
});

test("the codes are distinct and none of them collides with a failure", () => {
  // 1 is Node's exit code for an uncaught exception, and the launcher reads
  // anything it does not recognise as "say nothing" — so no verdict may be 1,
  // or a crashed check would surface as advice.
  const codes = [UP_TO_DATE, BUILD_STALE, REMOTE_AHEAD, BOTH];

  assert.equal(new Set(codes).size, codes.length);
  assert.ok(!codes.includes(1));
});
