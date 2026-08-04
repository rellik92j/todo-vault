import assert from "node:assert/strict";
import test from "node:test";

import type { Item, Status } from "todo-vault";
import {
  backlogOrder,
  boardColumns,
  boardLanes,
  groupIntoBands,
} from "../src/renderer/src/ordering.js";

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

/** The three fields the board actually orders on, over the same filler. */
function card(key: string, project: string, status: Status, rank?: number): Item {
  return { ...item(key), project, status, rank } as unknown as Item;
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

/**
 * What the type filter does to the tree, asserted so it reads as a decision
 * rather than as a bug someone finds later.
 *
 * Filtering to a type that is not at the top drops the parents that place the
 * matches, and the promotion rule above then makes those matches roots — the
 * tree flattens. Nothing is lost, which is the point, but the hierarchy goes at
 * the moment someone narrowed the view. It is allowed to: "Hide closed" already
 * does exactly this to the children of a done epic, and the two type filters
 * actually worth asking for do not hit it at all — epics have no parents to
 * lose, and subtasks are leaves, so excluding them prunes without flattening.
 */
test("filtering to one type flattens the tree rather than hiding matches", () => {
  const tasksOnly = [item("T1", "E1"), item("T2", "E1")];
  const rows = backlogOrder(tasksOnly);
  assert.deepEqual(keys(rows), ["T1", "T2"]);
  assert.deepEqual(
    rows.map(({ depth }) => depth),
    [0, 0],
  );
});

test("excluding a leaf type leaves the tree standing", () => {
  const withoutSubtasks = tree.filter(({ key }) => key !== "S1");
  const rows = backlogOrder(withoutSubtasks);
  assert.deepEqual(keys(rows), ["E1", "T1", "T2"]);
  assert.deepEqual(
    rows.map(({ depth }) => depth),
    [0, 1, 1],
  );
});

// ------------------------------------------------------------------ the board

/**
 * Two projects with work in two statuses, and a third project in the sidebar
 * with nothing in it — which is what makes the empty-lane rule testable.
 */
const order = ["WEB", "API", "OPS"];
const board = [
  card("W1", "WEB", "todo", 1000),
  card("W2", "WEB", "in_progress", 1000),
  card("A1", "API", "todo", 1000),
  card("A2", "API", "todo", 2000),
];

/** Exactly what `orderedKeys` in App.tsx builds for the keyboard cursor. */
const laneKeys = (lanes: ReturnType<typeof boardLanes>): string[] =>
  lanes.flatMap((lane) => lane.columns.flatMap((c) => c.items.map((i) => i.key)));

test("ungrouped is one lane holding exactly the columns the board already drew", () => {
  const lanes = boardLanes(board, order, false);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].project, null);
  assert.deepEqual(lanes[0].columns, boardColumns(board, order));
});

test("grouped emits a lane per project in sidebar order, skipping the empty ones", () => {
  assert.deepEqual(
    boardLanes(board, order, true).map((l) => l.project),
    ["WEB", "API"],
  );
});

/**
 * Lane order comes from the sidebar, not from where the items happen to sit in the
 * array — which is what makes dragging a project in the sidebar reorder the bands.
 */
test("lane order follows the sidebar, not the item order", () => {
  assert.deepEqual(
    boardLanes(board, ["API", "WEB", "OPS"], true).map((l) => l.project),
    ["API", "WEB"],
  );
});

/**
 * The trailing lanes are sorted rather than left in map-insertion order, so the
 * board does not reshuffle between two renders of the same vault.
 */
test("unknown projects are ordered deterministically among themselves", () => {
  const strays = [card("B1", "BBB", "todo", 1000), card("A1x", "AAA", "todo", 1000)];
  assert.deepEqual(
    boardLanes(strays, order, true).map((l) => l.project),
    ["AAA", "BBB"],
  );
});

/**
 * `boardColumns` sorts a fresh array out of `.filter()`, and `boardLanes` now
 * calls it once per project. If those buckets ever came to share backing arrays
 * the symptom would be an intermittent reshuffle nothing else would catch.
 */
test("the input array is left alone", () => {
  const before = board.map((i) => i.key);
  boardLanes(board, order, true);
  boardLanes(board, order, false);
  assert.deepEqual(
    board.map((i) => i.key),
    before,
  );
});

test("every lane carries a column per status, so the grid always gets a full row", () => {
  const statuses = boardColumns([], order).map((c) => c.status);
  for (const lane of boardLanes(board, order, true)) {
    assert.deepEqual(
      lane.columns.map((c) => c.status),
      statuses,
    );
  }
});

test("a grouped lane holds only its own project's cards", () => {
  for (const lane of boardLanes(board, order, true)) {
    for (const column of lane.columns) {
      for (const i of column.items) assert.equal(i.project, lane.project);
    }
  }
});

/**
 * The promise the whole file is written around. A project the sidebar has never
 * heard of cannot happen from the app — every item's project has a project file —
 * but `boardColumns` sorts an unknown project last rather than dropping it, and a
 * card simply absent from the board is the one failure mode with no symptom.
 */
