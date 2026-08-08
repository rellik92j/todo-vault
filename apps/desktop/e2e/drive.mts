/**
 * Small helpers the spec builds on: polling assertions, and the two-layer
 * DOM/disk reads the spec makes throughout.
 *
 * Auto-waiting lives in `playwright-core` itself and needs nothing here —
 * every action retries actionability, and every read that resolves an element
 * waits for it. What is *not* covered is a read that answers about right now
 * (`count()`, `isVisible()`, …), and "the comment list grew by one" is only
 * true a React render after the IPC round trip. `eventually` and `stays` close
 * that gap; everything else in this suite's assertions is Playwright's own.
 */
import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { Vault } from "todo-vault";

export interface EventuallyOptions {
  timeout?: number;
  interval?: number;
}

/**
 * Polls `read()` until `holds()` accepts its value, or fails with the LAST
 * VALUE SEEN — not just "timed out" — since that value is what makes a
 * failure here actionable rather than a shrug.
 */
export async function eventually<T>(
  what: string,
  read: () => Promise<T> | T,
  holds: (value: T) => boolean,
  { timeout = 10_000, interval = 100 }: EventuallyOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: T;
  for (;;) {
    last = await read();
    if (holds(last)) return last;
    if (Date.now() >= deadline) {
      throw new Error(`${what}: timed out after ${timeout}ms, last value seen: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Asserts a reading does not move for a stretch of wall-clock time.
 *
 * Never valid without a positive control alongside it — a negative assertion
 * that never fires is satisfied just as happily by a broken app as a working
 * one. Every caller in this suite pairs a `stays()` with a check elsewhere
 * that the same action would show up if it happened.
 */
export async function stays<T>(
  what: string,
  read: () => Promise<T> | T,
  expected: T,
  { forMs = 1_500, interval = 100 }: { forMs?: number; interval?: number } = {},
): Promise<void> {
  const deadline = Date.now() + forMs;
  while (Date.now() < deadline) {
    const value = await read();
    assert.deepEqual(value, expected, `${what}: expected to stay ${JSON.stringify(expected)}, saw ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// ------------------------------------------------------------- the disk layer

/**
 * Resolves a summary to its vault-assigned key. Keys are never hardcoded —
 * this repo assigns them at creation time, not the caller.
 */
export async function findItemKey(vaultRoot: string, summary: string): Promise<string> {
  const vault = await Vault.open(vaultRoot);
  const { items } = vault.listItems({});
  const matches = items.filter((item) => item.summary === summary);
  assert.equal(
    matches.length,
    1,
    `expected exactly one item summarised ${JSON.stringify(summary)}, found ${matches.length}`,
  );
  return matches[0].key;
}

/**
 * The comments on `key`, read fresh from disk. Re-opens the vault on every
 * call rather than caching one instance — `listItems`/`getItem` read a
 * snapshot loaded at `open()`, and the whole point of this helper is to see
 * what the app's own writes actually landed as.
 */
export async function readComments(
  vaultRoot: string,
  key: string,
): Promise<ReadonlyArray<{ author: string; at: string; body: string }>> {
  const vault = await Vault.open(vaultRoot);
  return vault.getItem(key).comments;
}

// --------------------------------------------------------------- the DOM layer

/** `:text-is()`, not `hasText` — "ACME-1" is a substring of "ACME-10". */
export function itemRow(page: Page, key: string): Locator {
  return page.locator(`table.table tbody tr:has(td.cell-key:text-is(${JSON.stringify(key)}))`);
}

export async function openItem(page: Page, key: string): Promise<void> {
  await itemRow(page, key).click();
  await page
    .locator(`aside.detail .detail-head .cell-key:text-is(${JSON.stringify(key)})`)
    .waitFor({ state: "visible" });
}

/** The `form.comment-form` panel, scoped so `.rich-surface` is unambiguous. */
export function commentForm(page: Page): Locator {
  return page.locator("form.comment-form");
}

export function commentEditorSurface(page: Page): Locator {
  return commentForm(page).locator("div.description.prose.rich-surface[contenteditable]");
}
