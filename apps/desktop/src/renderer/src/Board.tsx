import type { Item } from "todo-vault";
import { BOARD_ORDER, Cadence, STATUS_LABELS, isOverdue } from "./pieces";

/**
 * Status columns, each in manual rank order.
 *
 * Read with rank order rather than work order, because a column shows the
 * sequence you arranged, not what is most urgent. Items with no rank fall to the
 * bottom of their column.
 */
export function Board({
  items,
  selected,
  onSelect,
}: {
  items: Item[];
  selected: string | null;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const columns = BOARD_ORDER.map((status) => ({
    status,
    items: items
      .filter((i) => i.status === status)
      .sort((a, b) => {
        if (a.rank !== undefined && b.rank !== undefined) return a.rank - b.rank;
        if (a.rank !== undefined) return -1;
        if (b.rank !== undefined) return 1;
        return a.key.localeCompare(b.key, undefined, { numeric: true });
      }),
  }));

  return (
    <div className="board">
      {columns.map((column) => (
        <section className="column" key={column.status}>
          <header className="column-head">
            <span className="dot" style={{ background: `var(--${column.status})` }} />
            {STATUS_LABELS[column.status]}
            <span className="column-count">{column.items.length}</span>
          </header>
          <div className="column-body">
            {column.items.map((item) => (
              <button
                type="button"
                className="card"
                key={item.key}
                aria-selected={item.key === selected}
                onClick={() => onSelect(item.key)}
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
                      <span className={isOverdue(item) ? "due-overdue" : undefined}>
                        {item.dueDate}
                      </span>
                    )}
                    <Cadence cadence={item.cadence} />
                    {item.labels.slice(0, 2).map((label) => (
                      <span className="label" key={label}>
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            ))}
            {column.items.length === 0 && (
              <div style={{ padding: "10px 2px", color: "var(--text-faint)", fontSize: 11.5 }}>
                nothing here
              </div>
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
