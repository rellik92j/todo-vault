import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "todo-vault";
import { monthGrid, stepMonth } from "../src/renderer/src/calendar.js";

const TODAY = "2026-08-10";

/** Enough of an Item to place on the grid and order within a day. */
function item(key: string, dueDate?: string, priority = "medium"): Item {
  return {
    key,
    project: "ACME",
    type: "task",
    summary: key,
    description: "",
    status: "todo",
    priority,
    dueDate,
    labels: [],
    links: [],
    attachments: [],
    comments: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  } as unknown as Item;
}

test("a month starting on a Saturday leads with six days from the previous month", () => {
  // Aug 1 2026 is a Saturday.
  const grid = monthGrid("2026-08", [], TODAY);
  const leading = grid.filter((d) => !d.inMonth && d.date < "2026-08-01");
  assert.equal(leading.length, 6);
  assert.deepEqual(
    leading.map((d) => d.date),
    ["2026-07-26", "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31"],
  );
});

test("a month starting on a Sunday leads with nothing", () => {
  // Feb 1 2026 is a Sunday.
  const grid = monthGrid("2026-02", [], TODAY);
  assert.equal(grid[0].date, "2026-02-01");
  assert.equal(grid[0].inMonth, true);
});

test("every returned day is contiguous, and the count is a multiple of 7", () => {
  const grid = monthGrid("2026-08", [], TODAY);
  assert.equal(grid.length % 7, 0);
  for (let i = 1; i < grid.length; i += 1) {
    const prev = new Date(`${grid[i - 1].date}T00:00:00`);
    prev.setDate(prev.getDate() + 1);
    const expected = prev.toISOString().slice(0, 10);
    assert.equal(grid[i].date, expected);
  }
});

test("inMonth is false for exactly the leading and trailing days", () => {
  const grid = monthGrid("2026-08", [], TODAY);
  for (const day of grid) {
    assert.equal(day.inMonth, day.date.slice(0, 7) === "2026-08");
  }
  // August 2026 has both: Aug 1 is a Saturday and Aug 31 is a Monday, so the
  // grid also trails into the first week of September.
  assert.equal(grid[0].inMonth, false);
  assert.equal(grid.at(-1)?.inMonth, false);
});

test("an item lands in the cell matching its due date, leading cells included", () => {
  const items = [item("A1", "2026-08-05"), item("A2", "2026-07-31")];
  const grid = monthGrid("2026-08", items, TODAY);

  const aug5 = grid.find((d) => d.date === "2026-08-05");
  assert.deepEqual(
    aug5?.items.map((i) => i.key),
    ["A1"],
  );

  const jul31 = grid.find((d) => d.date === "2026-07-31");
  assert.equal(jul31?.inMonth, false);
  assert.deepEqual(
    jul31?.items.map((i) => i.key),
    ["A2"],
  );
});

test("an item with no due date appears nowhere", () => {
  const items = [item("A1")];
  const grid = monthGrid("2026-08", items, TODAY);
  assert.equal(
    grid.reduce((n, d) => n + d.items.length, 0),
    0,
  );
});

test("two items on one day come back highest-priority first, ties broken by key", () => {
  const items = [
    item("A2", "2026-08-05", "low"),
    item("A1", "2026-08-05", "highest"),
    item("A10", "2026-08-05", "highest"),
    item("A3", "2026-08-05", "highest"),
  ];
  const grid = monthGrid("2026-08", items, TODAY);
  const day = grid.find((d) => d.date === "2026-08-05");
  assert.deepEqual(
    day?.items.map((i) => i.key),
    ["A1", "A3", "A10", "A2"],
  );
});

test("today's cell is flagged, and only that one", () => {
  const grid = monthGrid("2026-08", [], TODAY);
  const todays = grid.filter((d) => d.isToday);
  assert.deepEqual(
    todays.map((d) => d.date),
    [TODAY],
  );
});

test("stepMonth crosses both year boundaries", () => {
  assert.equal(stepMonth("2026-01", -1), "2025-12");
  assert.equal(stepMonth("2026-12", 1), "2027-01");
});

test("stepMonth round-trips January to December and back", () => {
  const back = stepMonth("2026-01", -1);
  assert.equal(stepMonth(back, 1), "2026-01");
});

test("flattening the grid reproduces the priority/key order within each day", () => {
  const items = [item("A2", "2026-08-05", "low"), item("A1", "2026-08-05", "highest")];
  const grid = monthGrid("2026-08", items, TODAY);
  const flat = grid.flatMap((d) => d.items.map((i) => i.key));
  assert.deepEqual(flat, ["A1", "A2"]);
});
