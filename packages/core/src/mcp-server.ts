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
    description: `Answer "what needs my attention" for a time window.

Returns up to three sections, each tagged with 'kind':
  - overdue:   past its due date and not done. Always first when present.
  - due:       has a due date landing inside the window.
  - recurring: no due date in the window, but its cadence comes round inside it.

'due' and 'recurring' are separate because recurring work has no deadline —
reporting them as one list implies the recurring items are due, which they are
not. An item that is both due and recurring appears only under 'due'.

Args:
  - scope ('today'|'week'|'month', default 'today')
  - reference (YYYY-MM-DD, optional): treat this as the current date

Returns: { sections: [{ kind, scope, from?, to?, count, items: [...] }] }
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
          kind: s.kind,
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

Returned in manual order where one has been set with vault_reorder_project, alphabetically by key otherwise.

Returns: { projects: [{ key, name, status, category?, lead?, dueDate?, rank?, openItems }] }

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
          rank: p.rank,
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

server.registerTool(
  "vault_update_project",
  {
    title: "Update a project",
    description: `Change a project's fields. Not its key — that re-keys every item in it, so use vault_rename_project.

Args (all optional; pass null to clear a field):
  - key (string, required): the project to update
  - name, description, category, lead (string)
  - startDate / dueDate (YYYY-MM-DD)
  - status ('active'|'on_hold'|'complete'|'archived')
  - jiraProjectKey (string): target project in Jira

Returns: { updated: { key, name, status, ... } }`,
    inputSchema: {
      key: projectKey,
      name: z.string().min(1).max(200).optional(),
      description: z.string().optional(),
      category: z.string().max(60).nullable().optional(),
      lead: z.string().max(120).nullable().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      status: z.enum(["active", "on_hold", "complete", "archived"]).optional(),
      jiraProjectKey: z.string().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, ...patch }) => {
    try {
      const project = await withFreshVault(() => vault.updateProject(key, patch));
      return ok({ updated: project }, `Updated project ${project.key}.`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_rename_project",
  {
    title: "Rename a project key",
    description: `Change a project's key, re-keying every item in it: ACME-42 becomes NEW-42.

This is the one operation that changes item keys, which are otherwise issued once and never reused. Item numbers and every item's stable 'id' are preserved, and sync.jiraKey is untouched. Anything OUTSIDE the vault that quoted an old key — an email, a Jira issue, a document — will not be updated. Say so when reporting the result.

Args:
  - from (string, required): current project key
  - to (string, required): new key, 2-10 uppercase letters/digits

Returns: { project, rekeyed: <count> }

