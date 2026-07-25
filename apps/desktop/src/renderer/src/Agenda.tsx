import { useEffect, useState } from "react";
import type { Item } from "todo-vault";
import type { AgendaScope, AgendaView } from "@shared/api";
import { Cadence, PriorityMark, StatusPill } from "./pieces";

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
  recurring: "Comes round again in this window. No deadline attached — the date shown, if any, is its own.",
};

export function Agenda({
  scope,
  items,
  selected,
  onSelect,
}: {
  scope: AgendaScope;
  items: Item[];
  selected: string | null;
  onSelect: (key: string) => void;
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

  if (error) return <div className="empty">{error}</div>;
  if (!sections) return <div className="empty">Working out the agenda…</div>;

  const byKey = new Map(items.map((i) => [i.key, i]));
  const populated = sections.filter((s) => s.keys.length > 0);

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
                  {item.dueDate && <span className="section-range">{item.dueDate}</span>}
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
