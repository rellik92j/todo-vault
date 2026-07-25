#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { Vault, VaultError } from "./vault.js";
import { buildPushPlan, loadJiraMap } from "./jira.js";
import {
  CADENCES,
  ITEM_TYPES,
  PRIORITIES,
  STATUSES,
  itemKey,
  projectKey,
  type Item,
} from "./schema.js";
import { formatZodError, todayIso } from "./util.js";
import path from "node:path";

/**
 * stdio MCP server over a local vault.
 *
 * Deliberately not a thin CRUD wrapper: `get_agenda` and `plan_jira_push`
 * exist because "what should I do today" and "what would go to Jira" are the
 * questions actually asked, and answering them in one call keeps far less
 * junk in the model's context than ten list calls would.
 */

const VAULT_DIR = process.env.VAULT_DIR ?? process.argv[2] ?? "./vault";
const CHARACTER_LIMIT = 24_000;

const server = new McpServer({ name: "todo-vault-mcp-server", version: "0.1.0" });

let vault: Vault;

/** Compact projection — full item bodies blow up context fast in list results. */
function summarize(item: Item): Record<string, unknown> {
  return {
    key: item.key,
    type: item.type,
    summary: item.summary,
    status: item.status,
    priority: item.priority,
    ...(item.parent ? { parent: item.parent } : {}),
    ...(item.category ? { category: item.category } : {}),
    ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    ...(item.startDate ? { startDate: item.startDate } : {}),
    ...(item.cadence !== "none" ? { cadence: item.cadence } : {}),
    ...(item.labels.length ? { labels: item.labels } : {}),
    ...(item.sync.jiraKey ? { jiraKey: item.sync.jiraKey } : {}),
  };
}

function detail(item: Item): Record<string, unknown> {
  return {
    ...summarize(item),
    description: item.description,
    assignee: item.assignee,
    estimate: item.estimate,
    links: item.links,
    attachments: item.attachments,
    comments: item.comments,
    sync: item.sync,
    created: item.created,
    updated: item.updated,
  };
}

function ok(payload: unknown, text?: string) {
  let body = JSON.stringify(payload, null, 2);
  let truncated = false;
  if (body.length > CHARACTER_LIMIT) {
    body = `${body.slice(0, CHARACTER_LIMIT)}\n... truncated`;
    truncated = true;
  }
  return {
    content: [
      {
        type: "text" as const,
        text: text
          ? `${text}\n${body}${truncated ? "\n\nNarrow the filter to see everything." : ""}`
          : body,
      },
    ],
    structuredContent: payload as Record<string, unknown>,
  };
}

