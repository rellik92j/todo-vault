import type { EntryChange, FieldChange, FileChange, HistoryEntry } from "todo-vault";

/**
 * The pure half of the History view: labels, truncation, and the day grouping.
 *
 * Split out of History.tsx because `apps/desktop/test` runs plain `tsx --test`
 * with no Electron and no DOM, so this is the seam where the rendering rules can
 * actually be asserted. The component itself is left with layout only.
 */

/** Shown where a field was not present on one side of the change. */
export const ABSENT = "—";

/**
 * Field names that read badly raw. Anything not listed keeps its schema name,
 * which is deliberate — the frontmatter is a file people also edit by hand, and
 * inventing a display name for every field would make the log and the file
 * disagree about what things are called.
 */
const FIELD_LABELS: Record<string, string> = {
  dueDate: "due",
  startDate: "start",
  "sync.state": "sync",
  "sync.jiraKey": "jira key",
  "sync.jiraId": "jira id",
  "sync.lastPushedAt": "pushed",
  jiraProjectKey: "jira project",
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function displayValue(value: string | undefined): string {
  return value === undefined || value === "" ? ABSENT : value;
}

/** One field change as a single line, for titles and the compact detail list. */
export function changeLine(change: FieldChange): string {
  return `${fieldLabel(change.field)} ${displayValue(change.before)} → ${displayValue(change.after)}`;
}

/**
 * The description row's collapsed label. Null means there is nothing to show —
 * the caller uses that to decide whether the row is a button at all.
 */
export function bodySummary(file: FileChange): string | null {
  if (!file.body) return null;
  if (file.body.truncated) return "Description edited";
  return `Description edited  +${file.body.added} −${file.body.removed}`;
}

/** One entry-level change as a single line, for the expanded field detail. */
export function entryLine(change: EntryChange): string {
  if (change.op === "added") return `+ ${change.after}`;
  if (change.op === "removed") return `− ${change.before}`;
  return `${change.before} → ${change.after}`;
}

export function truncate(text: string, max = 80): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The badge a row carries, or nothing at all for an ordinary edit. */
export function kindBadge(kind: FileChange["kind"]): string | null {
  return kind === "modified" || kind === "renamed" ? null : kind;
}

/**
 * What to say when a file changed but produced no field lines.
 *
 * The common case is real and worth naming: the app rewrites `updated` on every
 * save, so a commit can touch a file without changing anything a person would
 * recognise. Saying "touched, no visible change" is better than a row that
 * looks truncated.
 */
export function fallbackNote(file: FileChange): string | null {
  if (file.fields.length > 0) return null;
  if (file.unparsed === "binary") return "binary file";
  if (file.unparsed === "partial") return "changed — too large to summarise";
  if (file.unparsed === "unparsable") return "changed — the file did not parse";
  if (file.bodyChanged) return null; // the description line covers it
  if (kindBadge(file.kind)) return null; // created / trashed / restored says it
  return "touched, no visible change";
}

/** `2026-08-04T09:50:12+01:00` → `09:50`. */
export function timeOfDay(at: string): string {
  return at.slice(11, 16);
}

/** `2026-08-04T09:50:12+01:00` → `2026-08-04`. */
export function dayOf(at: string): string {
  return at.slice(0, 10);
}

export interface HistoryDay {
  day: string;
  entries: HistoryEntry[];
}

/**
 * Commits bucketed by calendar day, order preserved.
 *
 * Not a sort: `git log` already returns newest first, and re-sorting here would
 * quietly disagree with git about ordering within a second.
 */
export function groupByDay(entries: HistoryEntry[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  for (const entry of entries) {
    const day = dayOf(entry.at);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}