test("a project the sidebar does not know still gets a lane, at the end", () => {
  const withStray = [...board, card("Z1", "ZZZ", "todo", 1000)];
  assert.deepEqual(
    boardLanes(withStray, order, true).map((l) => l.project),
    ["WEB", "API", "ZZZ"],
  );
});

test("every item appears exactly once, grouped or not", () => {
  const withStray = [...board, card("Z1", "ZZZ", "todo", 1000)];
  const expected = withStray.map((i) => i.key).sort();
  for (const grouped of [false, true]) {
    assert.deepEqual(laneKeys(boardLanes(withStray, order, grouped)).sort(), expected);
  }
});

/**
 * What `orderedKeys` depends on, asserted so it reads as a decision. Ungrouped,
 * the cursor walks every project's To do before any project's In progress;
 * grouped it walks one band at a time, because with bands on screen the other
 * order sends it back up the page.
 */
test("grouping turns the keyboard order from status-major into lane-major", () => {
  assert.deepEqual(laneKeys(boardLanes(board, order, false)), ["W1", "A1", "A2", "W2"]);
  assert.deepEqual(laneKeys(boardLanes(board, order, true)), ["W1", "W2", "A1", "A2"]);
});

/**
 * Why the board's reorder walk needs no second code path when grouped: a lane's
 * column is one project in rank order, so the nearest same-project card in the
 * direction of travel is always the card that was dropped on.
 */
test("a grouped lane column is one project in rank order", () => {
  const api = boardLanes(board, order, true).find((l) => l.project === "API");
  const todo = api?.columns.find((c) => c.status === "todo");
  assert.deepEqual(
    todo?.items.map((i) => i.key),
    ["A1", "A2"],
  );
});

// ------------------------------------------------------------- agenda bands

/** A due-dated item and the key/date map the grouping reads. */
function dated(key: string, dueDate: string): Item {
  return { ...item(key), dueDate } as unknown as Item;
}

const BANDS = [
  { label: "This week", from: "2026-08-03", to: "2026-08-09" },
  { label: "Next week", from: "2026-08-10", to: "2026-08-16" },
  { label: "Later", from: "2026-08-17", to: "2026-09-02" },
];

function byKeyOf(items: Item[]): ReadonlyMap<string, Item> {
  return new Map(items.map((i) => [i.key, i]));
}

test("a section with no bands is one unlabelled group", () => {
  const items = [dated("A1", "2026-08-04"), dated("A2", "2026-08-20")];
  const groups = groupIntoBands({ keys: ["A1", "A2"] }, byKeyOf(items));
  assert.deepEqual(groups, [{ label: null, keys: ["A1", "A2"] }]);
});

test("bands cut an already-sorted list into contiguous runs", () => {
  const items = [
    dated("A1", "2026-08-04"),
    dated("A2", "2026-08-09"),
    dated("A3", "2026-08-10"),
    dated("A4", "2026-08-16"),
    dated("A5", "2026-08-17"),
  ];
  const groups = groupIntoBands(
    { bands: BANDS, keys: items.map((i) => i.key) },
    byKeyOf(items),
  );
  assert.deepEqual(
    groups.map((g) => [g.label, g.keys]),
    [
      ["This week", ["A1", "A2"]],
      ["Next week", ["A3", "A4"]],
      ["Later", ["A5"]],
    ],
    "both ends of every band are inclusive",
  );
});

test("grouping preserves the order the section arrived in", () => {
  const items = [
    dated("A1", "2026-08-04"),
    dated("A2", "2026-08-11"),
    dated("A3", "2026-08-25"),
  ];
  const keys = items.map((i) => i.key);
  const groups = groupIntoBands({ bands: BANDS, keys }, byKeyOf(items));
  assert.deepEqual(
    groups.flatMap((g) => g.keys),
    keys,
    "concatenating the bands is the keyboard walk, unchanged",
  );
});

test("an empty band is dropped rather than headed", () => {
  const items = [dated("A1", "2026-08-04"), dated("A2", "2026-08-25")];
  const groups = groupIntoBands({ bands: BANDS, keys: ["A1", "A2"] }, byKeyOf(items));
  assert.deepEqual(
    groups.map((g) => g.label),
    ["This week", "Later"],
    "nothing is due next week, so next week is not announced",
  );
});

test("a key the bands do not cover still renders, in the last band", () => {
  // Unreachable while the core's bands span the window. Asserted because the
  // failure it guards against is an item vanishing off the agenda entirely,
  // which reads as work that does not exist rather than as a display bug.
  const items = [dated("A1", "2026-08-04"), dated("A2", "2027-01-01")];
  const groups = groupIntoBands({ bands: BANDS, keys: ["A1", "A2"] }, byKeyOf(items));
  assert.deepEqual(groups.flatMap((g) => g.keys), ["A1", "A2"]);
  assert.equal(groups.at(-1)?.label, "Later");
});

test("an item missing from the map is still placed rather than dropped", () => {
  // The agenda narrows to keys it can see before this runs, so a miss means the
  // item went away mid-render. It must not take a band's other rows with it.
  const items = [dated("A1", "2026-08-04")];
  const groups = groupIntoBands({ bands: BANDS, keys: ["GONE", "A1"] }, byKeyOf(items));
  assert.deepEqual(groups.flatMap((g) => g.keys).sort(), ["A1", "GONE"]);
});
