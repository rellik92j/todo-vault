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
 * The board's columns: grouped by project, then by manual rank inside each project.
 *
 * Ranks are per project, so two ranks from different projects are numbers from
 * different spaces — comparing them directly made a single drag appear to
 * reshuffle every project at once. Grouping first gives a stable order that can
 * be explained: project blocks in the order the sidebar shows, each internally
 * in the order you dragged.
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
