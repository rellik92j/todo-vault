import { z } from "zod";

import {
  CADENCES,
  ITEM_KEY_RE,
  ITEM_TYPES,
  LINK_TYPES,
  PRIORITIES,
  PROJECT_KEY_RE,
  SCRATCH_ID_RE,
  STATUSES,
  SYNC_STATES,
} from "./constants.js";

/**
 * The single source of truth for the vault data model.
 * Field names deliberately mirror Jira's so the export is a mapping, not a translation.
 *
 * The enums, the transition table and the key formats live in constants.ts,
 * which imports nothing, so the desktop renderer can use the same values without
 * dragging zod or node:fs into a browser bundle. Re-exported here so every
 * existing consumer still gets them from this module.
 */
export * from "./constants.js";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a plain calendar date, e.g. 2026-08-14");

const isoDateTime = z.string().datetime({ offset: true });

export const projectKey = z
  .string()
  .regex(PROJECT_KEY_RE, "Project keys are 2-10 uppercase letters/digits, e.g. ACME");

export const itemKey = z
  .string()
  .regex(ITEM_KEY_RE, "Item keys look like ACME-42");

export const LinkSchema = z
  .object({
    type: z.enum(LINK_TYPES).describe("What kind of thing is on the other end"),
    target: z
      .string()
      .min(1)
      .describe(
        "URL, absolute or vault-relative file path, another item key, or an outlook: deep link",
      ),
    label: z.string().max(200).optional().describe("Human label shown in the UI"),
    addedAt: isoDateTime.optional(),
  })
  .strict();

export const AttachmentSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("Path relative to the vault root, under attachments/<key>/"),
    title: z.string().max(200).optional(),
    bytes: z.number().int().nonnegative().optional(),
    addedAt: isoDateTime.optional(),
  })
  .strict();

export const CommentSchema = z
  .object({
    author: z.string().min(1).default("me"),
    at: isoDateTime,
    body: z.string().min(1),
  })
  .strict();

/**
 * Everything the vault knows about this item's relationship to a Jira instance.
 * `key` (ours) and `sync.jiraKey` (theirs) are never the same field — an item
 * can exist locally forever without a Jira counterpart.
 */
export const SyncSchema = z
  .object({
    jiraKey: z.string().optional(),
    jiraId: z.string().optional(),
    lastPushedAt: isoDateTime.optional(),
    contentHash: z
      .string()
      .optional()
      .describe("Hash of the pushed content, used to detect local drift since the push"),
    state: z.enum(SYNC_STATES).default("never"),
  })
  .strict();

/**
 * A frontmatter key named `description` is an error, not a field kept for a
 * newer build. The body is the description, so the loader would overwrite the
 * key with the body and the next save would drop it: text lost without anyone
 * having seen it. No build writes this key. It arrives from a hand edit, often
 * copied from tools (Jekyll, Hugo, Obsidian) that do keep a description in
 * frontmatter. Rejecting it puts the file in `load().errors`, where the desktop
 * banner and `vault doctor` show it, and a build never rewrites a file it could
 * not load. The write paths strip `description` from an `Item` or `Project`
 * before they parse, so this only ever fires on a file read from disk.
 */
function rejectDescriptionKey(v: Record<string, unknown>, ctx: z.RefinementCtx): void {
  if (Object.hasOwn(v, "description")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["description"],
      message: "description is the body, not a frontmatter field",
    });
  }
}

/**
 * The fields this build knows an item to have. Kept separate from the schema
 * below so the exported type is this exact field list: `passthrough()` would
 * add an index signature to the inferred type, and then `item.dueDtae` would
 * compile everywhere, desktop included.
 */
const ItemFrontmatterShape = z
  .object({
    id: z.string().uuid().describe("Stable identity, survives renames and key changes"),
    key: itemKey,
    project: projectKey,
    type: z.enum(ITEM_TYPES),
    summary: z.string().min(1).max(255).describe("Jira's name for the title"),
    status: z.enum(STATUSES).default("todo"),
    priority: z.enum(PRIORITIES).default("medium"),
    parent: itemKey.optional().describe("Epic link for stories/tasks, parent task for subtasks"),
    category: z
      .string()
      .max(60)
      .optional()
      .describe("Your own grouping; maps to a Jira label or custom field on push"),
    labels: z.array(z.string().max(60)).default([]),
    components: z.array(z.string().max(60)).default([]),
    assignee: z.string().max(120).optional(),
    reporter: z.string().max(120).optional(),
    startDate: isoDate
      .optional()
      .describe(
        "Written by the app when an item moves into in_progress, unless it already has a value — the converse of completions, which a status change never touches. Skipped rather than clamped when today would fall after dueDate, so the stamp can never be why a transition fails.",
      ),
    dueDate: isoDate.optional(),
    estimate: z
      .number()
      .nonnegative()
      .optional()
      .describe("Story points or hours, whatever your jira-map says it maps to"),
    cadence: z.enum(CADENCES).default("none").describe("Local only — drives the agenda views"),
    completions: z
      .array(isoDate)
      .default([])
      .describe(
        "Local only — dates this recurring item was ticked off. Written by tick/untick, never by a status change: a cadence item stays in its own status while its completions accumulate.",
      ),
    rank: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Manual sort position within the project. Sparse by design — gaps of ~1000 — so a drag rewrites one file. Local only.",
      ),
    links: z.array(LinkSchema).default([]),
    attachments: z.array(AttachmentSchema).default([]),
    comments: z.array(CommentSchema).default([]),
    sync: SyncSchema.default({ state: "never" }),
    created: isoDateTime,
    updated: isoDateTime,
  });

