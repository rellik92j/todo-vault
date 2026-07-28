import { z } from "zod";

import {
  CADENCES,
  ITEM_KEY_RE,
  ITEM_TYPES,
  LINK_TYPES,
  PRIORITIES,
  PROJECT_KEY_RE,
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

export const ItemFrontmatterSchema = z
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
    startDate: isoDate.optional(),
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
  })
  .strict()
  .superRefine((v, ctx) => {
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
  });

export type ItemFrontmatter = z.infer<typeof ItemFrontmatterSchema>;

/** An item is its frontmatter plus the markdown body, which is the description. */
export type Item = ItemFrontmatter & { description: string };

export const ProjectSchema = z
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
  })
  .strict();

export type ProjectFrontmatter = z.infer<typeof ProjectSchema>;
export type Project = ProjectFrontmatter & { description: string };

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

export const ItemFilter = z
  .object({
    project: projectKey.optional(),
    type: z.enum(ITEM_TYPES).optional(),
    status: z.union([z.enum(STATUSES), z.array(z.enum(STATUSES))]).optional(),
    priority: z.enum(PRIORITIES).optional(),
    cadence: z.enum(CADENCES).optional(),
    category: z.string().optional(),
    label: z.string().optional(),
    assignee: z.string().optional(),
    parent: itemKey.optional(),
    dueBefore: isoDate.optional(),
    dueAfter: isoDate.optional(),
    open: z.boolean().optional().describe("true = exclude done items"),
    text: z.string().optional().describe("Case-insensitive match on summary and description"),
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
