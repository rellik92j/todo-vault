import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  pointerWithin,
  PointerSensor,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { Item, Status } from "todo-vault";
import { isTickedFor, todayIso } from "todo-vault/recurrence";

import { BOARD_ORDER, Cadence, STATUS_LABELS, canTransition, isOverdue } from "./pieces";
import { boardLanes } from "./ordering";

/**
 * The strip sits visually on top of whatever column is beneath it, but dnd-kit's
 * built-in algorithms compare rects, not stacking order — the card underneath a
 * zone is just as valid a `pointerWithin` match as the zone itself, and on a
 * short board the card can win. A drop-strip zone always wins when it is one of
 * the candidates, because nothing can be "more under the pointer" than the
 * topmost thing actually drawn there. `pointerWithin` first, falling back to
 * `rectIntersection`, is the same fallback dnd-kit's own docs use — a fast
 * pointer flick can end a drag between measured pointer positions, landing
 * outside every droppable by the stricter test.
 */
const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  const stripHit = pointerHits.find((hit) => String(hit.id).startsWith("dropstrip:"));
  if (stripHit) return [stripHit];
  return pointerHits.length > 0 ? pointerHits : rectIntersection(args);
};

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
 *
 * `grouped` splits the same columns into one band per project. Another project's
 * band refuses the drop under the same rule and for a stronger reason: moving an
 * item between projects re-keys it, which is not something a stray drag should
 * be able to do.
 */
