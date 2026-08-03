import path from "node:path";

/**
 * Which paths belong to a synced folder.
 *
 * Pure — no filesystem, no registry, no environment. That is deliberate:
 * knowing *where* OneDrive syncs on this machine is Windows-shaped and
 * per-user (env vars, `HKCU:\Software\Microsoft\OneDrive`), so the desktop
 * main process discovers the roots and hands them in as
 * `VaultOptions.syncedRoots`. The core only ever answers "is this path under
 * one of the roots you gave me", which is testable without a machine that has
 * OneDrive installed at all.
 *
 * The string-only half of the feature — deciding whether a *URL* looks like
 * OneDrive — lives in `link-target.ts`, which imports nothing, so the
 * sandboxed renderer can use it too.
 */

/**
 * The synced root containing `abs`, or `undefined`.
 *
 * Returns the root rather than a boolean so callers can name it in a message —
 * "this is in your OneDrive folder" is only useful if it says which one.
 *
 * Comparison is case-insensitive on every platform. `syncedRoots` is opt-in and
 * only the desktop app on Windows populates it today, so the case-sensitive-
 * filesystem mismatch is theoretical; and if it ever bites, it bites by
 * classifying a path as synced when it is not, whose consequence is a refusal
 * with a message and an obvious alternative rather than a silently duplicated
 * file.
 */
export function syncedRootFor(abs: string, roots: readonly string[]): string | undefined {
  const target = normalize(abs);
  if (!target) return undefined;

  for (const root of roots) {
    const normalized = normalize(root);
    // A root of "" would match every path — a missing env var read as a root
    // must not quietly disable copying altogether.
    if (!normalized) continue;
    if (target === normalized) return root;
    // The separator matters: without it, root `…\OneDrive` also swallows the
    // sibling directory `…\OneDrive - Contoso`.
    if (target.startsWith(normalized + path.sep)) return root;
  }
  return undefined;
}

export function isSyncedPath(abs: string, roots: readonly string[]): boolean {
  return syncedRootFor(abs, roots) !== undefined;
}

/** Resolve, strip any trailing separator, and case-fold, so comparisons line up. */
function normalize(p: string): string {
  if (!p.trim()) return "";
  const resolved = path.resolve(p);
  const trimmed =
    resolved.length > 1 && resolved.endsWith(path.sep) ? resolved.slice(0, -1) : resolved;
  return trimmed.toLowerCase();
}
