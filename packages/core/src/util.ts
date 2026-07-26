import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export { randomUUID };

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return todayIso(d);
}

/** Monday-anchored start of the week containing `dateIso`. */
export function startOfWeek(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const offset = (d.getDay() + 6) % 7;
  return addDays(dateIso, -offset);
}

export function startOfMonth(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

export function endOfMonth(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00`);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return todayIso(last);
}

/**
 * Vault-relative paths are stored POSIX-style regardless of the OS that wrote
 * them, so a vault written on Windows still reads correctly on macOS and still
 * looks right to the external tools this design is built around.
 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/** Turn a stored vault-relative path back into a native one. */
export function fromPosixPath(p: string): string {
  return p.split("/").join(path.sep);
}

/**
 * Manual ordering uses sparse integers rather than fractional string keys.
 * A drag rewrites exactly one file, gaps only close after repeated insertions in
 * the same spot, and when one does close `Vault.moveItem` renumbers the project
 * — a few hundred instant writes. The string-key schemes exist for issue
 * trackers with millions of rows; the integers stay hand-editable.
 */
export const RANK_GAP = 1000;

/**
 * Midpoint between two ranks, or undefined when no integer is left between them
 * and the caller needs to renumber first.
 *
 * Named for rank space, not list order: the item *above* in a list has the
 * *lower* rank. Mixing those up is the classic reordering bug.
 */
export function rankBetween(lower?: number, upper?: number): number | undefined {
  if (lower === undefined && upper === undefined) return RANK_GAP;
  if (lower === undefined) return upper! > 0 ? Math.floor(upper! / 2) : undefined;
  if (upper === undefined) return lower + RANK_GAP;
  if (upper - lower < 2) return undefined;
  return lower + Math.floor((upper - lower) / 2);
}

/**
 * Stable content hash used to spot local edits made after a Jira push.
 * Only fields that would be pushed are included — changing a local-only field
 * like `cadence` should not mark an item as drifted.
 */
export function contentHash(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * True for the three codes a transient, Windows-style file lock produces:
 * `EPERM`, `EACCES`, `EBUSY`. `EPERM` is the awkward one — a scanner or search
 * indexer holding the target open reports the exact same code as a genuine
 * permissions failure, and nothing in the error tells them apart. This
 * predicate does not try; instead the retry it guards is kept short and always
 * rethrows on its last attempt, so a real permissions problem still comes back
 * as a failure, just a few milliseconds later rather than instantly.
 */
export function isTransientRenameError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

const RENAME_RETRY_DELAYS_MS = [10, 40];

/**
 * Three attempts total, ~10ms then ~40ms apart. A scanner or indexer's hold on
 * the file clears in milliseconds, so that is enough to ride out the transient
 * case. The backoff is deliberately short rather than exponential: `EPERM` also
 * covers a genuine permissions failure (see `isTransientRenameError`), and a
 * real one should still surface almost immediately instead of reading as a
 * hang while it is retried away.
 */
async function renameWithRetry(tmp: string, filePath: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      if (attempt >= RENAME_RETRY_DELAYS_MS.length || !isTransientRenameError(err)) throw err;
      await delay(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

/**
 * Write via a temp file in the same directory, then rename. Rename is atomic on
 * POSIX, so an external Claude reading the vault mid-write sees either the old
 * file or the new one, never a half-written one.
 *
 * The rename alone is wrapped in a short retry: on Windows an antivirus
 * scanner or search indexer can briefly hold the target file open, which fails
 * `fs.rename` with a transient error, and the desktop app's file watcher now
 * keeps a handle open on these files almost continuously, which makes that
 * window real rather than theoretical. `fs.writeFile` above is left alone —
 * it has no equivalent failure mode, and retrying it too could write the temp
 * file's contents twice for no benefit.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await renameWithRetry(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Turns a zod error into something a human or an agent can act on. */
export function formatZodError(err: unknown): string {
  if (typeof err === "object" && err !== null && "issues" in err) {
    const issues = (err as { issues: Array<{ path: (string | number)[]; message: string }> })
      .issues;
    return issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}
