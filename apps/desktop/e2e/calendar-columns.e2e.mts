/**
 * Proves the month grid's seven columns are always seven equal columns —
 * `index.css:907`'s `grid-template-columns: repeat(7, minmax(0, 1fr))`, and the
 * bug it replaces: `1fr` alone is shorthand for `minmax(auto, 1fr)`, so a
 * `white-space: nowrap` chip's un-truncated width was setting its track's
 * minimum before the `fr` units ever divided the remaining space. See
 * `plans/PLAN-calendar-columns-are-seven-equal-tracks.md` for the full
 * reasoning.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`), following
 * `comment-editor.e2e.mts`'s shape: each check builds on the window state the
 * one before it left.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import type { Page } from "playwright-core";
import { Vault } from "todo-vault";
import { todayIso } from "todo-vault/recurrence";

import { ARTIFACTS_DIR, launchHarness, type Harness } from "./harness.mjs";
import { findItemKey } from "./drive.mjs";

/** Two days out, clamped to the current month so it can never spill into the next one. */
function dueDateInVisibleMonth(): string {
  const today = todayIso();
  const [year, month, day] = today.split("-").map(Number);
  const daysInMonth = new Date(year, month, 0).getDate();
  const targetDay = Math.min(day + 2, daysInMonth);
  return `${today.slice(0, 7)}-${String(targetDay).padStart(2, "0")}`;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function dayBoxes(page: Page): Promise<Box[]> {
  const days = page.locator(".cal-day");
  const count = await days.count();
  const boxes: Box[] = [];
  for (let i = 0; i < Math.min(count, 7); i++) {
    const box = await days.nth(i).boundingBox();
    assert.ok(box, `expected .cal-day #${i} to be measurable`);
    boxes.push(box!);
  }
  return boxes;
}

async function weekdayBoxes(page: Page): Promise<Box[]> {
  const heads = page.locator(".cal-weekday");
  const count = await heads.count();
  const boxes: Box[] = [];
  for (let i = 0; i < count; i++) {
    const box = await heads.nth(i).boundingBox();
    assert.ok(box, `expected .cal-weekday #${i} to be measurable`);
    boxes.push(box!);
  }
  return boxes;
}

function assertAllEqual(widths: number[], what: string): void {
  const first = widths[0];
  for (const [i, w] of widths.entries()) {
    assert.ok(
      Math.abs(w - first) <= 1,
      `${what}: column ${i} is ${w}px, column 0 is ${first}px — expected within 1px`,
    );
  }
}

describe("the calendar's seven columns are always seven equal tracks", { concurrency: 1 }, () => {
  let harness: Harness;

  before(async () => {
    harness = await launchHarness();

    // "Revenue widget double-counts refunds" is in_progress, in a live
    // (unhidden) project, and already due soon — a deliberately long summary
    // due inside the visible month means the check does not depend on which
    // seeded summary happens to be longest.
    const key = await findItemKey(harness.vaultRoot, "Revenue widget double-counts refunds");
    const vault = await Vault.open(harness.vaultRoot);
    await vault.updateItem(key, {
      summary: "A summary long enough that no sane calendar column could contain it",
      dueDate: dueDateInVisibleMonth(),
    });

    await harness.page.getByRole("tab", { name: "Calendar" }).click();
    // The app watches items/ with chokidar and pushes the update over IPC —
    // wait for the renamed chip to arrive rather than reloading.
    await harness.page
      .locator(".cal-chip", { hasText: "A summary long enough" })
      .waitFor({ state: "visible", timeout: 10_000 });
  });

  after(async () => {
    await harness.close();
  });

  test("the positive control: at least one chip is genuinely truncated", async () => {
    // Unfalsifiable without this — seven equal columns is also what an empty
    // grid, a wrong selector, or the wrong view open would produce. This is
    // exactly the condition that would have widened a column before the fix.
    const overflowing = await harness.page
      .locator(".cal-chip")
      .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth + 1).length);
    assert.ok(overflowing > 0, "no chip is being truncated — this spec proves nothing");
  });

  test("the seven day columns are equal widths", async () => {
    const boxes = await dayBoxes(harness.page);
    assert.equal(boxes.length, 7);
    assertAllEqual(boxes.map((b) => b.width), "day column width");
  });

  test("the weekday header lines up with the day columns below it", async () => {
    const dayBoxesRow = await dayBoxes(harness.page);
    const headBoxes = await weekdayBoxes(harness.page);
    assert.equal(headBoxes.length, 7);
    for (const [i, head] of headBoxes.entries()) {
      assert.ok(
        Math.abs(head.x - dayBoxesRow[i].x) <= 1,
        `weekday header #${i} at x=${head.x}, day column #${i} at x=${dayBoxesRow[i].x} — expected within 1px`,
      );
    }
  });

  test("columns stay equal, and track the window, across a resize", async () => {
    await fs.mkdir(ARTIFACTS_DIR, { recursive: true });

    // Resizes, re-measures, and screenshots at one width before moving to the
    // next — an earlier version of this test set both sizes and screenshotted
    // both afterwards, so "calendar-1000.png" was silently captured at
    // whatever width the *last* setContentSize call had left the window at.
    const widthsAt = async (w: number, h: number): Promise<number[]> => {
      await harness.app.evaluate(
        ({ BrowserWindow }, size) => {
          BrowserWindow.getAllWindows()[0].setContentSize(size.w, size.h);
        },
        { w, h },
      );
      // setContentSize is synchronous on the main side but the renderer's
      // layout pass is not guaranteed to have run yet — settle briefly.
      await harness.page.waitForTimeout(150);
      const boxes = await dayBoxes(harness.page);
      assertAllEqual(
        boxes.map((b) => b.width),
        `day column width at ${w}x${h}`,
      );

      const overflow = await harness.page.evaluate(() => {
        const el = document.querySelector(".content");
        return el ? el.scrollWidth - el.clientWidth : 0;
      });
      assert.ok(overflow <= 1, `expected no horizontal overflow at ${w}x${h}, saw ${overflow}px`);

      await harness.page.screenshot({ path: path.join(ARTIFACTS_DIR, `calendar-${w}.png`) });

      return boxes.map((b) => b.width);
    };

    const narrow = await widthsAt(1000, 900);
    const wide = await widthsAt(1600, 900);

    const narrowSum = narrow.reduce((a, b) => a + b, 0);
    const wideSum = wide.reduce((a, b) => a + b, 0);
    assert.ok(
      wideSum > narrowSum,
      `expected the grid to widen with the window: ${narrowSum}px at 1000, ${wideSum}px at 1600`,
    );

    console.log(`wrote screenshots to ${ARTIFACTS_DIR}`);
  });
});
