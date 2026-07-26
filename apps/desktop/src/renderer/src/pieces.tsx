// Runtime values come from the constants subpath, which imports nothing.
// Importing them from the package root would pull vault.js — and node:fs — into
// the renderer bundle. Types are erased, so they can come from the root.
import { DONE_STATUSES, TRANSITIONS, type ItemType, type Status } from "todo-vault/constants";
import type { Item } from "todo-vault";

/**
 * Which statuses an item can actually move to, straight from the core's table.
 *
 * The UI reads this rather than offering everything and letting the write fail:
 * todo → in_review is rejected by design, and a rejected drag looks like a bug
 * even when the error message is perfect.
 */
export function legalTransitions(from: Status): readonly Status[] {
  return TRANSITIONS[from] ?? [];
}

export function canTransition(from: Status, to: Status): boolean {
  return from === to || legalTransitions(from).includes(to);
}

/**
 * Which items an item of this type and project could hang off, mirroring the
 * core's `assertParentValid` — epics take no parent, subtasks hang off a story,
 * task, or bug, and everything else off an epic.
 *
 * Same reasoning as legalTransitions: a picker that only offers legal parents
 * cannot submit a pairing the vault will refuse. One copy, read by both the
 * create form and the detail panel, so the two cannot disagree about what the
 * hierarchy allows.
 */
export function legalParents(items: Item[], project: string, type: ItemType): Item[] {
  if (type === "epic") return [];
  return items.filter((candidate) => {
    if (candidate.project !== project) return false;
    return type === "subtask"
      ? ["story", "task", "bug"].includes(candidate.type)
      : candidate.type === "epic";
  });
}

/**
 * Whether a status means the item is finished with, however it ended.
 *
 * Straight from the core's array rather than a comparison against "done",
 * because there are now two ways to be closed and every view had its own copy of
 * the one-status version. Anything asking "is this still live" — the open-only
 * filter, the sidebar counts, the overdue flag, the palette's ranking — asks
 * this. The board and the status pill are where the two deliberately differ.
 */
export function isClosed(status: string): boolean {
  return DONE_STATUSES.includes(status as Status);
}

/** Small presentational pieces shared by the table, board, agenda, and detail. */

export const STATUS_LABELS: Record<string, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
  disregard: "Disregarded",
};

/**
 * A column each, including disregard.
 *
 * Not folding it into Done: a column only shows items whose status it names, so
 * a status missing from this list would make those cards vanish from the board
 * with no explanation. Six columns overflow a narrow window, and `.content`
 * scrolls, which is the cheaper of the two failures.
 */
export const BOARD_ORDER = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "disregard",
] as const;

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isOverdue(item: Item, today = todayIso()): boolean {
  return Boolean(item.dueDate && item.dueDate < today && !isClosed(item.status));
}

export function StatusPill({ status }: { status: string }): React.JSX.Element {
  return (
    <span className="pill">
      <span className="dot" style={{ background: `var(--${status})` }} />
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function PriorityMark({ priority }: { priority: string }): React.JSX.Element {
  return (
    <span className="pill" title={`Priority: ${priority}`}>
      <span className="dot" style={{ background: `var(--${priority})` }} />
      {priority}
    </span>
  );
}

export function DueDate({ item }: { item: Item }): React.JSX.Element | null {
  if (!item.dueDate) return null;
  return (
    <span className={isOverdue(item) ? "due-overdue" : undefined}>
      {item.dueDate}
      {isOverdue(item) ? " — overdue" : ""}
    </span>
  );
}

/**
 * Cadence is local-only and has nothing to do with a due date, so it reads as an
 * interval rather than a deadline.
 */
export function Cadence({ cadence }: { cadence: string }): React.JSX.Element | null {
  if (cadence === "none") return null;
  return <span className="pill" title="Recurring — a cadence, not a deadline">↻ {cadence}</span>;
}

/**
 * The date on an agenda row, labelled according to the section it sits in.
 *
 * A cadence is an interval and a due date is a deadline, and one item can carry
 * both. Under "overdue" and "due" the heading already says what the date means,
 * so it stands bare. Under "recurring" it does not, and a bare date there reads
 * as a contradiction of the heading — the seeded vault's OPS-2 shows under
 * "recurring this week" carrying 2026-07-29, which is true but looks wrong.
 *
 * In the recurring section the date is always *after* the window: Vault.agenda
 * partitions first, sending anything already past to "overdue" and anything
 * landing inside the window to "due", so only the later ones are left. The two
 * other branches below are therefore unreachable today, and kept deliberately —
 * they are what stops a change to that partitioning from silently reintroducing
 * the bare, unexplained date this component exists to prevent.
 */
export function AgendaDueDate({
  item,
  section,
}: {
  item: Item;
  section: { kind: "overdue" | "due" | "recurring"; from?: string; to?: string };
}): React.JSX.Element | null {
  if (!item.dueDate) return null;
  if (section.kind !== "recurring") {
    return <span className="section-range">{item.dueDate}</span>;
  }
  if (isOverdue(item)) {
    return <span className="section-range due-overdue">due {item.dueDate} · already overdue</span>;
  }
  if (section.to && item.dueDate > section.to) {
    return <span className="section-range">due {item.dueDate} · after this window</span>;
  }
  return <span className="section-range">due {item.dueDate}</span>;
}
