/**
 * Pull, reinstall, rebuild core.
 *
 *   npm run update
 *
 * This exists for one reason: `npm install` treats `package-lock.json` as an
 * output as well as an input. `node_modules` is one directory shared by every
 * branch, so checking out a branch that moved a dependency leaves the newer
 * copy installed while the lockfile on disk reverts — and the next
 * `npm install` keeps what is installed, since it still satisfies the range
 * `package.json` declares, and writes it back into the lockfile. Nothing of
 * the user's is in that edit. But `git pull --ff-only` will not overwrite a
 * modified file, so it aborts, and the update that made the mess is the one
 * that cannot get past it.
 *
 * The fix is to notice that specific state and discard the lockfile before
 * pulling. Deliberate dependency work looks different — a changed manifest, or
 * a staged lockfile — and gets a stop rather than a guess, because discarding
 * that would be discarding real work.
 *
 * `npm ci` would sidestep all of this by never writing the lockfile, and it is
 * not usable here. It deletes `node_modules` first, and the menu that runs
 * this is a tsx process living inside `node_modules` with an esbuild service
 * running out of it. Windows refuses to unlink a running executable, so the
 * delete fails partway through — taking tsx with it and leaving no menu.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";

import { REPO_ROOT, dim, isMain, npmCli, red, yellow } from "./shared.mjs";

/** One `git status --porcelain` line: index status, worktree status, path. */
export type StatusEntry = { index: string; worktree: string; path: string };

export type LockfileVerdict = "clean" | "restore" | "stop";

/**
 * Decides what to do about `package-lock.json` before pulling.
 *
 * `restore` is reserved for the one case that is unambiguously not the user's
 * work: the lockfile modified in the worktree, unstaged, with every manifest
 * in the repo untouched. That combination is what an install leaves behind and
 * is not something a person produces on purpose.
 *
 * A staged lockfile is somebody part-way through committing one, and a dirty
 * `package.json` alongside it is a dependency actually being changed. Both
 * stop, so the pull's own refusal is explained rather than worked around.
 */
export function classifyLockfile(entries: StatusEntry[]): LockfileVerdict {
  const lock = entries.find((e) => e.path === "package-lock.json");
  if (!lock) return "clean";
  if (lock.index !== " ") return "stop";
  // Any workspace manifest counts, not just the root one: a dependency added
  // to apps/desktop moves the single lockfile at the top of the tree.
  if (entries.some((e) => e.path === "package.json" || e.path.endsWith("/package.json"))) {
    return "stop";
  }
  return "restore";
}

/**
 * Parses `git status --porcelain` (v1) output.
 *
 * Renames arrive as `R  old -> new`; the new path is the one that exists, so
 * that is the one kept. Quoted paths — non-ASCII, spaces — are left as git
 * printed them, which is harmless because every path this asks about is
 * plain ASCII and would never be quoted.
 */
export function parseStatus(stdout: string): StatusEntry[] {
  return stdout
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(" -> ");
      return {
        index: line[0] ?? " ",
        worktree: line[1] ?? " ",
        path: arrow === -1 ? rest : rest.slice(arrow + 4),
      };
    });
}

function run(command: string, args: string[]): number {
  process.stdout.write(dim(`\n$ ${command} ${args.join(" ")}\n`));
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/**
 * See `npmCli` in ./shared.mts for why npm goes through `process.execPath`.
 *
 * The fallback here is the shim after all — `npm.cmd` on Windows — and that is
 * deliberate rather than an oversight. It only runs when npm's own entry point
 * could not be found, at which point a shim that might work beats refusing to
 * update at all; every argument this passes is a bare word, so the quoting
 * problem the rule exists to avoid cannot arise.
 */
function runNpm(args: string[]): number {
  const cli = npmCli();
  return cli
    ? run(process.execPath, [cli, ...args])
    : run(process.platform === "win32" ? "npm.cmd" : "npm", args);
}

function main(): number {
  const status = spawnSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (status.status !== 0) {
    process.stdout.write(red("\ngit status failed; not attempting an update.\n"));
    return status.status ?? 1;
  }

  const verdict = classifyLockfile(parseStatus(status.stdout));

  if (verdict === "stop") {
    process.stdout.write(
      yellow("\npackage-lock.json is modified alongside a manifest, or staged.\n") +
        "That looks like a dependency change of yours rather than install\n" +
        "churn, so it is left alone — commit or stash it, then update again.\n",
    );
    return 1;
  }

  if (verdict === "restore") {
    process.stdout.write(
      yellow("\npackage-lock.json was modified by an earlier install\n") +
        "and nothing of yours is in it — discarding, the pull\n" +
        "brings the authoritative copy.\n",
    );
    const code = run("git", ["restore", "--", "package-lock.json"]);
    if (code !== 0) return code;
  }

  const pull = run("git", ["pull", "--ff-only"]);
  if (pull !== 0) return pull;

  const install = runNpm(["install"]);
  if (install !== 0) return install;

  return runNpm(["run", "build", "-w", "todo-vault"]);
}

// Only when run as a command; the tests import the two pure functions above.
if (isMain(import.meta.url)) process.exitCode = main();
