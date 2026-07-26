import type { Item, Status } from "todo-vault";
import { BOARD_ORDER } from "./pieces";

/**
 * The backlog's display order: parents followed by their children, depth-first.
 *
 * Children are nested under their parent so the hierarchy is visible without a
 * tree widget, but only when the parent is in the filtered set; otherwise an
 * orphaned child would silently disappear from view.
 */
export function backlogOrder(items: Item[]): Array<{ item: Item; depth: number }> {
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

  const ordered: Array<{ item: Item; depth: number }> = [];
  const walk = (item: Item, depth: number): void => {
    ordered.push({ item, depth });
    for (const child of childrenOf.get(item.key) ?? []) walk(child, depth + 1);
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
