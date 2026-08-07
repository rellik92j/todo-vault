/**
 * Puts a double-clickable todo-vault shortcut on the desktop.
 *
 *   npm run shortcut
 *
 * The shortcut runs scripts/launch.vbs, which starts the built app with no
 * terminal attached — see that file for why a .vbs is what does it. This script
 * exists because a .lnk is a binary COM-authored format: there is no writing one
 * from Node without going through WScript.Shell, so the work is done by a short
 * PowerShell command spawned from here.
 *
 * Re-running is the fix for a moved or renamed repo. CreateShortcut opens an
 * existing .lnk for editing rather than refusing, so a second run rewrites the
 * paths in place instead of leaving a shortcut pointing at where the repo used
 * to be.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { REPO_ROOT, isMain } from "./shared.mjs";

/** What the shortcut is called, on the desktop and in its own tooltip. */
const SHORTCUT_NAME = "todo-vault";

const LAUNCHER = "scripts\\launch.vbs";
const ELECTRON_EXE = "node_modules\\electron\\dist\\electron.exe";

/**
 * Quotes a string as a PowerShell single-quoted literal.
 *
 * Single quotes rather than double because PowerShell expands `$` inside double
 * quotes, and these are filesystem paths from an arbitrary machine — a folder
 * called `$RECYCLE.BIN` or a user who put a `$` in a directory name should not
 * produce a shortcut pointing somewhere else entirely. Inside single quotes the
 * only character with meaning is the quote itself, escaped by doubling, which
 * covers the O'Brien case.
 */
function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Builds the PowerShell that writes the .lnk, and prints where it wrote it.
 *
 * Pure, and exported, so the test can assert the two things about this shortcut
 * that are easy to get wrong and impossible to notice until someone
 * double-clicks it on another machine.
 *
 * The first is that it targets wscript.exe and passes the .vbs as an argument,
 * rather than targeting the .vbs directly. A shortcut to a script file is
 * resolved through the .vbs file association, and that association is not
 * reliably wscript: some machines have it pointed at an editor, either by an
 * administrator discouraging script execution or by someone once choosing "Open
 * with". On those machines a shortcut to the .vbs opens Notepad and the app
 * never starts. Naming the host explicitly makes the association irrelevant.
 *
 * The second is that the desktop path comes from GetFolderPath rather than
 * being assembled from the home directory. OneDrive's Known Folder Move
 * redirects Desktop into the synced folder and rewrites the shell folder entry
 * to match, so `~/Desktop` on a machine with it enabled is either stale or
 * absent — and this repo is used on exactly such a machine.
 */
export function shortcutScript(repoRoot: string, wscriptExe: string): string {
  const launcher = path.join(repoRoot, LAUNCHER);
  const icon = path.join(repoRoot, ELECTRON_EXE);

  return [
    `$desktop = [Environment]::GetFolderPath('Desktop')`,
    `$lnk = Join-Path $desktop ${psLiteral(`${SHORTCUT_NAME}.lnk`)}`,
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)`,
    `$s.TargetPath = ${psLiteral(wscriptExe)}`,
    // Quoted inside the argument string as well: the repo path reaches wscript
    // as a command line, not as an argv, so a space in it splits the path in
    // two and wscript reports a script it cannot find.
    `$s.Arguments = ${psLiteral(`"${launcher}"`)}`,
    `$s.WorkingDirectory = ${psLiteral(repoRoot)}`,
    // There is no .ico in this repo yet (PACKAGING.md keeps that on the list),
    // so the choice is between wscript's script-page icon — which reads as
    // "some automation" rather than as an app — and Electron's own. Electron's
    // is at least the icon the running window already shows.
    `$s.IconLocation = ${psLiteral(`${icon},0`)}`,
    `$s.Description = ${psLiteral(`${SHORTCUT_NAME} — local-first task vault`)}`,
    `$s.Save()`,
    `Write-Output $lnk`,
  ].join("; ");
}

/**
 * System32 rather than a bare `wscript`, because the value is written into a
 * shortcut that has no PATH of its own to resolve against. SystemRoot is read
 * rather than assumed since Windows is not always on C:. The 32-bit/64-bit
 * redirection that usually complicates System32 does not apply: Node here is
 * 64-bit, so this resolves to the real directory, and the path is only ever
 * handed to Explorer anyway.
 */
export function wscriptPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
}

async function main(): Promise<void> {
  if (process.platform !== "win32") {
    process.stdout.write(
      "\nThis makes a Windows .lnk, so it only runs on Windows.\n" +
        "On macOS and Linux the app still starts with `npm run preview`.\n\n",
    );
    process.exitCode = 1;
    return;
  }

  const launcher = path.join(REPO_ROOT, LAUNCHER);
  if (!existsSync(launcher)) {
    process.stdout.write(`\n${launcher} is missing — nothing to point a shortcut at.\n\n`);
    process.exitCode = 1;
    return;
  }

  const script = shortcutScript(REPO_ROOT, wscriptPath());

  // -NoProfile so a slow or broken user profile cannot affect this, and
  // -ExecutionPolicy Bypass because -Command is not a script file: the policy
  // that blocks npm.ps1 on a stock Windows install does not apply to an inline
  // command, and passing it anyway costs nothing and removes the question.
  const code = await new Promise<number>((settle) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });

    child.on("error", (err: Error) => {
      process.stdout.write(`\ncould not run powershell.exe: ${err.message}\n\n`);
      settle(127);
    });

    child.on("exit", (status) => {
      if (status === 0) {
        const written = out.trim();
        process.stdout.write(
          `\n  Shortcut created.\n\n` +
            `    ${written}\n\n` +
            `  Double-click it to start the app with no terminal. It launches\n` +
            `  whatever is currently built, so run \`npm run build\` after pulling\n` +
            `  changes — the shortcut will not do that for you.\n\n`,
        );
      }
      settle(status ?? 0);
    });
  });

  process.exitCode = code;
}

// Only when run as a command — importing this module, as the test does, must
// not write a shortcut to the desktop of whoever is running the suite.
if (isMain(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stdout.write(`\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  });
}
