import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Item } from "todo-vault";
import { monthGrid, type CalendarDay } from "./calendar";
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
 *
 * Drag a chip to another cell to move its due date — the same `@dnd-kit/core`
 * pattern `Board.tsx` uses, with the day's `date` string standing in for the
 * column id: it is already unique across the whole grid, leading/trailing
 * cells included, so no composite id is needed here the way the board needs
 * one for `project` + `status`.
 */
export function Calendar({
  month,
  items,
  today,
  selected,
  onSelect,
  onJumpToMonth,
  onReschedule,
}: {
  /** YYYY-MM, the month currently on screen. */
  month: string;
  items: Item[];
  today: string;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Jump the grid to the month holding the earliest pre-month overdue item. */
  onJumpToMonth: (month: string) => void;
  /** A chip was dropped on another day: set the item's due date to it. */
  onReschedule: (key: string, dueDate: string) => void;
}): React.JSX.Element {
  const grid = useMemo(() => monthGrid(month, items, today), [month, items, today]);
  const [dragging, setDragging] = useState<Item | null>(null);
  const sensors = useSensors(
    // A small threshold so a click still selects rather than starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragStart = (event: DragStartEvent): void => {
    setDragging(items.find((i) => i.key === event.active.id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const active = dragging;
    setDragging(null);
    if (!active || !event.over) return;
    const date = event.over.id as string;
    if (date !== active.dueDate) onReschedule(active.key, date);
  };

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
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDragging(null)}
      >
        <div className="cal-grid">
          {WEEKDAYS.map((day) => (
            <div className="cal-weekday" key={day}>
              {day}
            </div>
          ))}
          {grid.map((day) => (
            <Day key={day.date} day={day} today={today} selected={selected} onSelect={onSelect} />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {dragging && (
            <div
              className="cal-chip cal-chip-overlay"
              style={{ borderLeftColor: `var(--${dragging.priority})` }}
            >
              {dragging.summary}
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function Day({
  day,
  today,
  selected,
  onSelect,
}: {
  day: CalendarDay;
  today: string;
  selected: string | null;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: day.date });

  return (
    <div
      ref={setNodeRef}
      className={`cal-day${isOver ? " cal-day-over" : ""}`}
      data-date={day.date}
      data-out={day.inMonth ? undefined : "true"}
      data-today={day.isToday ? "true" : undefined}
    >
      <span className="cal-day-num">{Number(day.date.slice(8))}</span>
      {day.items.map((item) => (
        <Chip key={item.key} item={item} today={today} selected={item.key === selected} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Chip({
  item,
  today,
  selected,
  onSelect,
}: {
  item: Item;
  today: string;
  selected: boolean;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.key });

  return (
    <button
      type="button"
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`cal-chip${isOverdue(item, today) ? " due-overdue" : ""}${
        isDragging ? " cal-chip-placeholder" : ""
      }`}
      aria-selected={selected}
      style={{ borderLeftColor: `var(--${item.priority})` }}
      title={`${item.key} — ${item.summary}`}
      onClick={() => onSelect(item.key)}
    >
      {item.summary}
    </button>
  );
}
