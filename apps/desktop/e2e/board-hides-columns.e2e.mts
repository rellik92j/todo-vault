/**
 * Drives the board's filter-driven column set end to end — the part of
 * `plans/PLAN-board-hide-closed-columns.md` no unit test can reach, because it
 * is layout and a drag gesture rather than a pure function. `ordering.test.ts`
 * already proves `visibleBoardStatuses` picks the right statuses; this proves
 * the board actually draws them, and that the one thing the change puts at
 * risk — closing a card whose column got hidden — still works.
 *
 * One app, one vault, ordered subtests (`{ concurrency: 1 }`), following
 * `calendar-columns.e2e.mts`'s shape: each check builds on the toolbar state
 * the one before it left.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { Vault } from "todo-vault";

import { launchHarness, type Harness } from "./harness.mjs";
import { findItemKey } from "./drive.mjs";

describe("the board drops the columns its filters have emptied", { concurrency: 1 }, () => {
  let harness: Harness;

  before(async () => {
    harness = await launchHarness();
    await harness.page.getByRole("tab", { name: "Board" }).click();
    await harness.page.locator(".column").first().waitFor({ state: "visible" });
  });

  after(async () => {
    await harness.close();
  });

  test("the default board — Hide closed on, no status picked — shows four wide columns", async () => {
    const columns = harness.page.locator(".column");
    assert.equal(await columns.count(), 4);

    const heads = await harness.page.locator(".column-head").allInnerTexts();
    for (const label of ["Done", "Disregarded"]) {
      assert.ok(!heads.some((h) => h.includes(label)), `${label} should not be drawn: ${heads}`);
    }

    // At the harness's default 1360px window, four columns land around 264px —
    // well past the 172px six-column floor the change exists to get past.
    const box = await columns.first().boundingBox();
    assert.ok(box, "expected the first column to be measurable");
    assert.ok(box!.width > 220, `expected a widened column, got ${box!.width}px`);
  });

  test("unticking Hide closed brings the two closed columns back, holding their cards", async () => {
    await harness.page.getByRole("checkbox", { name: "Hide closed" }).click();
    await harness.page.locator(".column", { hasText: "Disregarded" }).waitFor({ state: "visible" });
    assert.equal(await harness.page.locator(".column").count(), 6);

    for (const label of ["Done", "Disregarded"]) {
      const column = harness.page.locator(".column").filter({
        has: harness.page.locator(".column-head", { hasText: label }),
      });
      const cards = await column.locator(".card").count();
      assert.ok(cards > 0, `expected ${label} to hold at least one seeded card`);
    }

    // Back to the default for the tests that follow.
    await harness.page.getByRole("checkbox", { name: "Hide closed" }).click();
    await harness.page.locator(".column").first().waitFor({ state: "visible" });
    assert.equal(await harness.page.locator(".column").count(), 4);
  });

  test("picking a single status narrows the board to that one column", async () => {
    const statusSelect = harness.page.locator('select:has(option:text-is("Any status"))');
    await statusSelect.selectOption({ label: "Blocked" });

    const columns = harness.page.locator(".column");
    await columns.first().waitFor({ state: "visible" });
    assert.equal(await columns.count(), 1);
    // .column-head is text-transform: uppercase, so the rendered text Playwright
    // reads back is "BLOCKED" — compare case-insensitively rather than assume
    // CSS off.
    const head = await harness.page.locator(".column-head").first().innerText();
    assert.ok(head.toLowerCase().includes("blocked"), head);
  });

  test("Hide closed plus a status of Done leaves an explicit empty state, not a blank board", async () => {
    const statusSelect = harness.page.locator('select:has(option:text-is("Any status"))');
    await statusSelect.selectOption({ label: "Done" });

    const empty = harness.page.locator(".board-empty");
    await empty.waitFor({ state: "visible" });
    assert.equal(await harness.page.locator(".column").count(), 0);
    const text = await empty.innerText();
    assert.match(text, /Hide closed/);
    assert.match(text, /Done/);

    // Back to the default for the drag test that follows.
    await statusSelect.selectOption({ label: "Any status" });
    await harness.page.locator(".column").first().waitFor({ state: "visible" });
  });

  test("dragging an in-progress card reveals a drop strip for its hidden columns, and closing it through Done removes it from the board", async () => {
    const key = await findItemKey(harness.vaultRoot, "Revenue widget double-counts refunds");
    const card = harness.page.locator('.card:has-text("Revenue widget double-counts refunds")');
    const cardBox = await card.boundingBox();
    assert.ok(cardBox, "expected the dragged card to be measurable");

    assert.equal(await harness.page.locator(".board-drop-strip").count(), 0);

    // A real pointer path, not a single jump straight to the target: dnd-kit's
    // PointerSensor only starts a drag once it has seen movement past its 5px
    // activation distance, and only a genuine mousemove — not a teleport —
    // reliably produces that.
    await harness.page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    await harness.page.mouse.down();
    await harness.page.mouse.move(
      cardBox!.x + cardBox!.width / 2,
      cardBox!.y + cardBox!.height / 2 + 40,
      { steps: 10 },
    );

    // The strip mounts its droppables mid-gesture, after dragging is set — the
    // one thing the plan flagged as needing to be checked rather than assumed.
    await harness.page.locator(".board-drop-strip").waitFor({ state: "visible", timeout: 5_000 });
    // .board-drop-zone is text-transform: uppercase too — same reasoning as the
    // .column-head check above.
    const zoneLabels = (await harness.page.locator(".board-drop-zone").allInnerTexts())
      .map((t) => t.trim().toLowerCase())
      .sort();
    assert.deepEqual(
      zoneLabels,
      ["disregarded", "done"],
      "in_progress can legally reach both hidden statuses",
    );

    const doneZone = harness.page.locator(".board-drop-zone", { hasText: "Done" });
    const doneBox = await doneZone.boundingBox();
    assert.ok(doneBox, "expected the Done drop zone to be measurable");
    await harness.page.mouse.move(doneBox!.x + doneBox!.width / 2, doneBox!.y + doneBox!.height / 2, {
      steps: 10,
    });
    await harness.page.mouse.up();

    await harness.page.locator(".board-drop-strip").waitFor({ state: "hidden" });
    // The transition is a real IPC round trip through the vault's git commit,
    // not a local state flip — 5s was flaky under load, 10s was not.
    await card.waitFor({ state: "hidden", timeout: 10_000 });

    const vault = await Vault.open(harness.vaultRoot);
    assert.equal(vault.getItem(key).status, "done");
  });
});
