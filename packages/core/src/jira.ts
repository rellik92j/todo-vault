import { promises as fs } from "node:fs";
import YAML from "yaml";
import { z } from "zod";

import { parseDescription, type Block, type Inline } from "./description.js";
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

// ------------------------------------------------------ markdown to wiki

function wikiInline(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "strong":
          return `*${node.text}*`;
        case "em":
          return `_${node.text}_`;
        case "code":
          return `{{${node.text}}}`;
        case "link":
          return `[${node.text}|${node.href}]`;
        case "break":
          return "\n";
        default:
          return node.text;
      }
    })
    .join("");
}

/**
 * Blocks to Jira wiki markup — the third serializer over description.ts's
 * grammar, beside markdown (serializeDescription, for the app) and ADF
 * (markdownToAdf, for the REST API).
 *
 * This is what the CSV path needs. Jira Cloud stores descriptions as ADF, but
 * ADF is JSON and a CSV cell holding JSON imports as a cell holding JSON; the
 * importer's own conversion is from wiki markup. Without this step a
 * description arrives in Jira as the literal characters `## Heading` and
 * `- bullet`, which is what the export did before.
 *
 * Same closed subset as the other two, and the same failure mode: anything the
 * grammar does not recognise reaches here as a paragraph, so this can flatten
 * but not fail.
 */
export function blocksToWiki(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          // Wiki markup defines h1..h6 and nothing beyond it.
          return `h${Math.min(block.level, 6)}. ${wikiInline(block.content)}`;
        case "list":
          return block.items
            .map((item) => `${block.ordered ? "#" : "*"} ${wikiInline(item)}`)
            .join("\n");
        case "quote":
          return `{quote}\n${wikiInline(block.content)}\n{quote}`;
        case "code":
          return `{code${block.language ? `:${block.language}` : ""}}\n${block.text}\n{code}`;
        default:
          return wikiInline(block.content);
      }
    })
    .join("\n\n");
}

// --------------------------------------------------------- shared decisions

/*
 * Everything in this section was once inlined in buildPushPlan, which is how
 * the two export paths came to disagree: the CSV export had no notion of sync
 * state (so running it twice created every issue twice), routed `category`
 * nowhere, and dropped start dates without the warning that explains how to fix
 * the map. A decision that both paths have to make identically belongs in one
 * named function, or it gets made twice and drifts.
 */

export interface PushSelection {
  eligible: Item[];
  skipped: Array<{ localKey: string; reason: string }>;
  warnings: string[];
}

/** Which items still need creating in Jira, and why the rest do not. */
export function selectPushable(items: Item[]): PushSelection {
  const warnings: string[] = [];
  const skipped: Array<{ localKey: string; reason: string }> = [];

  const eligible = items.filter((item) => {
    // `drifted` carries a push baseline exactly as `pushed` does, so both belong
    // here. Checking only `pushed` let a drifted item fall through with no skip
    // and no warning, drafted as a brand-new issue for work Jira already had.
    if (item.sync.state === "pushed" || item.sync.state === "drifted") {
      // The hash decides, not the label. updateItem only ever moves
      // pushed -> drifted and never back, so an item that was edited and then
      // reverted still reads `drifted` while matching what Jira holds.
      const changed =
        item.sync.contentHash && contentHash(pushableFields(item)) !== item.sync.contentHash;
      if (!changed) {
        skipped.push({
          localKey: item.key,
          reason: `Already pushed as ${item.sync.jiraKey} and unchanged since`,
        });
        return false;
      }
      warnings.push(
        `${item.key} has changed since it was pushed as ${item.sync.jiraKey}. This creates a NEW issue; update the existing one by hand if that is not what you want.`,
      );
    }
    return true;
  });

  return { eligible, skipped, warnings };
}

