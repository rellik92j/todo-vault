import assert from "node:assert/strict";
import test from "node:test";

import type { Item } from "todo-vault";
import { backlogOrder } from "../src/renderer/src/ordering.js";

/**
 * Enough of an Item to order. `backlogOrder` reads `key` and `parent` and
 * nothing else, so the rest is filler rather than a fixture worth maintaining.
 */
function item(key: string, parent?: string): Item {
  return {
    key,
    parent,
    project: "ACME",
    type: "task",
    summary: key,
    description: "",
    status: "todo",
    priority: "medium",
    labels: [],
    links: [],
    attachments: [],
    comments: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
  } as unknown as Item;
}

/** The tree used throughout: E1 > T1 > S1, plus a childless T2 under E1. */
const tree = [item("E1"), item("T1", "E1"), item("S1", "T1"), item("T2", "E1")];

const keys = (rows: ReturnType<typeof backlogOrder>): string[] =>
  rows.map(({ item: i }) => i.key);

test("nests children under their parent, depth-first", () => {
  const rows = backlogOrder(tree);
  assert.deepEqual(keys(rows), ["E1", "T1", "S1", "T2"]);
  assert.deepEqual(
    rows.map(({ depth }) => depth),
    [0, 1, 2, 1],
  );
});

test("reports which rows have something to collapse", () => {
  assert.deepEqual(
    backlogOrder(tree).map(({ item: i, hasChildren }) => [i.key, hasChildren]),
    [
      ["E1", true],
      ["T1", true],
      ["S1", false],
      ["T2", false],
    ],
  );
});

test("a collapsed key hides its whole subtree, not just its children", () => {
  assert.deepEqual(keys(backlogOrder(tree, new Set(["E1"]))), ["E1"]);
  assert.deepEqual(keys(backlogOrder(tree, new Set(["T1"]))), ["E1", "T1", "T2"]);
});

test("a collapsed row still reports hasChildren, so it can be reopened", () => {
  const [root] = backlogOrder(tree, new Set(["E1"]));
  assert.equal(root.hasChildren, true);
});

/**
 * The rule the whole design turns on. `backlogOrder` promotes a child to a root
 * when its parent is absent, precisely so nothing vanishes silently; a collapsed
 * key that the filter dropped must not reach through and hide its children
 * anyway. Collapse hides the children of a *visible* parent, and only that.
 */
test("a collapsed key that the filter dropped hides nothing", () => {
  const withoutEpic = [item("T1", "E1"), item("S1", "T1"), item("T2", "E1")];
  assert.deepEqual(keys(backlogOrder(withoutEpic, new Set(["E1"]))), ["T1", "S1", "T2"]);
});

test("keys of items that are gone are inert", () => {
  assert.deepEqual(keys(backlogOrder(tree, new Set(["NOPE-1"]))), ["E1", "T1", "S1", "T2"]);
});

test("no collapsed set at all is the old behaviour", () => {
  assert.deepEqual(keys(backlogOrder(tree)), keys(backlogOrder(tree, new Set())));
});
