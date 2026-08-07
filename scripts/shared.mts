/**
 * The four things every script in this folder was writing out for itself.
 *
 * This exists for one of them in particular. The rule about how npm has to be
 * spawned on Windows is not obvious, is easy to undo by accident, and was
 * argued at length in two files — with `update.mts` openly conceding "for the
 * same reason menu.mts does it". A reason stated twice is a reason that can
 * drift, and the one below is the kind where drifting means a bug nobody sees
 * until an argument contains a space.
 *
 * What is deliberately *not* here is the spawning itself. `menu.mts` spawns
 * asynchronously with `stdio: "inherit"` and ignores SIGINT so a Ctrl+C reaches
 * the child and returns you to the menu; `update.mts` uses `spawnSync` and stops
 * at the first non-zero exit. Those differences are the whole behaviour of each
 * script and neither is a special case of the other, so unifying them would mean
 * a wrapper with a flag for every difference — more to read than the two
 * versions it replaced.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/**
 * The repo root, derived from this file's own location.
 *
 * Every script had its own copy of this line. Derived rather than hardcoded so
 * a clone works wherever it lands, which is the same reason `launch.vbs` walks
 * up from `WScript.ScriptFullName` instead of naming a path.
 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Whether this module was run as a command rather than imported.
 *
 * Every script here exports something a test imports, and importing a module
 * must not launch it into the test runner's stdout. Pass `import.meta.url`.
 */
export function isMain(moduleUrl: string): boolean {
  return (
    process.argv[1] !== undefined &&
    path.resolve(process.argv[1]) === path.resolve(fileURLToPath(moduleUrl))
  );
}

// ---------------------------------------------------------------- presentation

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

/** Wraps text in an ANSI SGR code, or returns it untouched when colour is off. */
export const paint =
  (code: string) =>
  (s: string): string =>
    useColor ? `\u001b[${code}m${s}\u001b[0m` : s;

export const bold = paint("1");
export const dim = paint("2");
export const red = paint("31");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");

// ------------------------------------------------------------------------ npm

/**
 * npm's own JavaScript entry point, to be run through `process.execPath`.
 *
 * Never spawn `npm` or `npm.cmd` directly on Windows. Both are batch shims, and
 * since the fix for CVE-2024-27980 Node refuses to spawn one without
 * `shell: true` — which hands the whole command line to `cmd.exe` as a single
 * unquoted string, mangling any argument containing a space and earning a
 * DEP0190 deprecation for the privilege. Going through node keeps a real argv,
 * so `--summary "two words"` survives.
 *
 * `npm_execpath` is set by npm for its children and points at the .js file, so
 * a script started by `npm run` reuses the exact npm that launched it rather
 * than whichever one PATH finds first — something nvm-windows and friends can
 * disagree about. The fallback covers being started directly (`tsx
 * scripts/menu.mts`), where npm sits beside node.
 *
 * Returns null when neither is found. That is survivable on POSIX, where the
 * bare name spawns without a shell anyway, and callers decide what it means for
 * them — which is why this resolves and does not spawn.
 *
 * Note the opposite call `scripts/bootstrap.ps1` makes: there npm is invoked as
 * `npm.cmd` precisely *because* PowerShell would otherwise resolve the bare name
 * to npm.ps1, which a Restricted execution policy will not load. Different host,
 * inverted answer; neither is a mistake.
 */
export function npmCli(): string | null {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv?.endsWith(".js") && existsSync(fromEnv)) return fromEnv;

  const beside = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(beside) ? beside : null;
}
