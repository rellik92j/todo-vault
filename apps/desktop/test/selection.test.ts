import assert from "node:assert/strict";
import test from "node:test";

import type { Item, Status } from "todo-vault";
import { commonTransitions, rangeBetween } from "../src/renderer/src/selection.js";

/** Enough of an Item for these two functions: `status` and nothing else. */
function item(key: string, status: Status = "todo"): Item {
  return {
    key,
    project: "ACME",
    type: "task",
    summary: key,
    description: "",
    status,
    priority: "medium",
    labels: [],
    links: [],
    attachments: [],
    comments: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  } as unknown as Item;
}

const order = ["ACME-1", "ACME-2", "ACME-3", "ACME-4", "ACME-5"];

test("rangeBetween returns the inclusive span in view order, in both directions", () => {
  assert.deepEqual(rangeBetween(order, "ACME-2", "ACME-4"), ["ACME-2", "ACME-3", "ACME-4"]);
  assert.deepEqual(
    rangeBetween(order, "ACME-4", "ACME-2"),
    ["ACME-2", "ACME-3", "ACME-4"],
    "shift-clicking upward returns the same span, not a reversed one",
  );
});

test("rangeBetween returns a single key when anchor and target match", () => {
  assert.deepEqual(rangeBetween(order, "ACME-3", "ACME-3"), ["ACME-3"]);
});

test("rangeBetween falls back to the clicked key alone when the anchor is no longer visible", () => {
  assert.deepEqual(rangeBetween(order, "gone", "ACME-3"), ["ACME-3"]);
});

test("rangeBetween returns nothing for a target that is not in view", () => {
  assert.deepEqual(rangeBetween(order, "ACME-2", "gone"), []);
});

test("commonTransitions intersects correctly, and is empty for an incompatible pair", () => {
  // todo -> blocked, in_progress -> blocked: both legal.
  assert.deepEqual(
    commonTransitions([item("A", "todo"), item("B", "in_progress")]).includes("blocked"),
    true,
  );

  // todo cannot reach in_review directly, so a todo/in_review pair has nothing in common there.
  const incompatible = commonTransitions([item("A", "todo"), item("B", "in_review")]);
  assert.equal(incompatible.includes("in_review"), false);
});

test("commonTransitions does not drop a status some item is already in", () => {
  // One item already done, one still todo: both can legally end up at "done"
  // (todo -> done is allowed, done -> done is a no-op transition), so "done"
  // must survive the intersection even though it is not in TRANSITIONS.done.
  const result = commonTransitions([item("A", "done"), item("B", "todo")]);
  assert.equal(result.includes("done"), true);
});

test("commonTransitions is empty for an empty selection", () => {
  assert.deepEqual(commonTransitions([]), []);
});
