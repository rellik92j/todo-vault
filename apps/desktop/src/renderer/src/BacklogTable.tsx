import type { Item } from "todo-vault";
import { isTickedFor, todayIso } from "todo-vault/recurrence";
import { Cadence, DueDate, PriorityMark, StatusPill } from "./pieces";
import { backlogOrder } from "./ordering";

/**
 * The backlog, in work order — the derived one: unfinished first, then due date,
 * then priority. That answers "what should I look at next", which is what a
 * backlog is for. Manual rank belongs to the board.
 *
 * Children are nested under their parent so the hierarchy is visible without a
 * tree widget, but only when the parent is in the filtered set; otherwise an
 * orphaned child would silently disappear from view.
 *
 * Which subtrees are collapsed is not this component's to know: the keyboard
 * cursor walks the same order, and a table that hid rows privately would put
 * the highlight somewhere off screen. It comes in as a prop.
 */
export function BacklogTable({
  items,
  collapsed,
  onToggleCollapse,
  selected,
  onSelect,
}: {
  items: Item[];
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (key: string) => void;
  selected: string | null;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  if (!items.length) {
    return <div className="empty">Nothing matches these filters.</div>;
  }

  const ordered = backlogOrder(items, collapsed);

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Type</th>
          <th>Summary</th>
          <th>Status</th>
          <th>Priority</th>
          <th>Due</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        {ordered.map(({ item, depth, hasChildren }) => (
          <tr
            key={item.key}
            aria-selected={item.key === selected}
            onClick={() => onSelect(item.key)}
          >
            <td className="cell-key">{item.key}</td>
            <td className="type">{item.type}</td>
            <td className="cell-summary" title={item.summary}>
              {depth > 0 && <span className="indent">{"　".repeat(depth)}└ </span>}
              {hasChildren ? (
                <button
                  type="button"
                  className="twisty"
                  aria-expanded={!collapsed.has(item.key)}
                  aria-label={`${collapsed.has(item.key) ? "Expand" : "Collapse"} ${item.key}`}
                  // The row is itself a click target, so without this a twisty
                  // would also move the cursor and open the panel.
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleCollapse(item.key);
                  }}
                >
                  {collapsed.has(item.key) ? "▸" : "▾"}
                </button>
              ) : (
                // A leaf gets the same width back as blank space; without it
                // the summaries of siblings sit at two different offsets.
                <span className="twisty-gap" />
              )}
              {item.summary}
            </td>
            <td>
              <StatusPill status={item.status} />
            </td>
            <td>
              <PriorityMark priority={item.priority} />
            </td>
            <td className="cell-num">
              <DueDate item={item} />
            </td>
            <td className="cell-num">
              {item.category ?? ""}{" "}
              <Cadence cadence={item.cadence} ticked={isTickedFor(item, todayIso())} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