/**
 * Passthrough rather than strict, so a field this build does not know is kept
 * rather than rejected. The desktop app and the MCP servers routinely run
 * different builds against one vault. Strict made an older build drop every
 * item a newer one had given a new field from every view, and refuse to write
 * it. Passthrough keeps the field on the parsed object, every write spreads the
 * stored item, and `serializeFrontmatter` writes keys it does not know after
 * the known ones, so the field survives a save. `unknownFrontmatterKeys`
 * names them, which is how `vault doctor` catches a misspelled hand edit.
 *
 * Only the top level. Links, attachments, comments and sync stay strict (TV-11).
 *
 * One unknown key is still rejected: `description`. See `rejectDescriptionKey`.
 */
export const ItemFrontmatterSchema = ItemFrontmatterShape.passthrough().superRefine(
  (v, ctx) => {
    rejectDescriptionKey(v, ctx);
    if (v.type === "epic" && v.parent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent"],
        message: "Epics sit at the top of the hierarchy and cannot have a parent",
      });
    }
    if (v.type === "subtask" && !v.parent) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent"],
        message: "Subtasks must name a parent item",
      });
    }
    if (v.parent && v.parent === v.key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["parent"],
        message: "An item cannot be its own parent",
      });
    }
    if (v.startDate && v.dueDate && v.startDate > v.dueDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dueDate"],
        message: `Due date ${v.dueDate} falls before start date ${v.startDate}`,
      });
    }
    if (!v.key.startsWith(`${v.project}-`)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["key"],
        message: `Key ${v.key} does not belong to project ${v.project}`,
      });
    }
  },
);

export type ItemFrontmatter = z.infer<typeof ItemFrontmatterShape>;

/** An item is its frontmatter plus the markdown body, which is the description. */
export type Item = ItemFrontmatter & { description: string };

/** The fields this build knows a project to have. Split out for the same reason as items. */
const ProjectShape = z
  .object({
    key: projectKey,
    name: z.string().min(1).max(200),
    category: z.string().max(60).optional(),
    lead: z.string().max(120).optional(),
    startDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    status: z.enum(["active", "on_hold", "complete", "archived"]).default("active"),
    rank: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        "Manual position in the project list. Sparse by design — gaps of ~1000. Local only.",
      ),
    jiraProjectKey: z
      .string()
      .optional()
      .describe("Target project in Jira, if this one is ever pushed"),
    created: isoDateTime,
    updated: isoDateTime,
  });

/**
 * Passthrough for the same reason as `ItemFrontmatterSchema`, and rejects a
 * `description` key for the same reason too.
 */
export const ProjectSchema = ProjectShape.passthrough().superRefine(rejectDescriptionKey);

export type ProjectFrontmatter = z.infer<typeof ProjectShape>;
export type Project = ProjectFrontmatter & { description: string };

/**
 * Keys in a file's raw frontmatter that this build does not know, in the order
 * they appear. Not errors: a newer build may have written them, and they are
 * kept on save. Reported by `vault doctor`, so that a misspelled field in a
 * hand-edited file, which would otherwise be kept and silently ignored, gets
 * noticed. Never lists `description`: in frontmatter that key is an error
 * (`rejectDescriptionKey`), and on an `Item` or `Project` it is the body.
 */
export function unknownFrontmatterKeys(
  kind: "item" | "project",
  data: Record<string, unknown>,
): string[] {
  const known = kind === "item" ? ItemFrontmatterShape.shape : ProjectShape.shape;
  return Object.keys(data).filter((k) => k !== "description" && !Object.hasOwn(known, k));
}

/**
 * A scratch note: `scratch/<id>.md`, this frontmatter, and the note's text as
 * the body. Not an item — no key, no project, nothing Jira ever sees.
 *
 * Passthrough rather than strict, like items and projects. The pad is the
 * likeliest place for a field to arrive later (a per-note monospace flag is
 * already planned), and an MCP server one version behind the app is a normal
 * state (SCHEMA.md). Strict would make that older reader drop every newer
 * note from the list; passthrough lets it show them.
 */
export const ScratchFrontmatterSchema = z
  .object({
    id: z.string().regex(SCRATCH_ID_RE, "A scratch note id is a UUID"),
    created: isoDateTime,
  })
  .passthrough();

export type ScratchNote = { id: string; created: string; text: string };

/**
 * Fields an update may touch. `key` is absent on purpose — changing it re-keys
 * every item in the project, so that goes through Vault.renameProject.
 */
