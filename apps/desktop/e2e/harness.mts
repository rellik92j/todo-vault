/**
 * Launches the built desktop app against a throwaway vault and a throwaway
 * `--user-data-dir`, and tears both down afterwards.
 *
 * `.mts`, not `.ts`: this workspace has no `"type": "module"`, so tsx would
 * transpile a `.ts` file here to CJS, and `import { Vault } from "todo-vault"`
 * would become a `require()` of an ESM-only package — which only works on Node
 * >=22.12 while `engines` says `>=22`. `.mts` is unambiguously ESM regardless
 * of the package's own `type`, matching `scripts/*.mts` at the repo root.
 *
 * `playwright-core`'s `_electron` rather than `@playwright/test`: the
 * underscore is Playwright's long-standing convention for an experimental but
 * stable API, and `_electron` is the piece that matters here — everything
 * `@playwright/test` adds on top (its own CLI, its own config, its own runner)
 * is exactly what this repo does not want a second copy of. `tsx --test` stays
 * the one way to run a test in this repo.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "playwright-core";
import type { ElectronApplication, Page } from "playwright-core";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const DESKTOP_ROOT = path.join(REPO_ROOT, "apps", "desktop");
export const ARTIFACTS_DIR = path.join(DESKTOP_ROOT, "e2e", "artifacts");

const TEMP_PREFIX = "todo-vault-e2e-";
const STALE_AFTER_MS = 60 * 60 * 1000;

export interface Harness {
  app: ElectronApplication;
  page: Page;
  vaultRoot: string;
  /** This run's `--user-data-dir`, for reading back what the app persisted. */
  userDataDir: string;
  /** The temp stem holding both. Pass it back to relaunch against this state. */
  stem: string;
  /**
   * Closes the app (with a taskkill fallback) and removes the temp stem —
   * unless `keepStem`, which a relaunch test needs so the second launch can
   * read the settings.json the first one wrote.
   */
  close(options?: { keepStem?: boolean }): Promise<void>;
}

export interface LaunchOptions {
  /**
   * Merged over the default settings.json before launch, for seeding state the
   * app reads at boot — a theme, say. Never a substitute for driving the UI:
   * seed only what the test is not itself the check on.
   */
  settings?: Record<string, unknown>;
  /**
   * Relaunch against an earlier run's stem instead of building a fresh one.
   *
   * The vault is not reseeded and settings.json is not rewritten, because the
   * point of a relaunch is to read what the first run left behind. Pair it with
   * `close({ keepStem: true })` on the run before.
   */
  stem?: string;
  /**
   * Playwright's `prefers-color-scheme` emulation, which is **on by default and
   * set to `"light"`** — `electron.launch` documents that default, and it is
   * applied over CDP, above anything the app itself does. So a spec that drives
   * `nativeTheme.themeSource` sees Electron move and the page stay put unless it
   * passes `null` here, which resets to the system default.
   *
   * Left alone everywhere else on purpose. The default is what keeps
   * `comment-editor.e2e.mts`'s screenshots from depending on the OS theme of
   * whichever machine ran them, which is the argument written at its own call
   * to `emulateMedia`.
   */
  colorScheme?: null | "light" | "dark" | "no-preference";
}

/** Spawns a command with a real argv (never a shell) and waits for a clean exit. */
function run(command: string, args: string[], cwd: string = REPO_ROOT): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} was killed by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * `fs.rm`'s own retries never clear a Windows `EPERM` — git marks objects
 * under `.git` read-only, the same reason a Windows worktree refuses to
 * delete — so this falls back to `cmd /c rd /s /q`, which does not care.
 */
async function removeStubborn(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    return;
  } catch {
    // fall through to the OS-level removal below
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const child = spawn("cmd", ["/c", "rd", "/s", "/q", target], { stdio: "ignore" });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
  }
}

/**
 * Removes leftover temp stems from earlier runs before starting a new one.
 *
 * A crashed run on Windows can leave a leaked Electron process holding file
 * handles inside its stem, so cleanup here is the only cleanup that reliably
 * happens — not at the end of the run that left the mess. Only stems whose
 * mtime is over an hour old are touched, so a run genuinely in progress next
 * door is left alone. Every error is swallowed: a stale directory this sweep
 * cannot remove must not fail the run that follows it.
 */
async function sweepStaleSiblings(): Promise<void> {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = await fs.readdir(tmp);
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX)) continue;
    const full = path.join(tmp, entry);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs < STALE_AFTER_MS) continue;
      await removeStubborn(full);
    } catch {
      // best-effort; a sibling this sweep cannot touch is not this run's problem
    }
  }
}

/** Seeds the fixture vault by spawning `seed-vault.ts`, never by importing it. */
async function seedVault(vaultRoot: string): Promise<void> {
  // Not `npm run seed --`: that goes through the `npm.cmd` shim scripts/menu.mts
  // already routes around on Windows. `--import tsx` needs no `dist/` — the
  // script imports `../src/vault.js`, which tsx maps back to the `.ts` source.
  await run(process.execPath, [
    "--import",
    "tsx",
    path.join(REPO_ROOT, "packages", "core", "scripts", "seed-vault.ts"),
    vaultRoot,
  ]);
}