export function Board({
  items,
  projectOrder,
  projectNames,
  grouped,
  statuses,
  filterStatus,
  selected,
  onSelect,
  onTransition,
  onReorder,
}: {
  items: Item[];
  /** Project keys in sidebar order, used to group each column. */
  projectOrder: string[];
  /** Key -> display name, for the lane headers. Only read when `grouped`. */
  projectNames: ReadonlyMap<string, string>;
  /** One band per project rather than one band holding all of them. */
  grouped: boolean;
  /**
   * The columns the current filters leave reachable, in `BOARD_ORDER` order —
   * `visibleBoardStatuses` in ordering.ts owns the rule. Drives the header row,
   * `--columns`, and the ungrouped column list; a status missing from this list
   * draws no column at all.
   */
  statuses: Status[];
  /** The raw status filter, read only to name the empty state when it and `Hide
   * closed` together leave zero columns. */
  filterStatus: Status | "all";
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

  const lanes = useMemo(
    () => boardLanes(items, projectOrder, grouped, statuses),
    [items, projectOrder, grouped, statuses],
  );

  /**
   * Per-status totals for the header row, which is drawn once above every lane
   * and so cannot take its count from any one of them.
   */
  const totals = useMemo(() => {
    const counts = new Map<Status, number>();
    for (const lane of lanes) {
      for (const column of lane.columns) {
        counts.set(column.status, (counts.get(column.status) ?? 0) + column.items.length);
      }
    }
    return counts;
  }, [lanes]);

  /**
   * Regrouping mid-drag abandons the drag.
   *
   * `g` fires from a window keydown listener, so unlike the toolbar checkbox — a
   * pointer-down on which ends the gesture first — it reaches here mid-drag.
   * Every column droppable's id changes, dnd-kit re-registers and re-measures
   * them all, and mouse-up would then commit a transition or a reorder against a
   * layout that moved after the user aimed. Switching views is safe by accident,
   * because it unmounts the DndContext; this is the case that isn't.
   */
  useEffect(() => {
    setDragging(null);
  }, [grouped]);

  const onDragStart = (event: DragStartEvent): void => {
    setDragging(items.find((i) => i.key === event.active.id) ?? null);
  };

  const onDragEnd = (event: DragEndEvent): void => {
    const active = dragging;
    setDragging(null);
    if (!active || !event.over) return;

    const over = event.over.data.current as DropTarget | undefined;
    if (!over) return;

    // Dropped on a column body: a status change, or a no-op onto its own column.
    if (over.kind === "column") {
      // A lane belonging to another project disables its droppables, so this is
      // the backstop rather than the guard. Worth keeping: the alternative is a
      // silent transition triggered by a drop the UI had already dimmed.
      if (over.project !== null && over.project !== active.project) return;
      if (over.status !== active.status && canTransition(active.status, over.status)) {
        onTransition(active.key, over.status);
      }
      return;
    }

    // Dropped on another card.
    const target = over.item;
    if (target.key === active.key) return;

    // Grouped, a card in another project's band is not a target. Ungrouped, the
    // bands do not exist and a column legitimately interleaves projects — which
    // is what the same-project walk below is for.
    if (grouped && target.project !== active.project) return;

    if (target.status !== active.status) {
      if (canTransition(active.status, target.status)) onTransition(active.key, target.status);
      return;
    }

    // Same column, so this is a reorder. Ranks are per project, but an ungrouped
    // column interleaves every project, so the card physically above may belong
    // to a different one — asking the vault to rank across projects is rejected,
    // and rightly. Reorder against the nearest card of the *same* project in the
    // direction of travel, which is the closest thing to what the drop implied.
    //
    // Grouped, every card in the lane already shares a project, so the walk
    // finds the drop target itself on its first step and this reduces to
    // "after/before the card you dropped on". Same code, exactly right.
    const lane = lanes.find((l) => l.project === null || l.project === active.project);
    const activeColumn = lane?.columns.find((c) => c.status === active.status);
    if (!activeColumn) return;
    const from = activeColumn.items.findIndex((i) => i.key === active.key);
    const to = activeColumn.items.findIndex((i) => i.key === target.key);
    if (from === -1 || to === -1) return;

    const sameProject = (candidate: Item): boolean =>
      candidate.project === active.project && candidate.key !== active.key;

    if (from < to) {
      // Moving down: sit after the last same-project card at or above the drop.
      for (let i = to; i >= 0; i -= 1) {
        const candidate = activeColumn.items[i];
        if (sameProject(candidate)) {
          onReorder(active.key, { after: candidate.key });
          return;
        }
      }
    } else {
      // Moving up: sit before the first same-project card at or below the drop.
      for (let i = to; i < activeColumn.items.length; i += 1) {
        const candidate = activeColumn.items[i];
        if (sameProject(candidate)) {
          onReorder(active.key, { before: candidate.key });
          return;
        }
      }
    }
    // No same-project neighbour on that side: nothing meaningful to do.
  };

  /** Whether a lane will accept the card in flight at all. */
  const laneAllows = (lane: { project: string | null }): boolean =>
    !dragging || lane.project === null || lane.project === dragging.project;

  /**
   * The statuses the current filters hid that the card in flight could still
   * legally reach — what the drop strip renders while `dragging` is set.
   *
   * `BOARD_ORDER`, not `statuses`: this list exists precisely to reach the
   * columns `statuses` left out, so filtering against the same list would empty
   * it. A card whose own status is filtered out never appears as a draggable in
   * the first place, so `dragging` here is always a status `statuses` includes.
   */
  const hiddenReachable = useMemo(
    () =>
      dragging
        ? BOARD_ORDER.filter((s) => !statuses.includes(s) && canTransition(dragging.status, s))
        : [],
    [dragging, statuses],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      {statuses.length === 0 ? (
        <div className="board-empty">
          Hide closed and a status of {STATUS_LABELS[filterStatus]} cannot both be true. Untick
          Hide closed, or pick another status.
        </div>
      ) : grouped ? (
        // --columns rather than a literal 6 in the CSS: the header row and every
        // lane are *separate* grids that have to agree on their track count, or
        // the names stop sitting above the columns they name. `statuses` owns how
        // many columns there are — the same list that decides which ones — so it
        // owns the track count too — one number feeding both grids, rather than a
        // 6 in the stylesheet that a seventh status, or a filter, would silently
        // leave behind.
        <div
          className="board-grouped"
          style={{ "--columns": statuses.length } as React.CSSProperties}
        >
          <div className="board-head-row">
            {statuses.map((status) => (
              <div className="board-head" key={status}>
                <span className="dot" style={{ background: `var(--${status})` }} />
                {STATUS_LABELS[status]}
                <span className="column-count">{totals.get(status) ?? 0}</span>
              </div>
            ))}
          </div>

          {lanes.map((lane) => {
            const laneAllowed = laneAllows(lane);
            const blocked = Boolean(dragging) && !laneAllowed;
            return (
              <section
                className={`lane ${blocked ? "lane-blocked" : ""}`}
                key={lane.project ?? "*"}
              >
                <header className="lane-head">
                  <span className="lane-key">{lane.project}</span>
                  <span className="lane-name">
                    {(lane.project && projectNames.get(lane.project)) ?? ""}
                  </span>
                  {/*
                    The lane's own cards, not the project's open count. `openItems`
                    is computed over the whole vault *and* counts only open work,
                    so it would disagree with the cards under it in two directions
                    at once — with Hide closed off, a band of 12 headed "7".
                  */}
                  <span className="lane-count" title="Cards in this band, after filters">
                    {lane.columns.reduce((n, c) => n + c.items.length, 0)}
                  </span>
                </header>
                <div className="lane-columns">
                  {lane.columns.map((column) => (
                    <Column
                      key={column.status}
                      id={columnId(lane.project, column.status)}
                      project={lane.project}
                      status={column.status}
                      items={column.items}
                      laneAllowed={laneAllowed}
                      statusAllowed={!dragging || canTransition(dragging.status, column.status)}
                      compact
                      selected={selected}
                      onSelect={onSelect}
                      dragging={dragging}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {lanes.length === 0 && <div className="lane-empty">nothing here</div>}
        </div>
      ) : (
        <div className="board">
          {/* Exactly one lane, from boardLanes' ungrouped early return. */}
          {lanes[0].columns.map((column) => (
            <Column
              key={column.status}
              id={columnId(null, column.status)}
              project={null}
              status={column.status}
              items={column.items}
              laneAllowed
              statusAllowed={!dragging || canTransition(dragging.status, column.status)}
              selected={selected}
              onSelect={onSelect}
              dragging={dragging}
            />
          ))}
        </div>
      )}

      {/*
       * Reveals the columns `statuses` left out, for the one operation that must
       * survive their being hidden: closing a card. `position: fixed` rather than
       * temporarily widening `statuses` — see `hiddenReachable` — so nothing the
       * live columns already occupy reflows out from under the pointer mid-drag,
       * the same failure `useEffect` above guards against for `grouped`.
       *
       * Absent, not merely empty, when nothing qualifies: a card in To do reaches
       * neither Done nor Disregarded, and an empty bar inviting a drop it would
       * refuse is worse than no bar.
       */}
      {dragging && hiddenReachable.length > 0 && (
        <div className="board-drop-strip">
          {hiddenReachable.map((status) => (
            <DropStripZone key={status} status={status} />
          ))}
        </div>
      )}

      <DragOverlay dropAnimation={null}>
        {dragging && <Card item={dragging} selected={false} overlay />}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * What a drop landed on, carried *on* the droppable rather than encoded in its id.
 *
 * dnd-kit hands `data` back on the drop event, so the alternative — parsing
 * `column:PROJ:status` back apart — would have rested on a comment asserting that
 * no project key or status value ever contains the separator. The id stays a
 * composite string, but only so it is unique; nothing reads it.
 */
type DropTarget =
  | { kind: "column"; project: string | null; status: Status }
  | { kind: "card"; item: Item };

/** Unique per lane and status. Opaque — see DropTarget. */
const columnId = (project: string | null, status: Status): string =>
  `column:${project ?? "*"}:${status}`;

/**
 * One zone in the drag-time drop strip, standing in for a column `statuses`
 * hid. `project: null` in its `DropTarget` — the same value the ungrouped board
 * uses — is what lets `onDragEnd`'s existing column branch handle a drop here
 * with no new logic: a transition never moves an item between projects, so
 * skipping the lane check is correct regardless of which project the dragged
 * card actually belongs to.
 */
function DropStripZone({ status }: { status: Status }): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `dropstrip:${status}`,
    data: { kind: "column", project: null, status } satisfies DropTarget,
  });

  return (
    <div
      className={`board-drop-zone ${isOver ? "board-drop-zone-over" : ""}`}
      ref={setNodeRef}
    >
      <span className="dot" style={{ background: `var(--${status})` }} />
      {STATUS_LABELS[status]}
    </div>
  );
}

function Column({
  id,
  project,
  status,
  items,
  laneAllowed,
  statusAllowed,
  compact,
  selected,
  onSelect,
  dragging,
}: {
  id: string;
  /** The lane this column sits in. Null ungrouped, where there is only one. */
  project: string | null;
  status: Status;
  items: Item[];
  /** Whether this column's band takes the card in flight at all. */
  laneAllowed: boolean;
  /** Whether the card in flight can legally reach this status. */
  statusAllowed: boolean;
  /**
   * Grouped mode: no header of its own and no empty note. The header row above
   * every lane already names the column, and repeating "nothing here" across six
   * columns times every project is noise — the dimming says what a lane refuses.
   */
  compact?: boolean;
  selected: string | null;
  onSelect: (key: string) => void;
  dragging: Item | null;
}): React.JSX.Element {
  const allowed = laneAllowed && statusAllowed;
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { kind: "column", project, status } satisfies DropTarget,
    disabled: !allowed,
  });

  return (
    <section
      // Only the status refusal dims here. A refused *lane* is dimmed as a whole
      // by .lane-blocked, and two nested opacities would multiply to 0.16.
      className={`column ${dragging && laneAllowed && !statusAllowed ? "column-blocked" : ""} ${
        isOver && allowed ? "column-over" : ""
      }`}
      ref={setNodeRef}
    >
      {!compact && (
        <header className="column-head">
          <span className="dot" style={{ background: `var(--${status})` }} />
          {STATUS_LABELS[status]}
          <span className="column-count">{items.length}</span>
        </header>
      )}
      <div className="column-body">
        {items.map((item) => (
          <DraggableCard
            key={item.key}
            item={item}
            selected={item.key === selected}
            onSelect={onSelect}
            dropDisabled={!laneAllowed}
          />
        ))}
        {items.length === 0 && !compact && (
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
  dropDisabled,
}: {
  item: Item;
  selected: boolean;
  onSelect: (key: string) => void;
  /**
   * Disabling the lane's column droppable does not disable the cards in it. Left
   * enabled, a card dropped onto a card in a refused lane would still fire a
   * legal transition — the item jumping status while the lane under the cursor
   * was dimmed.
   */
  dropDisabled: boolean;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: item.key });
  const { setNodeRef: setDropRef } = useDroppable({
    id: item.key,
    data: { kind: "card", item } satisfies DropTarget,
    disabled: dropDisabled,
  });

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
