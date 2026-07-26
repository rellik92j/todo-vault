/**
 * The enums, the workflow table, and the key formats — with no imports at all.
 *
 * Split out of schema.ts so the desktop renderer can use the real values instead
 * of its own copy. Importing them from schema.ts would pull in zod, and importing
 * them from the package root would pull in vault.ts and with it node:fs,
 * node:crypto and node:child_process — none of which can be bundled for a
 * browser context. Exposed as `todo-vault/constants`.
 *
 * Nothing in this file may import anything. That is the whole point of it.
 */

export const ITEM_TYPES = ["epic", "story", "task", "bug", "subtask"] as const;
export const STATUSES = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "disregard",
] as const;
export const PRIORITIES = ["highest", "high", "medium", "low", "lowest"] as const;
export const CADENCES = ["daily", "weekly", "monthly", "quarterly", "none"] as const;
export const LINK_TYPES = ["url", "file", "folder", "item", "outlook", "note"] as const;
export const SYNC_STATES = ["never", "pending", "pushed", "drifted"] as const;

export type ItemType = (typeof ITEM_TYPES)[number];
export type Status = (typeof STATUSES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type Cadence = (typeof CADENCES)[number];

/**
 * Statuses that mean "no longer needs attention".
 *
 * `disregard` is finished work's other ending: the item is closed because it
 * will not be done, rather than because it was. Everything that asks "is this
 * still live" reads this array — the `open` filter, the agenda, and both sort
 * comparators — so the two statuses part company only where the difference is
 * the point, which is the board, the reports, and the Jira mapping.
 */
export const DONE_STATUSES: readonly Status[] = ["done", "disregard"];

/**
 * Allowed status transitions. Kept deliberately permissive except that
 * nothing jumps straight from todo to done without passing through work,
 * which is what makes the daily/weekly rollups meaningful.
 *
 * `disregard` is reachable from everywhere, including `blocked` and `done`,
 * which is looser than `done`'s own row. That is deliberate: the reason
 * `todo -> in_review` and `blocked -> done` are refused is rollup integrity —
 * they would claim work happened that did not. Disregarding is the decision not
 * to do something at all, and blocked work is the likeliest candidate for it,
 * so routing it back through `todo` first would be friction with no story
 * behind it.
 */
export const TRANSITIONS: Record<Status, readonly Status[]> = {
  todo: ["in_progress", "blocked", "done", "disregard"],
  in_progress: ["in_review", "blocked", "done", "todo", "disregard"],
  in_review: ["in_progress", "done", "blocked", "disregard"],
  blocked: ["todo", "in_progress", "disregard"],
  done: ["todo", "in_progress", "disregard"],
  disregard: ["todo", "in_progress", "done"],
};

/** Item keys look like PROJ-42. Project keys look like PROJ. */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
export const ITEM_KEY_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;

/**
 * Frontmatter key order. Fixed so that every write produces a stable file and
 * git diffs show only what actually changed.
 */
export const FRONTMATTER_ORDER: readonly string[] = [
  "id",
  "key",
  "project",
  "type",
  "summary",
  "status",
  "priority",
  "parent",
  "category",
  "labels",
  "components",
  "assignee",
  "reporter",
  "startDate",
  "dueDate",
  "estimate",
  "cadence",
  "rank",
  "links",
  "attachments",
  "comments",
  "sync",
  "created",
  "updated",
];

export const PROJECT_FRONTMATTER_ORDER: readonly string[] = [
  "key",
  "name",
  "category",
  "lead",
  "status",
  "rank",
  "startDate",
  "dueDate",
  "jiraProjectKey",
  "created",
  "updated",
];
