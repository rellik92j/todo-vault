import type { Item, Status } from "todo-vault";
import { BOARD_ORDER } from "./pieces";

export interface BacklogRow {
  item: Item;
  depth: number;
  /**
   * Whether this item has children in the filtered set — what decides if a row
   * gets a twisty. The walk knows this already; recomputing it in the table
   * would be a second answer to a question with one right one.
   */
  hasChildren: boolean;
}

/**
 * The backlog's display order: parents followed by their children, depth-first.
 *
 * Children are nested under their parent so the hierarchy is visible without a
 * tree widget, but only when the parent is in the filtered set; otherwise an
 * orphaned child would silently disappear from view.
 *
 * `collapsed` holds the keys whose children are hidden. It arrives as an
 * argument rather than being read from anywhere because two callers must agree
 * on the result — see the note above `orderedKeys` in App.tsx.
 */
export function backlogOrder(
  items: Item[],
  collapsed: ReadonlySet<string> = new Set(),
): BacklogRow[] {
  const present = new Set(items.map((i) => i.key));
  const roots = items.filter((i) => !i.parent || !present.has(i.parent));
  const childrenOf = new Map<string, Item[]>();
  for (const item of items) {
    if (item.parent && present.has(item.parent)) {
      const list = childrenOf.get(item.parent) ?? [];
      list.push(item);
      childrenOf.set(item.parent, list);
    }
  }

  const ordered: BacklogRow[] = [];
  const walk = (item: Item, depth: number): void => {
    const children = childrenOf.get(item.key) ?? [];
    ordered.push({ item, depth, hasChildren: children.length > 0 });
    // Collapse is checked here, on an item that has just been emitted, rather
    // than by filtering the finished array. That is what stops a collapsed key
    // the filter dropped from reaching through and hiding its children anyway:
    // those children were promoted to roots above, and this line never runs for
    // a parent that was never emitted. Collapse hides the children of a visible
    // parent, and only that.
    if (collapsed.has(item.key)) return;
    for (const child of children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);

  return ordered;
}

/**
 * One horizontal band of the board.
 *
 * `project` is null in exactly one case: ungrouped mode, which is a single lane
 * holding every project. Null rather than a sentinel string because it is the
 * one value a project key can never be, so nothing downstream has to know which
 * made-up key means "all of them".
 */
export interface BoardLane {
  project: string | null;
  columns: Array<{ status: Status; items: Item[] }>;
}

/**
 * The board as it is drawn: a list of lanes, each a full row of status columns.
 *
 * One function for both modes, called by the board *and* by `orderedKeys` in
 * App.tsx — see the note there. The keyboard cursor walks the order the eye
 * sees, and the only way to guarantee that is for there to be one answer to
 * what that order is.
 *
 * Grouping changes the flattened order from status-major to lane-major, which is
 * the point: with lanes on screen, walking every project's To do column before
 * any project's In progress column would send the cursor back up the page.
 */
export function boardLanes(
  items: Item[],
  projectOrder: string[],
  grouped: boolean,
): BoardLane[] {
  if (!grouped) return [{ project: null, columns: boardColumns(items, projectOrder) }];

  const byProject = new Map<string, Item[]>();
  for (const item of items) {
    const list = byProject.get(item.project);
    if (list) list.push(item);
    else byProject.set(item.project, [item]);
  }

  // Sidebar order for the projects the sidebar knows, then anything left over.
  // The leftovers cannot normally happen — every item's project has a project
  // file — but `boardColumns` already sorts an unknown project last rather than
  // dropping it, and the same rule here keeps the promise the whole file is
  // written around: nothing in `items` may silently fail to appear.
  const known = projectOrder.filter((key) => byProject.has(key));
  const knownSet = new Set(known);
  const rest = [...byProject.keys()]
    .filter((key) => !knownSet.has(key))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  // A project with nothing in the filtered set gets no lane. Under a filter —
  // and "Hide closed" is one, on by default — the alternative is a screen of
  // empty bands with the cards buried among them.
  return [...known, ...rest].map((project) => ({
    project,
    columns: boardColumns(byProject.get(project) ?? [], projectOrder),
  }));
}

/**
 * The board's columns: grouped by project, then by manual rank inside each project.
 *
 * Ranks are per project, so two ranks from different projects are numbers from
 * different spaces — comparing them directly made a single drag appear to
 * reshuffle every project at once. Grouping first gives a stable order that can
 * be explained: project blocks in the order the sidebar shows, each internally
 * in the order you dragged.
 *
 * Still sorts by project when called for one lane, where every item shares a
 * project and that comparison is a no-op. Cheaper than a second code path.
 */
export function boardColumns(
  items: Item[],
  projectOrder: string[],
): Array<{ status: Status; items: Item[] }> {
  const projectRank = new Map(projectOrder.map((key, index) => [key, index]));

  return BOARD_ORDER.map((status) => ({
    status,
    items: items
      .filter((i) => i.status === status)
      .sort((a, b) => {
        const byProject =
          (projectRank.get(a.project) ?? Number.MAX_SAFE_INTEGER) -
          (projectRank.get(b.project) ?? Number.MAX_SAFE_INTEGER);
        if (byProject !== 0) return byProject;

        if (a.rank !== undefined && b.rank !== undefined && a.rank !== b.rank) {
          return a.rank - b.rank;
        }
        if (a.rank !== undefined && b.rank === undefined) return -1;
        if (a.rank === undefined && b.rank !== undefined) return 1;
        return a.key.localeCompare(b.key, undefined, { numeric: true });
      }),
  }));
}
