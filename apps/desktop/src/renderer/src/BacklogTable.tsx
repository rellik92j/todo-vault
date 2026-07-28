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
 */
export function BacklogTable({
  items,
  selected,
  onSelect,
}: {
  items: Item[];
  selected: string | null;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  if (!items.length) {
    return <div className="empty">Nothing matches these filters.</div>;
  }

  const ordered = backlogOrder(items);

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
        {ordered.map(({ item, depth }) => (
          <tr
            key={item.key}
            aria-selected={item.key === selected}
            onClick={() => onSelect(item.key)}
          >
            <td className="cell-key">{item.key}</td>
            <td className="type">{item.type}</td>
            <td className="cell-summary" title={item.summary}>
              {depth > 0 && <span className="indent">{"　".repeat(depth)}└ </span>}
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
