import { promises as fs } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

import { parseDescription, type Inline } from "./description.js";
import type { Item } from "./schema.js";
import type { Vault } from "./vault.js";
import { pushableFields } from "./vault.js";
import { contentHash, formatZodError } from "./util.js";

/**
 * One-way push to Jira.
 *
 * The vault is never a mirror of Jira — it is upstream of it. We generate a
 * payload, you review it, and only then does anything leave the machine.
 */

export const JiraMapSchema = z
  .object({
    jiraProjectKey: z.string().min(1).describe("Target project key in Jira, e.g. ENG"),
    baseUrl: z.string().url().optional(),
    issueTypes: z.object({
      epic: z.string().default("Epic"),
      story: z.string().default("Story"),
      task: z.string().default("Task"),
      bug: z.string().default("Bug"),
      subtask: z.string().default("Subtask"),
    }),
    priorities: z
      .record(z.string())
      .default({
        highest: "Highest",
        high: "High",
        medium: "Medium",
        low: "Low",
        lowest: "Lowest",
      }),
    /**
     * Custom field IDs, discovered from your instance rather than guessed.
     * Run `vault jira discover` against a live instance to fill these in —
     * start date in particular is a different customfield_NNNNN on every site.
     */
    fields: z
      .object({
        startDate: z.string().optional(),
        estimate: z.string().optional(),
        epicLink: z.string().optional().describe("Only needed on older company-managed projects"),
        category: z
          .string()
          .default("labels")
          .describe("'labels' to fold category into labels, or a customfield_NNNNN id"),
      })
      .default({ category: "labels" }),
    /** Fields your instance marks as required on the create screen. */
    defaults: z.record(z.unknown()).default({}),
    /** Local statuses to Jira transition names, applied after creation. */
    statusTransitions: z.record(z.string()).default({}),
  })
  .strict();

export type JiraMap = z.infer<typeof JiraMapSchema>;

export async function loadJiraMap(filePath: string): Promise<JiraMap> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    throw new Error(
      `No Jira mapping found at ${filePath}. Copy jira-map.example.yaml and fill in your instance's field IDs.`,
    );
  }
  try {
    return JiraMapSchema.parse(YAML.parse(raw));
  } catch (err) {
    throw new Error(`Jira mapping is invalid: ${formatZodError(err)}`);
  }
}

// ------------------------------------------------------- markdown to ADF

type AdfNode = { type: string; [key: string]: unknown };

function adfInline(nodes: Inline[]): AdfNode[] {
  return nodes.map((node) => {
    switch (node.kind) {
      case "link":
        return {
          type: "text",
          text: node.text,
          marks: [{ type: "link", attrs: { href: node.href } }],
        };
      case "code":
        return { type: "text", text: node.text, marks: [{ type: "code" }] };
      case "strong":
        return { type: "text", text: node.text, marks: [{ type: "strong" }] };
      case "em":
        return { type: "text", text: node.text, marks: [{ type: "em" }] };
      case "break":
        return { type: "hardBreak" };
      default:
        return { type: "text", text: node.text };
    }
  });
}

/**
 * Jira Cloud's v3 API takes Atlassian Document Format, not markdown.
 *
 * The grammar lives in description.ts, shared with the desktop app so the two
 * cannot disagree about what a description means; this is only the mapping onto
 * ADF's node names. Anything the grammar does not recognise arrives here as a
 * plain paragraph rather than failing the push.
 */
export function markdownToAdf(markdown: string): AdfNode {
  const content: AdfNode[] = parseDescription(markdown).map((block) => {
    switch (block.kind) {
      case "heading":
        return {
          type: "heading",
          attrs: { level: block.level },
          content: adfInline(block.content),
        };
      case "list":
        return {
          type: block.ordered ? "orderedList" : "bulletList",
          content: block.items.map((item) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: adfInline(item) }],
          })),
        };
      case "quote":
        return {
          type: "blockquote",
          content: [{ type: "paragraph", content: adfInline(block.content) }],
        };
      case "code":
        return {
          type: "codeBlock",
          ...(block.language ? { attrs: { language: block.language } } : {}),
          // An ADF text node may not be empty, so an empty fence gets a space.
          content: [{ type: "text", text: block.text || " " }],
        };
      default:
        return { type: "paragraph", content: adfInline(block.content) };
    }
  });

  if (!content.length) {
    content.push({ type: "paragraph", content: [] });
  }
  return { type: "doc", version: 1, content };
}

// ------------------------------------------------------------- payload

export interface JiraIssueDraft {
  localKey: string;
  /** Set when this issue's parent is also in this batch and must be created first. */
  parentLocalKey?: string;
  fields: Record<string, unknown>;
}

export interface JiraPushPlan {
  jiraProjectKey: string;
  /** Ordered so that every parent is created before its children. */
  drafts: JiraIssueDraft[];
  attachments: Array<{ localKey: string; paths: string[] }>;
  skipped: Array<{ localKey: string; reason: string }>;
  warnings: string[];
}