function fail(err: unknown) {
  const message = err instanceof VaultError ? err.message : formatZodError(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${message}` }],
  };
}

/** Every write reloads first, since the desktop app may have changed files underneath us. */
async function withFreshVault<T>(fn: () => Promise<T>): Promise<T> {
  await vault.load();
  return fn();
}

// ------------------------------------------------------------------- read

server.registerTool(
  "vault_list_items",
  {
    title: "List vault items",
    description: `List tasks, stories, epics, and bugs from the local vault, with filters.

Returns a compact projection of each item (no description body). Use vault_get_item for the full record.

Args:
  - project (string, optional): project key, e.g. "ACME"
  - type ('epic'|'story'|'task'|'bug'|'subtask', optional)
  - status (string[], optional): any of ${STATUSES.join(", ")}
  - cadence ('daily'|'weekly'|'monthly'|'quarterly'|'none', optional)
  - category, label, assignee, parent (string, optional)
  - dueBefore / dueAfter (YYYY-MM-DD, optional)
  - open (boolean, optional): true excludes done items
  - text (string, optional): case-insensitive match on summary and description
  - limit (number, 1-500, default 100), offset (number, default 0)

Returns: { total, count, offset, items: [{ key, type, summary, status, priority, dueDate?, ... }], has_more }

Use when: "what's open on ACME", "show me everything blocked", "find the task about the vendor SOW".
Don't use when: you want today's or this week's priorities — vault_get_agenda is better.`,
    inputSchema: {
      project: projectKey.optional(),
      type: z.enum(ITEM_TYPES).optional(),
      status: z.array(z.enum(STATUSES)).optional(),
      cadence: z.enum(CADENCES).optional(),
      category: z.string().optional(),
      label: z.string().optional(),
      assignee: z.string().optional(),
      parent: itemKey.optional(),
      dueBefore: z.string().optional(),
      dueAfter: z.string().optional(),
      open: z.boolean().optional(),
      text: z.string().optional(),
      limit: z.number().int().min(1).max(500).default(100),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async (args) => {
    try {
      await vault.load();
      const { total, items } = vault.listItems(args);
      return ok({
        total,
        count: items.length,
        offset: args.offset,
        items: items.map(summarize),
        has_more: total > args.offset + items.length,
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_get_item",
  {
    title: "Get one vault item",
    description: `Fetch the complete record for a single item, including its description body, links, attachments, comments, children, and any items that reference it.

Args:
  - key (string): item key such as "ACME-42"

Returns: { item: {...}, children: [...], backlinks: [...] }

Use when: you need the full context of a task before updating it or writing about it.`,
    inputSchema: { key: itemKey },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key }) => {
    try {
      await vault.load();
      const item = vault.getItem(key);
      return ok({
        item: detail(item),
        children: vault.children(key).map(summarize),
        backlinks: vault.backlinks(key).map(summarize),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_get_agenda",
  {
    title: "Get the agenda",
    description: `Answer "what needs my attention" for a time window. Combines items due in the window with recurring items whose cadence falls inside it, and always surfaces anything overdue first.

Args:
  - scope ('today'|'week'|'month', default 'today')
  - reference (YYYY-MM-DD, optional): treat this as the current date

Returns: { sections: [{ scope, from?, to?, count, items: [...] }] }
Weeks run Monday to Sunday.

Use when: "what's on for today", "what's due this week", "give me a monthly status rollup".`,
    inputSchema: {
      scope: z.enum(["today", "week", "month"]).default("today"),
      reference: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ scope, reference }) => {
    try {
      await vault.load();
      const sections = vault.agenda(scope, reference ?? todayIso());
      return ok({
        reference: reference ?? todayIso(),
        sections: sections.map((s) => ({
          scope: s.scope,
          from: s.from,
          to: s.to,
          count: s.items.length,
          items: s.items.map(summarize),
        })),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_list_projects",
  {
    title: "List projects",
    description: `List every project in the vault with its open item count.

Returns: { projects: [{ key, name, status, category?, lead?, dueDate?, openItems }] }

Use when: you need a project key before creating an item, or want a portfolio-level view.`,
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async () => {
    try {
      await vault.load();
      return ok({
        projects: vault.listProjects().map((p) => ({
          key: p.key,
          name: p.name,
          status: p.status,
          category: p.category,
          lead: p.lead,
          dueDate: p.dueDate,
          openItems: vault.listItems({ project: p.key, open: true, limit: 500 }).total,
        })),
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// ------------------------------------------------------------------ write

server.registerTool(
  "vault_create_item",
  {
    title: "Create a vault item",
    description: `Create a new epic, story, task, bug, or subtask. The vault assigns the key.

Args:
  - project (string, required): existing project key
  - type ('epic'|'story'|'task'|'bug'|'subtask', default 'task')
  - summary (string, required, max 255)
  - description (string, optional): markdown body
  - priority (${PRIORITIES.join("|")}, default 'medium')
  - parent (string, optional): epic key for a story/task/bug, task key for a subtask
  - category, assignee (string, optional)
  - labels (string[], optional)
  - startDate / dueDate (YYYY-MM-DD, optional)
  - cadence (${CADENCES.join("|")}, default 'none'): marks this as a recurring daily/weekly/monthly item
  - estimate (number, optional)

Returns: { created: { key, ... } }

Hierarchy rules: epics take no parent; stories, tasks, and bugs may only be parented to an epic; subtasks must have a parent that is a story, task, or bug.

Error handling: returns a message naming the valid options if the project does not exist or the parent is the wrong type.`,
    inputSchema: {
      project: projectKey,
      type: z.enum(ITEM_TYPES).default("task"),
      summary: z.string().min(1).max(255),
      description: z.string().default(""),
      priority: z.enum(PRIORITIES).optional(),
      parent: itemKey.optional(),
      category: z.string().max(60).optional(),
      assignee: z.string().max(120).optional(),
      labels: z.array(z.string().max(60)).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      cadence: z.enum(CADENCES).optional(),
      estimate: z.number().nonnegative().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const item = await withFreshVault(() => vault.createItem(args));
      return ok({ created: detail(item) }, `Created ${item.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_update_item",
  {
    title: "Update a vault item",
    description: `Change fields on an existing item. Only the fields you pass are touched.

Args:
  - key (string, required)
  - summary, description, category, assignee (string, optional)
  - status (${STATUSES.join("|")}, optional)
  - priority (${PRIORITIES.join("|")}, optional)
  - parent (string or null, optional): null clears it
  - labels (string[], optional): replaces the whole list
  - startDate / dueDate (YYYY-MM-DD or null, optional)
  - cadence, estimate (optional)

Returns: { updated: { key, ... } }

Status moves are validated against the workflow. If a move is rejected the error names the statuses reachable from the current one. An item already pushed to Jira is flagged as drifted when its pushable content changes.`,
    inputSchema: {
      key: itemKey,
      summary: z.string().min(1).max(255).optional(),
      description: z.string().optional(),
      status: z.enum(STATUSES).optional(),
      priority: z.enum(PRIORITIES).optional(),
      parent: itemKey.nullable().optional(),
      category: z.string().max(60).nullable().optional(),
      assignee: z.string().max(120).nullable().optional(),
      labels: z.array(z.string().max(60)).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      cadence: z.enum(CADENCES).optional(),
      estimate: z.number().nonnegative().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, ...patch }) => {
    try {
      const item = await withFreshVault(() => vault.updateItem(key, patch));
      return ok({ updated: detail(item) }, `Updated ${item.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_transition_item",
  {
    title: "Move an item to a new status",
    description: `Shorthand for the most common update: moving an item through the workflow.

Args:
  - key (string, required)
  - status (${STATUSES.join("|")}, required)

Returns: { updated: { key, status, ... } }

Use when: "mark ACME-12 done", "I've started on the vendor task".`,
    inputSchema: { key: itemKey, status: z.enum(STATUSES) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, status }) => {
    try {
      const item = await withFreshVault(() => vault.transition(key, status));
      return ok({ updated: summarize(item) }, `${item.key} is now ${item.status}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_add_comment",
  {
    title: "Comment on an item",
    description: `Append a timestamped comment. Comments are the running log of what happened, distinct from the description, which is what the work is.

Args:
  - key (string, required)
  - body (string, required)
  - author (string, default 'me')

Returns: { key, commentCount }`,
    inputSchema: { key: itemKey, body: z.string().min(1), author: z.string().default("me") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, body, author }) => {
    try {
      const item = await withFreshVault(() => vault.addComment(key, body, author));
      return ok({ key: item.key, commentCount: item.comments.length }, `Comment added to ${item.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_link_item",
  {
    title: "Link content to an item",
    description: `Attach a reference to an item. This is how arbitrary content gets associated with a task.

Args:
  - key (string, required)
  - type ('url'|'file'|'folder'|'item'|'outlook'|'note', required)
      url     — a web address
      file    — an absolute path to a file left where it lives
      folder  — an absolute path to a directory
      item    — another vault item key, creating a two-way relationship
      outlook — an Outlook deep link or message id
      note    — free text
  - target (string, required)
  - label (string, optional)

Returns: { key, links: [...] }

Links of type 'item' are validated against the vault and produce backlinks on the other item.`,
    inputSchema: {
      key: itemKey,
      type: z.enum(["url", "file", "folder", "item", "outlook", "note"]),
      target: z.string().min(1),
      label: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, type, target, label }) => {
    try {
      const item = await withFreshVault(() => vault.addLink(key, { type, target, label }));
      return ok({ key: item.key, links: item.links }, `Linked ${type} to ${item.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_attach_file",
  {
    title: "Attach a file to an item",
    description: `Attach a file from disk.

Args:
  - key (string, required)
  - sourcePath (string, required): absolute path to an existing file
  - copy (boolean, default true): true copies the file into the vault under attachments/<key>/ so it is versioned alongside the item; false records a pointer to where it already lives, which is what you want for large files or files on a network share
  - title (string, optional)

Returns: { key, attachments: [...] }

Error handling: returns a message naming the path if the file does not exist or is a directory.`,
    inputSchema: {
      key: itemKey,
      sourcePath: z.string().min(1),
      copy: z.boolean().default(true),
      title: z.string().max(200).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, sourcePath, copy, title }) => {
    try {
      const item = await withFreshVault(() => vault.addAttachment(key, sourcePath, { copy, title }));
      return ok(
        { key: item.key, attachments: item.attachments, links: item.links.filter((l) => l.type === "file") },
        `Attached to ${item.key}.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_create_project",
  {
    title: "Create a project",
    description: `Create a new project. Items cannot exist without one.

Args:
  - key (string, required): 2-10 uppercase letters/digits, e.g. "ACME". Becomes the item key prefix and cannot be changed later.
  - name (string, required)
  - description (string, optional)
  - category, lead (string, optional)
  - startDate / dueDate (YYYY-MM-DD, optional)
  - jiraProjectKey (string, optional): where this project's items would land in Jira

Returns: { created: { key, name, ... } }`,
    inputSchema: {
      key: projectKey,
      name: z.string().min(1).max(200),
      description: z.string().optional(),
      category: z.string().max(60).optional(),
      lead: z.string().max(120).optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      jiraProjectKey: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async (args) => {
    try {
      const project = await withFreshVault(() => vault.createProject(args));
      return ok({ created: project }, `Created project ${project.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

// -------------------------------------------------------------------- jira

server.registerTool(
  "vault_plan_jira_push",
  {
    title: "Build a Jira push plan",
    description: `Produce a reviewable payload of what would be created in Jira. This tool does NOT contact Jira and sends nothing over the network — it only reads the vault and the local jira-map.yaml.

Args:
  - project (string, optional): limit to one project
  - includeDone (boolean, default false)
  - mapPath (string, optional): defaults to <vault>/jira-map.yaml

Returns: { jiraProjectKey, drafts: [{ localKey, parentLocalKey?, fields }], attachments, skipped, warnings }

Drafts are ordered so every parent is created before its children. Items already pushed and unchanged are skipped. Descriptions are converted to Atlassian Document Format.

Use when: "what would go to Jira", "prepare the sprint items for push".
Don't use when: you want the items themselves — use vault_list_items.`,
    inputSchema: {
      project: projectKey.optional(),
      includeDone: z.boolean().default(false),
      mapPath: z.string().optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ project, includeDone, mapPath }) => {
    try {
      await vault.load();
      const map = await loadJiraMap(mapPath ?? path.join(vault.root, "jira-map.yaml"));
      const { items } = vault.listItems({ project, open: includeDone ? undefined : true, limit: 500 });
      const plan = buildPushPlan(items, map, vault);
      return ok(plan, `${plan.drafts.length} issue(s) would be created in ${plan.jiraProjectKey}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_mark_pushed",
  {
    title: "Record a completed Jira push",
    description: `Record that a local item now exists in Jira. Call this after the issue has actually been created so future plans skip it and drift detection has a baseline.

Args:
  - key (string, required): local item key
  - jiraKey (string, required): the key Jira assigned, e.g. "ENG-1043"
  - jiraId (string, optional): Jira's numeric id

Returns: { key, sync: { jiraKey, state, lastPushedAt } }`,
    inputSchema: { key: itemKey, jiraKey: z.string().min(1), jiraId: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, jiraKey, jiraId }) => {
    try {
      const item = await withFreshVault(() => vault.markPushed(key, jiraKey, jiraId));
      return ok({ key: item.key, sync: item.sync }, `${item.key} recorded as ${jiraKey}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

// --------------------------------------------------------------- resources

server.registerResource(
  "vault-item",
  "vault://item/{key}",
  {
    title: "Vault item",
    description: "The raw markdown file for a single item, frontmatter included",
    mimeType: "text/markdown",
  },
  async (uri: URL) => {
    const key = decodeURIComponent(uri.pathname.replace(/^\/+/, "")) || uri.href.split("/").pop()!;
    await vault.load();
    const item = vault.getItem(key);
    const { promises: fsp } = await import("node:fs");
    const text = await fsp.readFile(vault.itemPath(item.key), "utf8");
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text }] };
  },
);

async function main(): Promise<void> {
  vault = await Vault.open(VAULT_DIR, { git: process.env.VAULT_GIT === "1" });
  const { items, projects, errors } = await vault.load();
  // stderr only — stdout is the MCP transport and must carry nothing else.
  process.stderr.write(
    `todo-vault MCP server ready: ${projects} project(s), ${items} item(s) at ${vault.root}\n`,
  );
  for (const e of errors) process.stderr.write(`  invalid file: ${e}\n`);

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
