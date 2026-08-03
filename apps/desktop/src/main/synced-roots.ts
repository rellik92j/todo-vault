import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Where OneDrive syncs on this machine.
 *
 * This is the Windows-shaped, per-user knowledge that `packages/core`
 * deliberately does not have: the core takes the answer as
 * `VaultOptions.syncedRoots` and only ever asks "is this path under one of
 * these". Everything platform-specific lives here.
 *
 * The two sources disagree in useful ways, so both are read:
 *
 * - **Environment variables** are what OneDrive itself sets for the logged-in
 *   session. Cheap, synchronous, and correct when they are present — but a
 *   process launched before OneDrive first ran, or from a service, may not see
 *   them.
 * - **The registry** (`HKCU\Software\Microsoft\OneDrive\Accounts\*\UserFolder`)
 *   is the durable record, one key per signed-in account, and is the only
 *   place a second account reliably shows up.
 *
 * Neither is authoritative alone, so the union is used. A root that no longer
 * exists on disk is dropped, because a stale registry entry pointing at an
 * unlinked account would otherwise refuse copies from a folder that is now an
 * ordinary directory.
 */

/** The variables OneDrive sets. `OneDrive` duplicates whichever is primary. */
const ENV_KEYS = ["OneDrive", "OneDriveCommercial", "OneDriveConsumer"] as const;

/**
 * Pure so it can be tested without a machine that has OneDrive installed.
 * Exported for that reason alone.
 */
export function syncedRootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return dedupe(ENV_KEYS.map((key) => env[key]).filter((v): v is string => !!v && !!v.trim()));
}

/**
 * Pull `UserFolder` values out of `reg query … /s`.
 *
 * The output is loosely structured — blank lines, key headers, then
 * `    UserFolder    REG_SZ    C:\Users\sam\OneDrive - Contoso` — and the path
 * itself can contain the same run of spaces the columns are separated by, so
 * the split is on the type token rather than on whitespace.
 */
export function parseUserFolders(regOutput: string): string[] {
  const found: string[] = [];
  for (const line of regOutput.split(/\r?\n/)) {
    const match = /^\s*UserFolder\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/i.exec(line);
    if (match?.[1]) found.push(match[1]);
  }
  return dedupe(found);
}

/** Every OneDrive root this machine knows about, filtered to ones that exist. */
export async function discoverSyncedRoots(env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const candidates = [...syncedRootsFromEnv(env), ...(await registryRoots())];
  const existing: string[] = [];
  for (const root of dedupe(candidates)) {
    if (await isDirectory(root)) existing.push(root);
  }
  return existing;
}

async function registryRoots(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\OneDrive\\Accounts", "/s", "/v", "UserFolder"],
      { windowsHide: true },
    );
    return parseUserFolders(stdout);
  } catch {
    // `reg` exits non-zero when the key is absent, which is simply "OneDrive
    // has never signed in here" — not a condition worth surfacing.
    return [];
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Case-insensitively, since the two sources disagree on casing. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = path.resolve(value).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
