import { useMemo } from "react";
import type { Item } from "todo-vault";
import { monthGrid } from "./calendar";
import { isOverdue } from "./pieces";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The month grid: due dates only, Sunday-anchored, growing rather than
 * truncating a heavy day — see the plan's reasoning in `calendar.ts`.
 *
 * Reads `items` straight from `filtered`, the same list the board and backlog
 * draw from, so every toolbar filter narrows this view exactly as it narrows
 * theirs. The agenda is the one view that does not follow that rule, for
 * reasons that do not apply here.
 */
export function Calendar({
  month,
  items,
  today,
  selected,
  onSelect,
  onJumpToMonth,
}: {
  /** YYYY-MM, the month currently on screen. */
  month: string;
  items: Item[];
  today: string;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Jump the grid to the month holding the earliest pre-month overdue item. */
  onJumpToMonth: (month: string) => void;
}): React.JSX.Element {
  const grid = useMemo(() => monthGrid(month, items, today), [month, items, today]);

  /**
   * Overdue work from before the visible month: correctly absent from the grid
   * above, but too urgent to disappear from the view entirely. Sorted so the
   * jump button always lands on the earliest one.
   */
  const overdueBefore = useMemo(
    () =>
      items
        .filter((i) => i.dueDate && i.dueDate < `${month}-01` && isOverdue(i, today))
        .sort((a, b) => (a.dueDate as string).localeCompare(b.dueDate as string)),
    [items, month, today],
  );

  return (
    <div className="calendar">
      {overdueBefore.length > 0 && (
        <div className="banner banner-warn">
          <span style={{ flex: 1 }}>
            {overdueBefore.length} item{overdueBefore.length === 1 ? "" : "s"} overdue before this
            month
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => onJumpToMonth((overdueBefore[0].dueDate as string).slice(0, 7))}
          >
            Go to earliest
          </button>
        </div>
      )}
      <div className="cal-grid">
        {WEEKDAYS.map((day) => (
          <div className="cal-weekday" key={day}>
            {day}
          </div>
        ))}
        {grid.map((day) => (
          <div
            key={day.date}
            className="cal-day"
            data-out={day.inMonth ? undefined : "true"}
            data-today={day.isToday ? "true" : undefined}
          >
            <span className="cal-day-num">{Number(day.date.slice(8))}</span>
            {day.items.map((item) => (
              <button
                type="button"
                key={item.key}
                className={`cal-chip${isOverdue(item, today) ? " due-overdue" : ""}`}
                aria-selected={item.key === selected}
                style={{ borderLeftColor: `var(--${item.priority})` }}
                title={`${item.key} — ${item.summary}`}
                onClick={() => onSelect(item.key)}
              >
                {item.summary}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
