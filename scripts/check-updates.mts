/**
 * Answers one question — is this copy behind? — and says so in its exit code.
 *
 *   npm run check-updates
 *
 * Written for `scripts/launch.vbs`, which runs it hidden a moment after the app
 * has already started. That ordering is the whole design: the shortcut exists to
 * open the app instantly, so nothing here is allowed to happen before the window
 * appears. It also means the answer arrives as a dialog over a running app
 * rather than as a delay in front of one.
 *
 * The verdict is an exit code because VBScript cannot read a child process's
 * stdout without redirecting it to a file and cleaning up afterwards, while
 * `WshShell.Run(..., True)` hands back the exit code for free. Printing the same
 * verdict in prose as well costs nothing and makes the script usable by hand.
 *
 * Everything here fails soft. A machine with no git, no network, no remote, or a
 * repository copied out of its clone should launch the app and hear nothing —
 * the failure mode to avoid is a dialog nagging about an update that cannot be
 * checked, on every single launch.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The exit codes launch.vbs switches on. Anything not listed — including the 1
 * Node uses for an uncaught exception — means "could not tell", and the
 * launcher stays quiet rather than guessing.
 */
export const UP_TO_DATE = 0;
export const CHECK_FAILED = 1;
export const BUILD_STALE = 2;
export const REMOTE_AHEAD = 3;
export const BOTH = 4;

/**
 * What counts as an input to the built app, and what counts as the build.
 *
 * `packages/core` is in the source list but `packages/core/dist` is not in the
 * output list, deliberately: `electron.vite.config.ts` excludes `todo-vault`
 * from `externalizeDepsPlugin`, so the core is compiled *into*
 * `out/main/index.js` rather than required from disk at runtime. A freshly built
 * `dist` therefore changes nothing about what the shortcut opens, which is
 * exactly the trap `npm run update` leaves behind by rebuilding core alone.
 */
const SOURCE_PATHS = [
  "packages/core/src",
  "apps/desktop/src",
  "apps/desktop/electron.vite.config.ts",
  "package.json",
  "packages/core/package.json",
  "apps/desktop/package.json",
];

const BUILD_OUTPUTS = [
  "apps/desktop/out/main/index.js",
  "apps/desktop/out/preload/index.js",
  "apps/desktop/out/renderer/index.html",
];

/**
 * Newest input against oldest output, rather than newest against newest.
 *
 * The three outputs are written by one `electron-vite build`, but a build that
 * failed partway leaves some of them updated and the rest as they were. Taking
 * the oldest means a half-finished build reads as stale, which it is. Comparing
 * against the newest would let one rewritten file vouch for the other two.
 *
 * Both empty cases return false on purpose. No outputs means nothing is built,
 * which is the launcher's own guard and not this script's business. No sources
 * means the tree is not what this expects, and inventing a verdict from it would
 * produce exactly the unfounded nagging this file is trying not to do.
 */
export function isBuildStale(sourceMtimes: number[], outputMtimes: number[]): boolean {
  if (sourceMtimes.length === 0 || outputMtimes.length === 0) return false;
  return Math.max(...sourceMtimes) > Math.min(...outputMtimes);
}

/**
 * Reads `git rev-list --count`'s single number.
 *
 * Anything unparseable is zero rather than an error: every caller treats "could
 * not tell" and "nothing to report" the same way, and a git that answered in an
 * unexpected shape is not grounds for a dialog.
 */
export function countCommits(stdout: string): number {
  const parsed = Number.parseInt(stdout.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function verdictCode(staleBuild: boolean, commitsBehind: number): number {
  if (staleBuild && commitsBehind > 0) return BOTH;
  if (staleBuild) return BUILD_STALE;
  if (commitsBehind > 0) return REMOTE_AHEAD;
  return UP_TO_DATE;
}

/** Every file's mtime under a path, or the file's own. Missing paths contribute nothing. */
function mtimesUnder(relative: string): number[] {
  const absolute = path.join(REPO_ROOT, relative);

  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return [];
  }

  if (stats.isFile()) return [stats.mtimeMs];
  if (!stats.isDirectory()) return [];

  try {
    return readdirSync(absolute, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
  } catch {
    return [];
  }
}

/**
 * git, with both ways it can block turned off.
 *
 * This runs from a hidden window, so a prompt is not something the user can
 * answer — `GIT_TERMINAL_PROMPT=0` stops the console one, which would otherwise
 * wait forever against a stdin nobody can reach, and `GCM_INTERACTIVE=never`
 * stops Git Credential Manager raising a GUI dialog that would appear out of
 * nowhere with nothing to say which program wanted it. The timeout is the
 * backstop for everything neither of those covers, a hung proxy being the
 * obvious one.
 */
function git(args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * How many commits the upstream branch has that this one does not.
 *
 * Zero for every kind of "cannot tell": git missing, no remote, no upstream for
 * this branch, offline, credentials refused, a folder copied out of its clone.
 * `@{upstream}` rather than a hardcoded `origin/main` so this still answers
 * correctly on a branch, where the interesting comparison is to that branch's
 * own remote and not to somebody else's default.
 */
function commitsBehind(): number {
  if (git(["fetch", "--quiet"]).status !== 0) return 0;
  const counted = git(["rev-list", "--count", "HEAD..@{upstream}"]);
  if (counted.status !== 0) return 0;
  return countCommits(counted.stdout);
}

function main(): number {
  const sources = SOURCE_PATHS.flatMap(mtimesUnder);
  const outputs = BUILD_OUTPUTS.flatMap(mtimesUnder);

  const stale = isBuildStale(sources, outputs);
  const behind = commitsBehind();
  const verdict = verdictCode(stale, behind);

  // For anyone running this by hand. launch.vbs ignores all of it and reads the
  // exit code, so this can say as much as is useful without affecting it.
  const lines = [
    stale
      ? "The built app is older than the source it was built from — `npm run build`."
      : "The built app is up to date with the source.",
    behind > 0
      ? `${behind} newer commit${behind === 1 ? "" : "s"} upstream — \`npm run update\`.`
      : "No newer commits upstream, or the remote could not be reached.",
  ];
  process.stdout.write(`\n  ${lines.join("\n  ")}\n\n`);

  return verdict;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch {
    // Deliberately silent, and deliberately not 0: the launcher treats anything
    // it does not recognise as "say nothing", which is the right outcome for a
    // check that broke.
    process.exitCode = CHECK_FAILED;
  }
}