export function buildPushPlan(items: Item[], map: JiraMap, vault: Vault): JiraPushPlan {
  const warnings: string[] = [];
  const skipped: Array<{ localKey: string; reason: string }> = [];
  const selected = new Map(items.map((i) => [i.key, i]));

  const eligible = items.filter((item) => {
    if (item.sync.state === "pushed") {
      const drifted =
        item.sync.contentHash &&
        contentHash(pushableFields(item)) !== item.sync.contentHash;
      if (!drifted) {
        skipped.push({
          localKey: item.key,
          reason: `Already pushed as ${item.sync.jiraKey} and unchanged since`,
        });
        return false;
      }
      warnings.push(
        `${item.key} has changed since it was pushed as ${item.sync.jiraKey}. This plan creates a NEW issue; update the existing one by hand if that is not what you want.`,
      );
    }
    return true;
  });

  // Epics before their children, subtasks last.
  const typeOrder: Record<string, number> = { epic: 0, story: 1, task: 1, bug: 1, subtask: 2 };
  const ordered = [...eligible].sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type] || a.key.localeCompare(b.key),
  );

  const drafts: JiraIssueDraft[] = [];
  const attachments: Array<{ localKey: string; paths: string[] }> = [];

  for (const item of ordered) {
    const fields: Record<string, unknown> = {
      ...map.defaults,
      project: { key: map.jiraProjectKey },
      issuetype: { name: map.issueTypes[item.type] },
      summary: item.summary,
      description: markdownToAdf(buildDescription(item, vault)),
    };

    const priority = map.priorities[item.priority];
    if (priority) fields.priority = { name: priority };

    const labels = [...item.labels];
    if (item.category) {
      if (map.fields.category === "labels") {
        labels.push(item.category.replace(/\s+/g, "-"));
      } else {
        fields[map.fields.category] = item.category;
      }
    }
    if (labels.length) fields.labels = labels;
    if (item.components.length) {
      fields.components = item.components.map((name) => ({ name }));
    }
    if (item.assignee) fields.assignee = { name: item.assignee };
    if (item.dueDate) fields.duedate = item.dueDate;

    if (item.startDate) {
      if (map.fields.startDate) {
        fields[map.fields.startDate] = item.startDate;
      } else {
        warnings.push(
          `${item.key} has a start date but jira-map.yaml has no fields.startDate. Run \`vault jira discover\` to find the custom field id for your instance.`,
        );
      }
    }
    if (item.estimate !== undefined && map.fields.estimate) {
      fields[map.fields.estimate] = item.estimate;
    }

    const draft: JiraIssueDraft = { localKey: item.key, fields };

    if (item.parent) {
      const parentItem = selected.get(item.parent) ?? safeGet(vault, item.parent);
      const parentJiraKey = parentItem?.sync.jiraKey;
      if (parentJiraKey) {
        fields.parent = { key: parentJiraKey };
      } else if (selected.has(item.parent)) {
        draft.parentLocalKey = item.parent;
      } else {
        warnings.push(
          `${item.key} has parent ${item.parent}, which is neither in this batch nor already in Jira. It will be created without a parent link.`,
        );
      }
    }

    drafts.push(draft);

    if (item.attachments.length) {
      attachments.push({
        localKey: item.key,
        paths: item.attachments.map((a) => a.path),
      });
    }
  }

  return { jiraProjectKey: map.jiraProjectKey, drafts, attachments, skipped, warnings };
}

/**
 * Appends a provenance footer so the Jira issue points back at the vault item.
 * Links that Jira cannot resolve (local file paths, Outlook deep links) go here
 * as text rather than being silently dropped.
 */
function buildDescription(item: Item, vault: Vault): string {
  const parts = [item.description.trim()];
  const notes: string[] = [];

  for (const link of item.links) {
    if (link.type === "url") {
      notes.push(`- [${link.label ?? link.target}](${link.target})`);
    } else if (link.type === "item") {
      notes.push(`- Related vault item: ${link.target}`);
    } else {
      notes.push(`- ${link.label ?? link.type}: \`${link.target}\``);
    }
  }
  if (notes.length) {
    parts.push("", "## Links", ...notes);
  }
  parts.push("", `_Tracked locally as ${item.key} in ${vault.root}_`);
  return parts.join("\n").trim();
}

function safeGet(vault: Vault, key: string): Item | undefined {
  try {
    return vault.getItem(key);
  } catch {
    return undefined;
  }
}

/**
 * CSV for Jira's built-in importer. Useful when you have no API token, or when
 * the target instance is behind a VPN you would rather not automate against.
 */
export function toJiraCsv(items: Item[], map: JiraMap): string {
  const headers = [
    "Issue Type",
    "Summary",
    "Description",
    "Priority",
    "Labels",
    "Components",
    "Due Date",
    "Parent",
    "Local Key",
  ];
  const rows = items.map((item) => [
    map.issueTypes[item.type],
    item.summary,
    item.description,
    map.priorities[item.priority] ?? "",
    item.labels.join(" "),
    item.components.join(" "),
    item.dueDate ?? "",
    item.parent ?? "",
    item.key,
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