/** Epics before their children, subtasks last, stable within a rank by key. */
function orderForCreation(items: Item[]): Item[] {
  const typeOrder: Record<string, number> = { epic: 0, story: 1, task: 1, bug: 1, subtask: 2 };
  return [...items].sort(
    (a, b) => typeOrder[a.type] - typeOrder[b.type] || a.key.localeCompare(b.key),
  );
}

/**
 * Where an item's `category` goes: folded in with the labels, or into whatever
 * custom field the map names. A category that lands in labels on one path and a
 * custom field on the other is two different issues, so both paths ask here.
 */
function resolveCategory(
  item: Item,
  map: JiraMap,
): { labels: string[]; customField?: [string, string] } {
  const labels = [...item.labels];
  if (!item.category) return { labels };
  if (map.fields.category === "labels") {
    // Jira splits a label on whitespace, so "Vendor management" would arrive as
    // two labels that mean nothing apart.
    labels.push(item.category.replace(/\s+/g, "-"));
    return { labels };
  }
  return { labels, customField: [map.fields.category, item.category] };
}

/**
 * Start date is a custom field with a different id on every site, so the map
 * has to name it. Saying so is the point: silently dropping the date leaves you
 * with a plausible-looking import missing a field you set deliberately.
 */
function resolveStartDate(
  item: Item,
  map: JiraMap,
): { fieldId?: string; value?: string; warning?: string } {
  if (!item.startDate) return {};
  if (!map.fields.startDate) {
    return {
      warning: `${item.key} has a start date but jira-map.yaml has no fields.startDate. Run \`vault jira discover --url <your site> --project <KEY>\` with JIRA_EMAIL and JIRA_TOKEN set to find the custom field id for your instance.`,
    };
  }
  return { fieldId: map.fields.startDate, value: item.startDate };
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
  const { eligible, skipped, warnings } = selectPushable(items);
  const selected = new Map(items.map((i) => [i.key, i]));
  const ordered = orderForCreation(eligible);

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

    const category = resolveCategory(item, map);
    if (category.labels.length) fields.labels = category.labels;
    if (category.customField) fields[category.customField[0]] = category.customField[1];
    if (item.components.length) {
      fields.components = item.components.map((name) => ({ name }));
    }
    if (item.assignee) fields.assignee = { name: item.assignee };
    if (item.dueDate) fields.duedate = item.dueDate;

    const startDate = resolveStartDate(item, map);
    if (startDate.warning) warnings.push(startDate.warning);
    if (startDate.fieldId) fields[startDate.fieldId] = startDate.value;
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

// ----------------------------------------------------------------- csv

export interface JiraCsvOptions {
  /**
   * Emit a Reporter column. Off by default: `reporter` is free text in the
   * vault, filtered case-insensitively because it is typed by hand, and Cloud's
   * importer resolves a person column against real accounts. It is the field
   * most likely to hold a name no account matches, and the one Jira cares about
   * least. Assignee carries the same risk and is emitted anyway, because an
   * unassigned bulk import is not much use.
   */
  reporter?: boolean;
}

export interface JiraCsvColumn {
  header: string;
  /** What to pick on the importer's mapping screen. Printed as a crib. */
  maps: string;
}

export interface JiraCsvResult {
  csv: string;
  columns: JiraCsvColumn[];
  rowCount: number;
  skipped: Array<{ localKey: string; reason: string }>;
  warnings: string[];
  /** Distinct people in the file, to eyeball against the site's users first. */
  assignees: string[];
  reporters: string[];
}

interface CsvRow {
  cells: Map<string, string>;
  labels: string[];
  components: string[];
}

/**
 * CSV for Jira Cloud's external import — the path to use when there is no API
 * token, or the instance is behind a VPN you would rather not automate against.
 *
 * The output is meant to survive the importer's mapping screen, which is where
 * a human pairs each column with a Jira field. Header wording is therefore a
 * convenience rather than a protocol: it has to be recognisable, not exact.
 * Two columns are not guessable and are why `columns` is returned for printing
 * — `Issue Id` and `Parent id`, which are how rows inside a single import link
 * to each other. Without that pair the import succeeds with a flat hierarchy,
 * which is the failure this function exists to avoid.
 */
export function toJiraCsv(
  items: Item[],
  map: JiraMap,
  vault: Vault,
  options: JiraCsvOptions = {},
): JiraCsvResult {
  const { eligible, skipped, warnings } = selectPushable(items);
  const ordered = orderForCreation(eligible);
  const emitted = new Set(ordered.map((item) => item.key));
  const byKey = new Map(items.map((item) => [item.key, item]));

  // Object-valued defaults are the one part of the map a CSV cannot carry:
  // `{ id: "team-uuid" }` has no cell representation, and a create screen that
  // requires the field rejects every row without explaining why.
  const defaults: Array<[string, string]> = [];
  for (const [field, value] of Object.entries(map.defaults)) {
    if (value !== null && typeof value === "object") {
      warnings.push(
        `jira-map.yaml sets defaults.${field} to an object, which no CSV cell can express. If your create screen requires that field, set it on the issues after import or push over the API instead.`,
      );
      continue;
    }
    defaults.push([field, String(value)]);
  }

  const startHeader = map.fields.startDate ? "Start Date" : undefined;
  const categoryHeader = map.fields.category !== "labels" ? "Category" : undefined;

  const rows: CsvRow[] = ordered.map((item) => {
    const cells = new Map<string, string>();
    const category = resolveCategory(item, map);
    const startDate = resolveStartDate(item, map);
    if (startDate.warning) warnings.push(startDate.warning);

    cells.set("Issue Id", item.key);
    cells.set("Issue Type", map.issueTypes[item.type]);
    cells.set("Summary", item.summary);
    // buildDescription, not item.description: the links footer and the "tracked
    // locally as" provenance line are how a created issue points back at the
    // vault, and the API path has always had them.
    cells.set("Description", blocksToWiki(parseDescription(buildDescription(item, vault))));
    cells.set("Priority", map.priorities[item.priority] ?? "");
    cells.set("Assignee", item.assignee ?? "");
    if (options.reporter) cells.set("Reporter", item.reporter ?? "");
    cells.set("Due Date", item.dueDate ?? "");
    if (startHeader && startDate.value) cells.set(startHeader, startDate.value);
    if (map.fields.estimate && item.estimate !== undefined) {
      cells.set("Story Points", String(item.estimate));
    }
    if (categoryHeader && category.customField) {
      cells.set(categoryHeader, category.customField[1]);
    }
    for (const [field, value] of defaults) cells.set(field, value);

    if (item.parent) {
      // Same order of preference as buildPushPlan: a parent Jira already holds
      // wins over an in-batch link, because a real key needs no resolution.
      const parentItem = byKey.get(item.parent) ?? safeGet(vault, item.parent);
      const parentJiraKey = parentItem?.sync.jiraKey;
      if (parentJiraKey) {
        cells.set("Parent", parentJiraKey);
      } else if (emitted.has(item.parent)) {
        cells.set("Parent id", item.parent);
        if (map.fields.epicLink && parentItem?.type === "epic") {
          cells.set("Epic Link", item.parent);
        }
      } else {
        warnings.push(
          `${item.key} has parent ${item.parent}, which is neither in this export nor already in Jira. It will be created without a parent link.`,
        );
      }
    }

    return { cells, labels: category.labels, components: [...item.components] };
  });

  const columns = buildColumns(rows, {
    reporter: options.reporter === true,
    startHeader,
    categoryHeader,
    estimate: Boolean(map.fields.estimate),
    epicLink: Boolean(map.fields.epicLink),
    defaults: defaults.map(([field]) => field),
  });

  const table = [
    columns.map((column) => column.header),
    ...rows.map((row) => csvRowValues(row, columns)),
  ];

  // The BOM and the CRLF endings are for Excel, which is where these files get
  // opened and eyeballed before anyone uploads them. Jira is indifferent to
  // both; Excel on Windows reads a BOM-less UTF-8 file as the ANSI codepage and
  // mangles every non-ASCII character in it.
  const csv = `\uFEFF${table.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;

  return {
    csv,
    columns,
    rowCount: rows.length,
    skipped,
    warnings,
    assignees: distinct(ordered.map((item) => item.assignee)),
    reporters: options.reporter ? distinct(ordered.map((item) => item.reporter)) : [],
  };
}

/**
 * The header row, and with it the shape of every data row.
 *
 * Labels and components get one column *each*, repeated as many times as the
 * widest row needs, because that is how the importer reads a multi-value field.
 * Joining them into one cell — which this export used to do — either splits a
 * label on its spaces or imports one wrong label, depending on the field.
 *
 * Deriving the width is why the rows are built before the header exists: a
 * single pass cannot know how many Labels columns the file will need.
 */
function buildColumns(
  rows: CsvRow[],
  present: {
    reporter: boolean;
    startHeader?: string;
    categoryHeader?: string;
    estimate: boolean;
    epicLink: boolean;
    defaults: string[];
  },
): JiraCsvColumn[] {
  const widest = (pick: (row: CsvRow) => string[]) =>
    rows.reduce((max, row) => Math.max(max, pick(row).length), 0);

  const columns: JiraCsvColumn[] = [
    { header: "Issue Id", maps: "Issue Id — the vault key. Pairs with Parent id." },
    { header: "Issue Type", maps: "Issue Type" },
    { header: "Summary", maps: "Summary" },
    { header: "Description", maps: "Description" },
    { header: "Priority", maps: "Priority" },
  ];

  for (let i = 0; i < widest((row) => row.labels); i += 1) {
    columns.push({ header: "Labels", maps: "Labels (one column per label)" });
  }
  for (let i = 0; i < widest((row) => row.components); i += 1) {
    columns.push({ header: "Components", maps: "Component/s (one column per component)" });
  }

  columns.push({ header: "Assignee", maps: "Assignee — matched against your site's users" });
  if (present.reporter) {
    columns.push({ header: "Reporter", maps: "Reporter — matched against your site's users" });
  }
  columns.push({ header: "Due Date", maps: "Due Date" });
  if (present.startHeader) {
    columns.push({ header: present.startHeader, maps: "the start date custom field on your site" });
  }
  if (present.estimate) {
    columns.push({ header: "Story Points", maps: "the estimate field named in jira-map.yaml" });
  }
  if (present.categoryHeader) {
    columns.push({
      header: present.categoryHeader,
      maps: "the category custom field named in jira-map.yaml",
    });
  }
  for (const field of present.defaults) {
    columns.push({ header: field, maps: `${field}, from defaults in jira-map.yaml` });
  }
  columns.push({ header: "Parent id", maps: "Parent id — links to an Issue Id in this same file" });
  columns.push({ header: "Parent", maps: "Parent — an issue key already in Jira" });
  if (present.epicLink) {
    columns.push({ header: "Epic Link", maps: "Epic Link, for a company-managed project" });
  }
  return columns;
}

/**
 * One row's cells, in column order.
 *
 * Labels and Components appear under repeated headers, so they are read
 * positionally — the nth `Labels` column holds the nth label — and short rows
 * pad with empties. Everything else is a straight lookup by header.
 */
function csvRowValues(row: CsvRow, columns: JiraCsvColumn[]): string[] {
  let label = 0;
  let component = 0;
  return columns.map((column) => {
    if (column.header === "Labels") return row.labels[label++] ?? "";
    if (column.header === "Components") return row.components[component++] ?? "";
    return row.cells.get(column.header) ?? "";
  });
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => Boolean(v && v.trim())))].sort();
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
