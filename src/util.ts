import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

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
 * Stable content hash used to spot local edits made after a Jira push.
 * Only fields that would be pushed are included — changing a local-only field
 * like `cadence` should not mark an item as drifted.
 */
export function contentHash(input: Record<string, unknown>): string {
  const canonical = JSON.stringify(input, Object.keys(input).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Write via a temp file in the same directory, then rename. Rename is atomic on
 * POSIX, so an external Claude reading the vault mid-write sees either the old
 * file or the new one, never a half-written one.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, contents, "utf8");
    await fs.rename(tmp, filePath);
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
