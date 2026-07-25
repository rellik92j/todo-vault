import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Vault } from "../src/vault.js";
import { buildPushPlan, markdownToAdf, JiraMapSchema } from "../src/jira.js";
import { parseFrontmatter } from "../src/markdown.js";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

test("assigns sequential keys and never reuses them", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "First" });
  const b = await vault.createItem({ project: "ACME", summary: "Second" });
  assert.equal(a.key, "ACME-1");
  assert.equal(b.key, "ACME-2");

  await fs.rm(vault.itemPath("ACME-2"));
  await vault.load();
  const c = await vault.createItem({ project: "ACME", summary: "Third" });
  assert.equal(c.key, "ACME-3", "a deleted key must never be handed out again");
});

test("round-trips an item through disk without losing fields", async () => {
  const vault = await tmpVault();
  const created = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Send the vendor SOW",
    description: "Needs legal review first.\n\n- [ ] draft\n- [ ] send",
    dueDate: "2026-08-14",
    cadence: "weekly",
    category: "Procurement",
    labels: ["vendor", "legal"],
  });

  const reopened = await Vault.open(vault.root);
  const loaded = reopened.getItem(created.key);
  assert.equal(loaded.summary, "Send the vendor SOW");
  assert.equal(loaded.dueDate, "2026-08-14");
  assert.equal(loaded.cadence, "weekly");
  assert.deepEqual(loaded.labels, ["vendor", "legal"]);
  assert.match(loaded.description, /legal review/);
});

test("writes stable frontmatter in a fixed key order", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Ordering check" });
  const raw = await fs.readFile(vault.itemPath(item.key), "utf8");
  const { data } = parseFrontmatter(raw);
  const keys = Object.keys(data);
  assert.equal(keys[0], "id");
  assert.equal(keys[1], "key");
  assert.ok(keys.indexOf("summary") < keys.indexOf("status"));
  assert.ok(keys.indexOf("created") < keys.indexOf("updated"));
  assert.ok(!("parent" in data), "empty optional fields must not be written");
});

test("enforces the Jira hierarchy rules", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Migration" });
  const task = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Cut over DNS",
    parent: epic.key,
  });

  await assert.rejects(
    () => vault.createItem({ project: "ACME", type: "epic", summary: "Nested", parent: epic.key }),
    /cannot have a parent/,
  );
  await assert.rejects(
    () => vault.createItem({ project: "ACME", type: "task", summary: "Bad", parent: task.key }),
    /only be parented to an epic/,
  );
  await assert.rejects(
    () => vault.createItem({ project: "ACME", type: "subtask", summary: "Orphan" }),
    /must name a parent/,
  );

  const sub = await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Update TTLs",
    parent: task.key,
  });
  assert.deepEqual(
    vault.children(task.key).map((i) => i.key),
    [sub.key],
  );
});

test("validates status transitions", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Workflow" });

  await assert.rejects(
    () => vault.transition(item.key, "in_review"),
    /From todo you can go to/,
    "todo -> in_review should be rejected with an actionable message",
  );

  await vault.transition(item.key, "in_progress");
  await vault.transition(item.key, "in_review");
  const done = await vault.transition(item.key, "done");
  assert.equal(done.status, "done");
});

test("rejects a project that does not exist, and says which ones do", async () => {
  const vault = await tmpVault();
  await assert.rejects(
    () => vault.createItem({ project: "NOPE", summary: "x" }),
    /Known projects: ACME/,
  );
});

test("links create backlinks and are validated", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "Design doc" });
  const b = await vault.createItem({ project: "ACME", summary: "Implementation" });

  await vault.addLink(b.key, { type: "item", target: a.key, label: "spec" });
  await vault.addLink(b.key, { type: "url", target: "https://example.com/doc" });
  await vault.addLink(b.key, { type: "outlook", target: "outlook:0000ABCD", label: "Kickoff email" });

  assert.deepEqual(
    vault.backlinks(a.key).map((i) => i.key),
    [b.key],
  );
  await assert.rejects(
    () => vault.addLink(b.key, { type: "item", target: "ACME-999" }),
    /no such item/,
  );

  const again = await vault.addLink(b.key, { type: "url", target: "https://example.com/doc" });
  assert.equal(again.links.length, 3, "duplicate links must not accumulate");
});

test("copies attachments into the vault, or points at them in place", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Has files" });

  const src = path.join(vault.root, "..", `sample-${Date.now()}.txt`);
  await fs.writeFile(src, "hello", "utf8");

  const copied = await vault.addAttachment(item.key, src, { copy: true });
  assert.equal(copied.attachments.length, 1);
  const stored = path.join(vault.root, copied.attachments[0].path);
  assert.equal(await fs.readFile(stored, "utf8"), "hello");

  const pointed = await vault.addAttachment(item.key, src, { copy: false });
  assert.ok(pointed.links.some((l) => l.type === "file" && path.isAbsolute(l.target)));

  await assert.rejects(() => vault.addAttachment(item.key, "/no/such/file"), /Cannot read/);
});