/**
 * `git init` plus a repo-local identity, not merely `git init`.
 *
 * `VaultService` always opens `{ git: true }`, and the core's auto-commit is
 * best-effort and never throws — so a vault with no git identity at all would
 * not fail, it would silently fail to commit on every write. That leaves
 * `gitStatus().healthy` false, which renders a `banner-info` in `App.tsx` that
 * shifts every screenshot down. A repo-local identity avoids depending on
 * whatever (if anything) is configured globally on the machine running this.
 */
async function initVaultGit(vaultRoot: string): Promise<void> {
  await run("git", ["init", "-q", vaultRoot]);
  await run("git", ["-C", vaultRoot, "config", "user.email", "e2e@example.invalid"]);
  await run("git", ["-C", vaultRoot, "config", "user.name", "e2e"]);
}

async function writeSettings(
  userDataDir: string,
  vaultRoot: string,
  extra: Record<string, unknown>,
): Promise<void> {
  // Same shape and formatting `writeSettings` in src/main/settings.ts produces.
  // zoomLevel is explicit, so screenshots come out the same size on every
  // machine rather than depending on whatever the default happens to be.
  // `extra` goes last so a test can seed a key the app reads at boot; nothing
  // in the default pair is worth letting it overwrite by accident, but a test
  // that does is being explicit about it.
  const settings = { vaultRoot, zoomLevel: 0, ...extra };
  await fs.writeFile(
    path.join(userDataDir, "settings.json"),
    `${JSON.stringify(settings, null, 2)}\n`,
    "utf8",
  );
}

export async function launchHarness(options: LaunchOptions = {}): Promise<Harness> {
  await sweepStaleSiblings();

  const relaunch = options.stem !== undefined;
  const stem = options.stem ?? (await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX)));
  const vaultRoot = path.join(stem, "vault");
  const userDataDir = path.join(stem, "userData");
  await fs.mkdir(userDataDir, { recursive: true });

  // Skipped wholesale on a relaunch: reseeding the vault would discard the
  // git history the first run wrote, and rewriting settings.json would erase
  // the very thing a relaunch exists to read back.
  if (!relaunch) {
    await seedVault(vaultRoot);
    await initVaultGit(vaultRoot);
    await writeSettings(userDataDir, vaultRoot, options.settings ?? {});
  }

  // The package's Node-side export *is* the binary path. Not a hardcoded
  // `dist/electron.exe`: this survives a hoisting change, and `ensure-electron`
  // (desktop's `predev`/`prebuild`) has already guaranteed the binary exists.
  const executablePath = createRequire(import.meta.url)("electron") as unknown as string;

  // A dev server leaking in here would test an unbuilt renderer against a
  // built main process — a mismatch nothing else in this harness would catch.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "ELECTRON_RENDERER_URL") env[key] = value;
  }

  const app = await electron.launch({
    executablePath,
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`],
    cwd: DESKTOP_ROOT,
    env,
    timeout: 60_000,
    // Spread rather than passed straight through, so leaving the option unset
    // keeps Playwright's own default rather than overwriting it with undefined.
    ...("colorScheme" in options ? { colorScheme: options.colorScheme } : {}),
  });

  const electronProcess = app.process();
  electronProcess.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[electron] ${chunk.toString()}`);
  });

  // The guard that matters more than any assertion in any spec. If
  // `--user-data-dir` were ever ignored, the app would read the real
  // settings.json, open whatever vault this machine last used, and every write
  // this suite makes would land in it — not a flake, but damage. Checked
  // against the process's own answer, not the string passed in.
  const seenUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  assert.equal(path.resolve(seenUserData), path.resolve(userDataDir));
  assert.ok(
    path.resolve(userDataDir).startsWith(path.resolve(os.tmpdir())),
    "userDataDir must live under the OS temp directory",
  );

  const page = await app.firstWindow();
  page.on("console", (msg) => {
    process.stdout.write(`[renderer:${msg.type()}] ${msg.text()}\n`);
  });
  page.on("pageerror", (err) => {
    process.stderr.write(`[renderer:pageerror] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  });

  // firstWindow() resolves before ready-to-show, and well before the snapshot
  // arrives over IPC — so wait for the vault, not the window. Two failures that
  // both look like slowness, told apart on purpose: the placard means
  // window.vault never arrived (a preload/sandbox problem); a stuck Welcome
  // screen means settings.json was never read (a --user-data-dir problem).
  assert.equal(await page.locator("text=This is the renderer, not the app").count(), 0);
  await page.locator("table.table tbody tr").first().waitFor({ state: "visible", timeout: 20_000 });

  const close = async (closeOptions: { keepStem?: boolean } = {}): Promise<void> => {
    const pid = electronProcess.pid;
    const stillAlive = (): boolean => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    // Ask, with a timeout: an earlier driving run recorded app.close() not
    // killing the instance, leaving two briefly live at once.
    await Promise.race([
      app.close().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ]);

    // Then insist, if it is still alive. /T because the GPU and utility
    // processes are children and would otherwise keep userDataDir open.
    if (stillAlive() && pid && process.platform === "win32") {
      await new Promise<void>((resolve) => {
        const child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        child.on("exit", () => resolve());
        child.on("error", () => resolve());
      });
    }

    // The stem is left behind only when a relaunch is coming for it. It still
    // lives under the OS temp directory, and sweepStaleSiblings collects it an
    // hour later even if the run that asked for it never came back.
    if (!closeOptions.keepStem) await removeStubborn(stem);
  };

  return { app, page, vaultRoot, userDataDir, stem, close };
}
