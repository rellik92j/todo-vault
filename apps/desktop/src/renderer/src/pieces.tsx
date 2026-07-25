import type { Item } from "todo-vault";

/** Small presentational pieces shared by the table, board, agenda, and detail. */

export const STATUS_LABELS: Record<string, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  blocked: "Blocked",
  done: "Done",
};

export const BOARD_ORDER = ["todo", "in_progress", "in_review", "blocked", "done"] as const;

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function isOverdue(item: Item, today = todayIso()): boolean {
  return Boolean(item.dueDate && item.dueDate < today && item.status !== "done");
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