Use when: the user explicitly asks to rename or re-key a project.
Don't use when: they only want to change the display name — that is vault_update_project with 'name'.`,
    inputSchema: { from: projectKey, to: projectKey },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ from, to }) => {
    try {
      return await withFreshVault(async () => {
        const count = vault.listItems({ project: from, limit: 500 }).total;
        const project = await vault.renameProject(from, to);
        return ok(
          { project, rekeyed: count },
          `Renamed ${from} to ${to}, re-keying ${count} item(s). References outside the vault still say ${from}-.`,
        );
      });
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_move_item_to_project",
  {
    title: "Move an item to another project",
    description: `Move an item, and everything beneath it, into a different project. Like Jira's Move, the items get fresh keys in the target project, because a key belongs to a project.

The whole subtree moves together. Each item keeps its stable 'id', so only the human-facing keys change.

If the item's parent stays behind in the old project, the parent link is dropped and reported — pass 'parent' to attach it to something in the target instead. A subtask cannot lose its parent, so moving one requires 'parent'.

Args:
  - key (string, required): the item to move
  - targetProject (string, required)
  - parent (string, optional): new parent in the target project; null to detach

Returns: { rekeyed: [{ from, to }], parentDropped? }`,
    inputSchema: {
      key: itemKey,
      targetProject: projectKey,
      parent: itemKey.nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, targetProject, parent }) => {
    try {
      const result = await withFreshVault(() =>
        vault.moveItemsToProject(key, targetProject, { parent }),
      );
      const moved = result.rekeyed.find((r) => r.from === key);
      return ok(
        result,
        `Moved ${key} to ${targetProject} as ${moved?.to}` +
          (result.rekeyed.length > 1 ? ` with ${result.rekeyed.length - 1} descendant(s).` : ".") +
          (result.parentDropped ? ` Parent ${result.parentDropped} stayed behind, link dropped.` : ""),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_reorder_project",
  {
    title: "Reorder the project list",
    description: `Set a project's manual position in the project list — the order vault_list_projects returns, and what a sidebar would show.

This reorders PROJECTS. To move work between projects, use vault_move_item_to_project. To reorder items inside a project, use vault_move_item.

Positions are list positions, not rank numbers: name the neighbours it should land between. One side is enough — 'before' means IMMEDIATELY before that project. Naming neither sends it to the end.

Projects with no manual position sort alphabetically after ranked ones, so a vault where nothing has been reordered reads as it always did.

Args:
  - key (string, required)
  - after (string, optional): the project it should follow
  - before (string, optional): the project it should precede

Returns: { key, rank, order: [<keys in the new order>] }`,
    inputSchema: { key: projectKey, after: projectKey.optional(), before: projectKey.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, after, before }) => {
    try {
      return await withFreshVault(async () => {
        const project = await vault.moveProject(key, { after, before });
        const order = vault.listProjects().map((p) => p.key);
        return ok(
          { key: project.key, rank: project.rank, order },
          `${project.key} repositioned. Order is now ${order.join(", ")}.`,
        );
      });
    } catch (err) {
      return fail(err);
    }
  },
);

// -------------------------------------------------------------- destructive

server.registerTool(
  "vault_delete_item",
  {
    title: "Delete an item (recoverable)",
    description: `Move an item to the vault's .trash/ folder. The file is NOT destroyed and vault_restore_item brings it back, so this is recoverable without relying on git.

Refuses when the item has children, rather than orphaning them — the error lists them. Pass cascade to trash the whole subtree together.

Items elsewhere that link to this one are reported in danglingBacklinks. Their links are left alone rather than silently edited; mention them when reporting the result.

The key is never reissued, even though items/ no longer contains it.

Args:
  - key (string, required)
  - cascade (boolean, default false): also trash everything beneath it

Returns: { trashed: [{ key, trashedTo, attachmentsTrashedTo?, danglingBacklinks }] }

Use when: the user asks to delete, remove, or drop an item.`,
    inputSchema: { key: itemKey, cascade: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, cascade }) => {
    try {
      const trashed = await withFreshVault(() => vault.deleteItem(key, { cascade }));
      const dangling = trashed.flatMap((t) => t.danglingBacklinks);
      return ok(
        { trashed },
        `Trashed ${trashed.map((t) => t.key).join(", ")}. Recoverable with vault_restore_item.` +
          (dangling.length ? ` Still linking to it: ${[...new Set(dangling)].join(", ")}.` : ""),
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_delete_project",
  {
    title: "Delete a project (recoverable)",
    description: `Move a project to .trash/projects/. Recoverable with vault_restore_project.

Refuses while the project still holds items, rather than trashing work by implication. Pass cascade to trash the project and every item in it; each item becomes its own trash entry so they can be restored individually.

Args:
  - key (string, required)
  - cascade (boolean, default false)

Returns: { key, trashedTo, items: [{ key, trashedTo }] }

Use when: the user asks to delete a project. Confirm the cascade with them first if it holds items — the refusal exists so that choice is theirs.`,
    inputSchema: { key: projectKey, cascade: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ key, cascade }) => {
    try {
      const result = await withFreshVault(() => vault.deleteProject(key, { cascade }));
      return ok(
        result,
        `Trashed project ${result.key}` +
          (result.items.length ? ` and ${result.items.length} item(s).` : ".") +
          " Recoverable with vault_restore_project.",
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_list_trash",
  {
    title: "List the trash",
    description: `What is recoverable, most recently trashed first.

Args:
  - projects (boolean, default false): list trashed projects instead of items

Returns: { entries: [{ file, key, trashedAt, summary?, hasAttachments }] }

Pass 'file' to vault_restore_item or vault_restore_project.`,
    inputSchema: { projects: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ projects }) => {
    try {
      await vault.load();
      const entries = projects ? await vault.listTrashedProjects() : await vault.listTrash();
      return ok({ entries }, `${entries.length} recoverable ${projects ? "project" : "item"}(s).`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_restore_item",
  {
    title: "Restore a trashed item",
    description: `Bring an item back from .trash/, along with any attachments trashed with it.

Takes the 'file' from vault_list_trash — a bare filename, not a path.

Fails when the key has since been reissued, or when the item's parent is itself still in the trash; restore the parent first.

Args:
  - file (string, required)

Returns: { restored: { key, summary, ... } }`,
    inputSchema: { file: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ file }) => {
    try {
      const item = await withFreshVault(() => vault.restoreItem(file));
      return ok({ restored: detail(item) }, `Restored ${item.key}: ${item.summary}`);
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_restore_project",
  {
    title: "Restore a trashed project",
    description: `Bring a project back from .trash/projects/.

Its items stay in the trash — restore them separately with vault_restore_item, so a project can return without everything that was once in it.

Args:
  - file (string, required): from vault_list_trash with projects: true

Returns: { restored: { key, name, ... } }`,
    inputSchema: { file: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ file }) => {
    try {
      const project = await withFreshVault(() => vault.restoreProject(file));
      return ok(
        { restored: project },
        `Restored project ${project.key}. Its items are still in the trash.`,
      );
    } catch (err) {
      return fail(err);
    }
  },
);

server.registerTool(
  "vault_move_item",
  {
    title: "Reorder an item by hand",
    description: `Set an item's manual position within its project — the order a board column shows when read with sort 'rank'.

Positions are list positions, not rank numbers: give the neighbours it should land between. Naming one side is enough — 'before' means IMMEDIATELY before that item. Naming neither sends it to the end.

Ranks are per project, so both neighbours must be in the same project as the item.

Args:
  - key (string, required)
  - after (string, optional): the item it should follow
  - before (string, optional): the item it should precede

Returns: { key, rank }

Use when: the user asks to prioritise, reorder, or move something up or down a list.
Don't use when: they mean a different project — that is vault_move_item_to_project.`,
    inputSchema: { key: itemKey, after: itemKey.optional(), before: itemKey.optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ key, after, before }) => {
    try {
      const item = await withFreshVault(() => vault.moveItem(key, { after, before }));
      return ok({ key: item.key, rank: item.rank }, `${item.key} repositioned.`);
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
