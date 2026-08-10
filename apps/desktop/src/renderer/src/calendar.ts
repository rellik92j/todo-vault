import type { Item } from "todo-vault";
import { PRIORITIES } from "todo-vault/constants";
import { addDays, endOfMonth, startOfMonth } from "todo-vault/recurrence";

export interface CalendarDay {
  date: string; // YYYY-MM-DD
  inMonth: boolean; // false for the leading/trailing days of adjacent months
  isToday: boolean;
  items: Item[];
}

/** Most-urgent-first, the same table `PRIORITIES` already declares. */
const PRIORITY_RANK = new Map(PRIORITIES.map((p, index) => [p, index]));

/**
 * Priority, then key — the comparator `boardColumns` uses for its within-status
 * tie-break, applied here because a shared date cannot order two items the way
 * a shared status column already does.
 */
function compareWithinDay(a: Item, b: Item): number {
  const byPriority =
    (PRIORITY_RANK.get(a.priority) ?? PRIORITIES.length) -
    (PRIORITY_RANK.get(b.priority) ?? PRIORITIES.length);
  if (byPriority !== 0) return byPriority;
  return a.key.localeCompare(b.key, undefined, { numeric: true });
}

/**
 * Sunday on or before `dateIso` — the grid's own week anchor.
 *
 * Deliberately not `startOfWeek` from `recurrence.ts`: that one is
 * Monday-anchored, because the agenda's week bands and a weekly cadence's
 * period both need to agree with it. Neither of those is a grid — the agenda
 * states a week as a `from`/`to` range in prose, and a cadence period is never
 * drawn as columns — so there is no second consumer for this grid's anchor to
 * agree with, and it is free to follow the calendar convention instead.
 */
function sundayOnOrBefore(dateIso: string): string {
  const dow = new Date(`${dateIso}T00:00:00`).getDay();
  return addDays(dateIso, -dow);
}

/**
 * The weeks a month view draws: Sunday-anchored, running from the start of the
 * week containing the 1st to the end of the week containing the last day, so
 * the grid is always a whole number of 7-day rows.
 *
 * `today` is injected rather than read from the clock, the same discipline
 * `isTickedFor` and `isOverdue` already use, so the tests below are not
 * date-dependent.
 */
export function monthGrid(month: string, items: Item[], today: string): CalendarDay[] {
  const first = `${month}-01`;
  const gridStart = sundayOnOrBefore(first);
  const gridEnd = addDays(sundayOnOrBefore(endOfMonth(first)), 6);

  const byDate = new Map<string, Item[]>();
  for (const item of items) {
    if (!item.dueDate) continue;
    const list = byDate.get(item.dueDate);
    if (list) list.push(item);
    else byDate.set(item.dueDate, [item]);
  }

  const days: CalendarDay[] = [];
  for (let date = gridStart; date <= gridEnd; date = addDays(date, 1)) {
    days.push({
      date,
      inMonth: date.slice(0, 7) === month,
      isToday: date === today,
      items: (byDate.get(date) ?? []).slice().sort(compareWithinDay),
    });
  }
  return days;
}

/** The previous or next month, as a `YYYY-MM` string. */
export function stepMonth(month: string, delta: -1 | 1): string {
  const first = `${month}-01`;
  const target =
    delta === 1
      ? startOfMonth(addDays(endOfMonth(first), 1))
      : startOfMonth(addDays(startOfMonth(first), -1));
  return target.slice(0, 7);
}
