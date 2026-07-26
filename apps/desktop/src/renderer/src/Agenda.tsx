import { useEffect, useMemo, useState } from "react";
import type { Item } from "todo-vault";
import type { AgendaScope, AgendaView } from "@shared/api";
import { AgendaDueDate, Cadence, PriorityMark, StatusPill } from "./pieces";

const HEADINGS: Record<AgendaView["kind"], (scope: AgendaScope) => string> = {
  overdue: () => "Overdue",
  due: (scope) => (scope === "today" ? "Due today" : `Due this ${scope}`),
  recurring: (scope) => (scope === "today" ? "Recurring today" : `Recurring this ${scope}`),
};

/**
 * The point of the section split: recurring work has no deadline, so it is not
 * "due". Each note says what the section actually means, because "Due this week"
 * and "Recurring this week" sitting next to each other otherwise look like the
 * same claim twice.
 */
const NOTES: Record<AgendaView["kind"], string> = {
  overdue: "Past its due date and not finished. Listed here only, so nothing is counted twice.",
  due: "Has a due date landing inside this window.",
  // The row itself now labels any date it carries, so this no longer has to
  // explain the date — only what earns an item its place in the section.
  recurring: "Comes round again in this window. Recurrence is a schedule, not a deadline.",
};

export function Agenda({
  scope,
  items,
  selected,
  onSelect,
  onOrder,
}: {
  scope: AgendaScope;
  items: Item[];
  selected: string | null;
  onSelect: (key: string) => void;
  /** Reports the flat, visible key order so the parent can drive keyboard navigation. */
  onOrder?: (keys: string[]) => void;
}): React.JSX.Element {
  const [sections, setSections] = useState<AgendaView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Recomputed when the scope changes or the snapshot does: the window depends on
  // today's date, so it belongs in the core rather than being derived here.
  useEffect(() => {
    let live = true;
    void window.vault.getAgenda(scope).then((result) => {
      if (!live) return;
      if (result.ok) {
        setSections(result.value);
        setError(null);
      } else {
        setError(result.message);
      }
    });
    return () => {
      live = false;
    };
  }, [scope, items]);

  const byKey = useMemo(() => new Map(items.map((i) => [i.key, i])), [items]);

  /**
   * Sections narrowed to the keys this view will actually draw.
   *
   * The core builds the agenda over the whole vault, so a key can come back
   * that is not in `items`: one deleted since the call, or one belonging to a
   * project the window is hiding. The render already skipped those. Narrowing
   * here too means the header count matches the rows beneath it, and a section
   * emptied by the filtering disappears rather than drawing an empty box under
   * its own heading.
   */
  const populated = useMemo(
    () =>
      (sections ?? [])
        .map((section) => ({ ...section, keys: section.keys.filter((key) => byKey.has(key)) }))
        .filter((section) => section.keys.length > 0),
    [sections, byKey],
  );

  /**
   * The keys actually on screen, in display order — what `j`/`k` walk. A cursor
   * that stops on a row that is not there is worse than no cursor at all.
   */
  const visibleKeys = useMemo(
    () => populated.flatMap((section) => section.keys),
    [populated],
  );

  const orderKey = visibleKeys.join("\n");
  useEffect(() => {
    onOrder?.(visibleKeys);
    // Keyed on the joined string, not on `visibleKeys` or `onOrder`. Both are
    // fresh objects on most renders — the parent passes an inline arrow — so
    // depending on either would fire this every render and loop through the
    // parent's state update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  if (error) return <div className="empty">{error}</div>;
  if (!sections) return <div className="empty">Working out the agenda…</div>;
  if (!populated.length) {
    return <div className="empty">Nothing due or recurring in this window.</div>;
  }

  return (
    <div className="agenda">
      {populated.map((section) => (
        <section key={`${section.kind}-${section.scope}`}>
          <header className="section-head">
            <h2 className="section-title">{HEADINGS[section.kind](section.scope)}</h2>
            {section.kind !== "overdue" && section.from && (
              <span className="section-range">
                {section.from} → {section.to}
              </span>
            )}
            <span className="section-range">
              {section.keys.length} item{section.keys.length === 1 ? "" : "s"}
            </span>
          </header>
          <p className="section-note">{NOTES[section.kind]}</p>
          <div className="rows">
            {section.keys.map((key) => {
              const item = byKey.get(key);
              if (!item) return null;
              return (
                <button
                  type="button"
                  className="row"
                  key={key}
                  aria-selected={key === selected}
                  onClick={() => onSelect(key)}
                >
                  <span className="cell-key">{item.key}</span>
                  <span className="row-summary">{item.summary}</span>
                  <Cadence cadence={item.cadence} />
                  <AgendaDueDate item={item} section={section} />
                  <PriorityMark priority={item.priority} />
                  <StatusPill status={item.status} />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