export const UpdateProjectInput = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().optional(),
    category: z.string().max(60).nullable().optional(),
    lead: z.string().max(120).nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    status: z.enum(["active", "on_hold", "complete", "archived"]).optional(),
    jiraProjectKey: z.string().nullable().optional(),
    /** Normally set via Vault.moveProject, which keeps the gaps sane. Null clears it. */
    rank: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;

/** Input accepted when creating an item — the vault fills in the rest. */
export const CreateItemInput = z
  .object({
    project: projectKey,
    type: z.enum(ITEM_TYPES).default("task"),
    summary: z.string().min(1).max(255),
    description: z.string().default(""),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    parent: itemKey.optional(),
    category: z.string().max(60).optional(),
    labels: z.array(z.string().max(60)).optional(),
    components: z.array(z.string().max(60)).optional(),
    assignee: z.string().max(120).optional(),
    reporter: z.string().max(120).optional(),
    startDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    estimate: z.number().nonnegative().optional(),
    cadence: z.enum(CADENCES).optional(),
    links: z.array(LinkSchema).optional(),
  })
  .strict();

export type CreateItemInput = z.infer<typeof CreateItemInput>;

/** Fields an update is allowed to touch. Notably absent: id, key, created, sync. */
export const UpdateItemInput = z
  .object({
    summary: z.string().min(1).max(255).optional(),
    description: z.string().optional(),
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    type: z.enum(ITEM_TYPES).optional(),
    parent: itemKey.nullable().optional(),
    category: z.string().max(60).nullable().optional(),
    labels: z.array(z.string().max(60)).optional(),
    components: z.array(z.string().max(60)).optional(),
    assignee: z.string().max(120).nullable().optional(),
    reporter: z.string().max(120).nullable().optional(),
    startDate: isoDate.nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    estimate: z.number().nonnegative().nullable().optional(),
    cadence: z.enum(CADENCES).optional(),
    /** Normally set via Vault.moveItem, which keeps the gaps sane. Null clears it. */
    rank: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export type UpdateItemInput = z.infer<typeof UpdateItemInput>;

/**
 * The bulk-edit patch for the backlog table's multi-select. Deliberately
 * narrower than UpdateItemInput: summary/description are absent because
 * overwriting many items with one sentence is never the intent, type/parent
 * because their legality is per item, and rank because it belongs to
 * Vault.moveItem. labels carries a mode instead of replacing outright, since
 * "add this label to twelve items" must not silently drop what they had.
 */
export const BulkUpdateInput = z
  .object({
    status: z.enum(STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    assignee: z.string().max(120).nullable().optional(),
    reporter: z.string().max(120).nullable().optional(),
    dueDate: isoDate.nullable().optional(),
    labels: z
      .object({
        mode: z.enum(["add", "remove", "replace"]),
        values: z.array(z.string().max(60)),
      })
      .optional(),
  })
  .strict();

export type BulkUpdateInput = z.infer<typeof BulkUpdateInput>;

export const ItemFilter = z
  .object({
    project: projectKey.optional(),
    type: z.enum(ITEM_TYPES).optional(),
    status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES))]).optional(),
    priority: z.enum(PRIORITIES).optional(),
    cadence: z.enum(CADENCES).optional(),
    category: z.string().optional(),
    label: z.string().optional(),
    assignee: z
      .string()
      .optional()
      .describe(
        "Matched case-insensitively, so 'John Doe' and 'john doe' are one person — the app's assignee menu folds the same way and this has to agree with it.",
      ),
    reporter: z
      .string()
      .optional()
      .describe(
        "Matched case-insensitively, so 'John Doe' and 'john doe' are one person — the app's reporter menu folds the same way and this has to agree with it.",
      ),
    parent: itemKey.optional(),
    dueBefore: isoDate.optional(),
    dueAfter: isoDate.optional(),
    startBefore: isoDate
      .optional()
      .describe(
        "Items whose startDate is on or before this date. Like dueBefore, an item with no startDate never matches — ask for undated work by leaving this out, not by expecting it here.",
      ),
    startAfter: isoDate
      .optional()
      .describe("Items whose startDate is on or after this date. An item with no startDate never matches."),
    open: z.boolean().optional().describe("true = exclude done items"),
    text: z
      .string()
      .optional()
      .describe(
        "Case-insensitive match on summary, description, category, labels, reporter, and assignee",
      ),
    sort: z
      .enum(["work", "rank"])
      .default("work")
      .describe(
        "'work' orders by urgency (overdue, due date, priority) — right for a backlog. 'rank' honours the manual order set by dragging — right for a board column.",
      ),
    limit: z.number().int().min(1).max(500).default(100),
    offset: z.number().int().min(0).default(0),
  })
  .strict();

export type ItemFilter = z.infer<typeof ItemFilter>;

/* FRONTMATTER_ORDER and PROJECT_FRONTMATTER_ORDER now live in constants.ts and
   are re-exported above, so a new field is added in one place. */
