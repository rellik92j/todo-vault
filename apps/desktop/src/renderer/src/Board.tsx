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
import type { Item, Status } from "todo-vault";
import { isTickedFor, todayIso } from "todo-vault/recurrence";

import { Cadence, STATUS_LABELS, canTransition, isOverdue } from "./pieces";
import { boardColumns } from "./ordering";

/**
 * Status columns in manual rank order, with drag to reorder or transition.
 *
 * Two different operations depending on where a card lands:
 *   across columns  -> transition, which the core validates
 *   within a column -> moveItem, using the neighbours it landed between
 *
 * Columns an item cannot legally reach are dimmed and refuse the drop while it
 * is being dragged, rather than accepting it and surfacing an error afterwards.
 * todo -> in_review is rejected by design, and a card that springs back with a
 * toast reads as a bug even when the message is exactly right.
 */
export function Board({
  items,
  projectOrder,
  selected,
  onSelect,
  onTransition,
  onReorder,
}: {
  items: Item[];
  /** Project keys in sidebar order, used to group each column. */
  projectOrder: string[];
  selected: string | null;
  onSelect: (key: string) => void;
  onTransition: (key: string, status: Status) => void;
  onReorder: (key: string, position: { after?: string; before?: string }) => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState<Item | null>(null);
  const sensors = useSensors(
    // A small threshold so a click still selects rather than starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const columns = useMemo(() => boardColumns(items, projectOrder), [items, projectOrder]);

  const onDragStart = (event: DragStartEvent): void => {
    setDragging(items.find((i) => i.key === event.active.id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const active = dragging;
    setDragging(null);
    if (!active || !event.over) return;

    const overId = String(event.over.id);

    // Dropped on a column body: a status change, or a no-op onto its own column.
    if (overId.startsWith("column:")) {
      const status = overId.slice("column:".length) as Status;
      if (status !== active.status && canTransition(active.status, status)) {
        onTransition(active.key, status);
      }
      return;
    }

    // Dropped on another card.
    const target = items.find((i) => i.key === overId);
    if (!target || target.key === active.key) return;

    if (target.status !== active.status) {
      if (canTransition(active.status, target.status)) onTransition(active.key, target.status);
      return;
    }

    // Same column, so this is a reorder. Ranks are per project, but a column
    // interleaves every project, so the card physically above may belong to a
    // different one — asking the vault to rank across projects is rejected, and
    // rightly. Reorder against the nearest card of the *same* project in the
    // direction of travel, which is the closest thing to what the drop implied.
    const column = columns.find((c) => c.status === active.status);
    if (!column) return;
    const from = column.items.findIndex((i) => i.key === active.key);
    const to = column.items.findIndex((i) => i.key === target.key);
    if (from === -1 || to === -1) return;

    const sameProject = (candidate: Item): boolean =>
      candidate.project === active.project && candidate.key !== active.key;

    if (from < to) {
      // Moving down: sit after the last same-project card at or above the drop.
      for (let i = to; i >= 0; i -= 1) {
        const candidate = column.items[i];
        if (sameProject(candidate)) {
          onReorder(active.key, { after: candidate.key });
          return;
        }
      }
    } else {
      // Moving up: sit before the first same-project card at or below the drop.
      for (let i = to; i < column.items.length; i += 1) {
        const candidate = column.items[i];
        if (sameProject(candidate)) {
          onReorder(active.key, { before: candidate.key });
          return;
        }
      }
    }
    // No same-project neighbour on that side: nothing meaningful to do.
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="board">
        {columns.map((column) => (
          <Column
            key={column.status}
            status={column.status}
            items={column.items}
            selected={selected}
            onSelect={onSelect}
            dragging={dragging}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null}>
        {dragging && <Card item={dragging} selected={false} overlay />}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  status,
  items,
  selected,
  onSelect,
  dragging,
}: {
  status: Status;
  items: Item[];
  selected: string | null;
  onSelect: (key: string) => void;
  dragging: Item | null;
}): React.JSX.Element {
  const allowed = !dragging || canTransition(dragging.status, status);
  const { setNodeRef, isOver } = useDroppable({ id: `column:${status}`, disabled: !allowed });

  return (
    <section
      className={`column ${dragging && !allowed ? "column-blocked" : ""} ${
        isOver && allowed ? "column-over" : ""
      }`}
      ref={setNodeRef}
    >
      <header className="column-head">
        <span className="dot" style={{ background: `var(--${status})` }} />
        {STATUS_LABELS[status]}
        <span className="column-count">{items.length}</span>
      </header>
      <div className="column-body">
        {items.map((item) => (
          <DraggableCard
            key={item.key}
            item={item}
            selected={item.key === selected}
            onSelect={onSelect}
          />
        ))}
        {items.length === 0 && (
          <div className="column-empty">
            {dragging && !allowed ? "not a legal move" : "nothing here"}
          </div>
        )}
      </div>
    </section>
  );
}

function DraggableCard({
  item,
  selected,
  onSelect,
}: {
  item: Item;
  selected: boolean;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.key });
  const { setNodeRef: setDropRef } = useDroppable({ id: item.key });

  return (
    <div
      ref={(node) => {
        setNodeRef(node);
        setDropRef(node);
      }}
      {...attributes}
      {...listeners}
      className={isDragging ? "card-placeholder" : undefined}
      onClick={() => onSelect(item.key)}
    >
      <Card item={item} selected={selected} />
    </div>
  );
}

function Card({
  item,
  selected,
  overlay,
}: {
  item: Item;
  selected: boolean;
  overlay?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={`card ${overlay ? "card-overlay" : ""}`}
      aria-selected={selected}
      style={{ borderLeftColor: `var(--${item.priority})` }}
    >
      <div className="card-top">
        <span className="card-key">{item.key}</span>
        <span className="type">{item.type}</span>
      </div>
      <div className="card-summary">{item.summary}</div>
      {(item.dueDate || item.cadence !== "none" || item.labels.length > 0) && (
        <div className="card-foot">
          {item.dueDate && (
            <span className={isOverdue(item) ? "due-overdue" : undefined}>{item.dueDate}</span>
          )}
          <Cadence cadence={item.cadence} ticked={isTickedFor(item, todayIso())} />
          {item.labels.slice(0, 2).map((label) => (
            <span className="label" key={label}>
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