test("agenda surfaces overdue work and honours cadence", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Late thing", dueDate: "2026-01-05" });
  await vault.createItem({ project: "ACME", summary: "Due today", dueDate: "2026-06-17" });
  await vault.createItem({ project: "ACME", summary: "Standup", cadence: "daily" });
  await vault.createItem({ project: "ACME", summary: "Weekly report", cadence: "weekly" });
  const finished = await vault.createItem({ project: "ACME", summary: "Old", dueDate: "2026-01-01" });
  await vault.transition(finished.key, "done");

  const today = vault.agenda("today", "2026-06-17");
  const overdue = today.find((s) => s.scope === "overdue");
  assert.ok(overdue, "an overdue section should exist");
  assert.deepEqual(overdue.items.map((i) => i.summary), ["Late thing"]);
  assert.ok(!overdue.items.some((i) => i.summary === "Old"), "done items are never overdue");

  const todaySection = today.find((s) => s.scope === "today")!;
  const summaries = todaySection.items.map((i) => i.summary);
  assert.ok(summaries.includes("Due today"));
  assert.ok(summaries.includes("Standup"));
  assert.ok(!summaries.includes("Weekly report"), "weekly cadence is out of scope for today");

  const week = vault.agenda("week", "2026-06-17").find((s) => s.scope === "week")!;
  assert.ok(week.items.some((i) => i.summary === "Weekly report"));
  assert.equal(week.from, "2026-06-15", "weeks run Monday to Sunday");
});

test("converts markdown to ADF", () => {
  const doc = markdownToAdf(
    "# Heading\n\nSome **bold** and a [link](https://x.dev).\n\n- one\n- two\n\n```ts\nconst a = 1;\n```",
  );
  assert.equal(doc.type, "doc");
  const content = doc.content as Array<{ type: string; content?: unknown[] }>;
  assert.deepEqual(
    content.map((n) => n.type),
    ["heading", "paragraph", "bulletList", "codeBlock"],
  );
  const para = content[1].content as Array<{ text: string; marks?: Array<{ type: string }> }>;
  assert.ok(para.some((n) => n.marks?.some((m) => m.type === "strong")));
  assert.ok(para.some((n) => n.marks?.some((m) => m.type === "link")));
});

test("builds a Jira plan with parents before children, and skips unchanged pushes", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Migration" });
  const task = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Cut over DNS",
    parent: epic.key,
    dueDate: "2026-09-01",
    startDate: "2026-08-25",
    category: "Platform work",
  });

  const map = JiraMapSchema.parse({
    jiraProjectKey: "ENG",
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Bug", subtask: "Subtask" },
    fields: { startDate: "customfield_10015", category: "labels" },
  });

  const plan = buildPushPlan(vault.listItems({ limit: 500 }).items, map, vault);
  assert.equal(plan.drafts[0].localKey, epic.key, "epics must be created first");
  const taskDraft = plan.drafts.find((d) => d.localKey === task.key)!;
  assert.equal(taskDraft.parentLocalKey, epic.key);
  assert.equal(taskDraft.fields.duedate, "2026-09-01");
  assert.equal(taskDraft.fields.customfield_10015, "2026-08-25");
  assert.deepEqual(taskDraft.fields.labels, ["Platform-work"]);

  await vault.markPushed(epic.key, "ENG-1");
  await vault.load();
  const second = buildPushPlan(vault.listItems({ limit: 500 }).items, map, vault);
  assert.ok(second.skipped.some((s) => s.localKey === epic.key));
  const taskAfter = second.drafts.find((d) => d.localKey === task.key)!;
  assert.deepEqual(taskAfter.fields.parent, { key: "ENG-1" }, "a pushed parent is linked by Jira key");
});

test("warns when a missing start date field would silently drop data", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Has a start date", startDate: "2026-08-01" });
  const map = JiraMapSchema.parse({
    jiraProjectKey: "ENG",
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Bug", subtask: "Subtask" },
  });
  const plan = buildPushPlan(vault.listItems({ limit: 500 }).items, map, vault);
  assert.ok(plan.warnings.some((w) => /fields.startDate/.test(w)));
});

test("flags drift after a pushed item is edited", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.markPushed(item.key, "ENG-9");

  const untouched = await vault.updateItem(item.key, { cadence: "weekly" });
  assert.equal(untouched.sync.state, "pushed", "local-only fields must not count as drift");

  const changed = await vault.updateItem(item.key, { summary: "Changed after push" });
  assert.equal(changed.sync.state, "drifted");
});

test("doctor-style load reports invalid files instead of throwing", async () => {
  const vault = await tmpVault();
  await fs.writeFile(
    vault.itemPath("ACME-77"),
    "---\nkey: ACME-77\ntype: banana\n---\n\nbroken\n",
    "utf8",
  );
  const { errors } = await vault.load();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ACME-77/);
});
