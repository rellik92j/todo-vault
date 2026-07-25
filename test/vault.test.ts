import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Vault } from "../src/vault.js";
import { buildPushPlan, markdownToAdf, JiraMapSchema } from "../src/jira.js";
import { parseFrontmatter } from "../src/markdown.js";
import { RANK_GAP, rankBetween } from "../src/util.js";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
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
  const overdue = today.find((s) => s.kind === "overdue");
  assert.ok(overdue, "an overdue section should exist");
  assert.deepEqual(overdue.items.map((i) => i.summary), ["Late thing"]);
  assert.ok(!overdue.items.some((i) => i.summary === "Old"), "done items are never overdue");

  const due = today.find((s) => s.kind === "due")!;
  assert.deepEqual(due.items.map((i) => i.summary), ["Due today"]);

  const recurring = today.find((s) => s.kind === "recurring")!;
  assert.deepEqual(
    recurring.items.map((i) => i.summary),
    ["Standup"],
    "daily cadence recurs today; weekly does not",
  );

  const week = vault.agenda("week", "2026-06-17");
  assert.ok(
    week.find((s) => s.kind === "recurring")!.items.some((i) => i.summary === "Weekly report"),
  );
  assert.equal(week.find((s) => s.kind === "due")!.from, "2026-06-15", "weeks run Monday to Sunday");
});

test("agenda keeps due work and recurring work in separate sections", async () => {
  const vault = await tmpVault();
  // Recurring *and* dated: it has a deadline, so it belongs under due, once.
  await vault.createItem({
    project: "ACME",
    summary: "Weekly rollup",
    cadence: "weekly",
    dueDate: "2026-06-18",
  });
  await vault.createItem({ project: "ACME", summary: "Standup", cadence: "daily" });
  await vault.createItem({ project: "ACME", summary: "Ship it", dueDate: "2026-06-19" });
  // Earlier in the same week as the reference date: overdue AND inside the
  // window, so it must be claimed by exactly one section.
  await vault.createItem({ project: "ACME", summary: "Slipped", dueDate: "2026-06-16" });

  const week = vault.agenda("week", "2026-06-17");
  assert.deepEqual(
    week.find((s) => s.kind === "overdue")!.items.map((i) => i.summary),
    ["Slipped"],
  );
  const due = week.find((s) => s.kind === "due")!;
  const recurring = week.find((s) => s.kind === "recurring")!;

  assert.deepEqual(due.items.map((i) => i.summary).sort(), ["Ship it", "Weekly rollup"]);
  assert.deepEqual(recurring.items.map((i) => i.summary), ["Standup"]);

  const everywhere = week.flatMap((s) => s.items.map((i) => i.key));
  assert.equal(
    new Set(everywhere).size,
    everywhere.length,
    "no item may be counted twice across sections",
  );
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

// ------------------------------------------------------------ manual ordering

test("rankBetween finds midpoints and reports when a gap has closed", () => {
  assert.equal(rankBetween(undefined, undefined), RANK_GAP);
  assert.equal(rankBetween(1000, 2000), 1500);
  assert.equal(rankBetween(1000, undefined), 2000);
  assert.equal(rankBetween(undefined, 1000), 500);
  assert.equal(rankBetween(1000, 1001), undefined, "adjacent integers leave no room");
  assert.equal(rankBetween(undefined, 0), undefined, "nothing sorts below zero");
});

test("moveItem reorders by hand and survives a closed gap", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "A" });
  const b = await vault.createItem({ project: "ACME", summary: "B" });
  const c = await vault.createItem({ project: "ACME", summary: "C" });

  const order = () =>
    vault.listItems({ sort: "rank" }).items.map((i) => i.summary);

  // Nothing is ranked yet, so rank order falls through to work order.
  assert.deepEqual(order(), ["A", "B", "C"]);

  // Drop C between A and B. The first manual move backfills ranks across the
  // whole project, so all three end up ranked and sort purely by rank.
  await vault.moveItem(c.key, { after: a.key, before: b.key });
  assert.deepEqual(order(), ["A", "C", "B"], "C lands between its two neighbours");

  const ranked = vault.getItem(c.key);
  assert.equal(typeof ranked.rank, "number");

  // Force the gap shut, then drop into it — moveItem must respace and succeed.
  await vault.updateItem(a.key, { rank: 1000 });
  await vault.updateItem(b.key, { rank: 1001 });
  const moved = await vault.moveItem(c.key, { after: a.key, before: b.key });

  assert.equal(typeof moved.rank, "number");
  const aRank = vault.getItem(a.key).rank as number;
  const bRank = vault.getItem(b.key).rank as number;
  assert.ok(
    aRank < (moved.rank as number) && (moved.rank as number) < bRank,
    `expected ${aRank} < ${moved.rank} < ${bRank} after respacing`,
  );
  assert.deepEqual(order(), ["A", "C", "B"]);
});

test("moveItem lands exactly where one-sided positions say", async () => {
  const vault = await tmpVault();
  const items = [];
  for (const summary of ["A", "B", "C", "D"]) {
    items.push(await vault.createItem({ project: "ACME", summary }));
  }
  const order = () => vault.listItems({ sort: "rank" }).items.map((i) => i.summary);
  assert.deepEqual(order(), ["A", "B", "C", "D"]);

  // Only `before` given. This must mean *immediately* before D — an open lower
  // bound would halve D's rank and collide with whatever already sits there.
  await vault.moveItem(items[0].key, { before: items[3].key });
  assert.deepEqual(order(), ["B", "C", "A", "D"]);

  // Only `after` given.
  await vault.moveItem(items[3].key, { after: items[1].key });
  assert.deepEqual(order(), ["B", "D", "C", "A"]);

  // Neither given: to the end.
  await vault.moveItem(items[1].key, {});
  assert.deepEqual(order(), ["D", "C", "A", "B"]);

  // No two items may share a rank, or the order is decided by key as a tiebreak
  // rather than by the drag.
  const ranks = vault.listItems({ sort: "rank" }).items.map((i) => i.rank);
  assert.equal(new Set(ranks).size, ranks.length, `ranks must be distinct: ${ranks.join(", ")}`);
});

test("moveItem refuses nonsense positions", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "A" });
  await vault.createProject({ key: "OPS", name: "Ops" });
  const other = await vault.createItem({ project: "OPS", summary: "Elsewhere" });

  await assert.rejects(() => vault.moveItem(a.key, { after: a.key }), /relative to itself/);
  await assert.rejects(() => vault.moveItem(a.key, { after: other.key }), /per project/);
});

test("work order and rank order stay separate sorts", async () => {
  const vault = await tmpVault();
  const urgent = await vault.createItem({
    project: "ACME",
    summary: "Urgent",
    dueDate: "2026-01-01",
  });
  const whenever = await vault.createItem({ project: "ACME", summary: "Whenever" });

  // Put the non-urgent one first by hand.
  await vault.moveItem(whenever.key, { before: urgent.key });

  assert.deepEqual(
    vault.listItems({ sort: "work" }).items.map((i) => i.summary),
    ["Urgent", "Whenever"],
    "work order ignores rank and leads with the due date",
  );
  assert.deepEqual(
    vault.listItems({ sort: "rank" }).items.map((i) => i.summary),
    ["Whenever", "Urgent"],
    "rank order honours the drag",
  );
});

// -------------------------------------------------------------------- trash

test("deleteItem trashes rather than destroys, and restores", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Deleted but recoverable",
    description: "Body text that must survive the round trip.",
  });

  const src = path.join(vault.root, "..", `trash-fixture-${Date.now()}.txt`);
  await fs.writeFile(src, "attached", "utf8");
  await vault.addAttachment(item.key, src, { copy: true });
  await fs.rm(src, { force: true });

  const [result] = await vault.deleteItem(item.key);
  assert.equal(result.key, item.key);
  assert.match(result.trashedTo, /^\.trash\//);
  assert.ok(result.attachmentsTrashedTo, "the attachment folder goes with it");
  assert.equal(vault.hasItem(item.key), false, "gone from the index immediately");

  // Gone from disk in items/, present in .trash/ — recovery needs no git.
  assert.equal(await exists(vault.itemPath(item.key)), false);
  assert.equal(await exists(path.join(vault.root, result.trashedTo)), true);

  // A reload must not resurrect it: load() only reads items/ and projects/.
  await vault.load();
  assert.equal(vault.hasItem(item.key), false);

  const trash = await vault.listTrash();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].key, item.key);
  assert.equal(trash[0].summary, "Deleted but recoverable");
  assert.equal(trash[0].hasAttachments, true);

  const restored = await vault.restoreItem(trash[0].file);
  assert.equal(restored.key, item.key);
  assert.equal(restored.description, "Body text that must survive the round trip.");
  assert.equal(vault.hasItem(item.key), true);
  assert.equal(await exists(vault.attachmentDir(item.key)), true, "attachments come back too");
  assert.deepEqual(await vault.listTrash(), []);
});

test("deleteItem will not silently orphan children", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Epic" });
  const story = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Story",
    parent: epic.key,
  });
  const sub = await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Subtask",
    parent: story.key,
  });

  await assert.rejects(() => vault.deleteItem(epic.key), /beneath it/);
  assert.equal(vault.hasItem(epic.key), true, "the refusal must not have deleted anything");

  const results = await vault.deleteItem(epic.key, { cascade: true });
  assert.deepEqual(
    results.map((r) => r.key).sort(),
    [epic.key, story.key, sub.key].sort(),
    "cascade takes the whole subtree",
  );
  assert.equal(vault.listItems().total, 0);
});

test("deleteItem reports the links it leaves dangling", async () => {
  const vault = await tmpVault();
  const target = await vault.createItem({ project: "ACME", summary: "Linked to" });
  const source = await vault.createItem({ project: "ACME", summary: "Links out" });
  await vault.addLink(source.key, { type: "item", target: target.key });

  const [result] = await vault.deleteItem(target.key);
  assert.deepEqual(result.danglingBacklinks, [source.key]);
});

test("restoreItem refuses a path, an occupied key, and a missing parent", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Epic" });
  const story = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Story",
    parent: epic.key,
  });

  await assert.rejects(() => vault.restoreItem("../../etc/passwd"), /got a path/);
  await assert.rejects(() => vault.restoreItem("nope.md"), /Nothing called/);

  // Trash the story, then the epic. Restoring the story first must fail.
  const [storyTrash] = await vault.deleteItem(story.key);
  await vault.deleteItem(epic.key);
  await assert.rejects(
    () => vault.restoreItem(path.basename(storyTrash.trashedTo)),
    /not in the vault/,
  );

  // A key that is occupied again blocks the restore rather than being
  // overwritten. An external edit could put one back, so copy the trashed file
  // into items/ and reload to reproduce exactly that.
  const solo = await vault.createItem({ project: "ACME", summary: "Solo" });
  const [soloTrash] = await vault.deleteItem(solo.key);
  await fs.copyFile(path.join(vault.root, soloTrash.trashedTo), vault.itemPath(solo.key));
  await vault.load();

  assert.equal(vault.hasItem(solo.key), true);
  await assert.rejects(
    () => vault.restoreItem(path.basename(soloTrash.trashedTo)),
    /exists again/,
  );
});

// ----------------------------------------------------------------- projects

test("updateProject patches fields and clears them with null", async () => {
  const vault = await tmpVault();
  const updated = await vault.updateProject("ACME", {
    name: "Acme, renamed",
    lead: "someone",
    dueDate: "2026-12-01",
    status: "on_hold",
    description: "New blurb.",
  });
  assert.equal(updated.name, "Acme, renamed");
  assert.equal(updated.lead, "someone");
  assert.equal(updated.status, "on_hold");
  assert.equal(updated.description, "New blurb.");

  const cleared = await vault.updateProject("ACME", { lead: null, dueDate: null });
  assert.equal(cleared.lead, undefined);
  assert.equal(cleared.dueDate, undefined);

  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.getProject("ACME").name, "Acme, renamed");
  assert.equal(reopened.getProject("ACME").lead, undefined);
});

test("renameProject re-keys every item and every reference to them", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Epic" });
  const story = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Story",
    parent: epic.key,
  });
  const sub = await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Subtask",
    parent: story.key,
  });
  await vault.addLink(epic.key, { type: "item", target: story.key, label: "its story" });

  // An item in another project pointing in, which must be repointed too.
  await vault.createProject({ key: "OPS", name: "Ops" });
  const outsider = await vault.createItem({ project: "OPS", summary: "Watches ACME" });
  await vault.addLink(outsider.key, { type: "item", target: story.key });

  const src = path.join(vault.root, "..", `rename-fixture-${Date.now()}.txt`);
  await fs.writeFile(src, "x", "utf8");
  await vault.addAttachment(story.key, src, { copy: true });
  await fs.rm(src, { force: true });

  const ids = new Map([...vault.listItems().items].map((i) => [i.key, i.id]));

  const renamed = await vault.renameProject("ACME", "NEW");
  assert.equal(renamed.key, "NEW");

  // Numbers are preserved, so ACME-1 becomes NEW-1.
  assert.equal(vault.hasItem("ACME-1"), false);
  const newEpic = vault.getItem("NEW-1");
  const newStory = vault.getItem("NEW-2");
  const newSub = vault.getItem("NEW-3");
  assert.equal(newEpic.project, "NEW");
  assert.equal(newStory.parent, "NEW-1", "parents are repointed");
  assert.equal(newSub.parent, "NEW-2");
  assert.equal(newEpic.links[0].target, "NEW-2", "item links are repointed");
  assert.equal(
    vault.getItem(outsider.key).links[0].target,
    "NEW-2",
    "links from other projects are repointed too",
  );

  // Identity survives even though the key did not.
  assert.equal(newEpic.id, ids.get(epic.key));
  assert.equal(newStory.id, ids.get(story.key));

  // Attachments follow, both the folder and the recorded path.
  assert.match(newStory.attachments[0].path, /^attachments\/NEW-2\//);
  assert.equal(await exists(vault.resolveAttachment(newStory.attachments[0].path)), true);
  assert.equal(await exists(vault.attachmentDir("ACME-2")), false);

  // The old files are gone and nothing is left broken on disk.
  assert.equal(await exists(vault.itemPath("ACME-1")), false);
  assert.equal(await exists(vault.projectPath("ACME")), false);
  const reopened = await Vault.open(vault.root);
  assert.deepEqual((await reopened.load()).errors, []);
  assert.equal(reopened.getItem("NEW-3").parent, "NEW-2");

  // And the counter came across, so numbers are not reissued under the new key.
  const next = await reopened.createItem({ project: "NEW", summary: "After the rename" });
  assert.equal(next.key, "NEW-4");
});

test("renameProject refuses a bad or occupied key", async () => {
  const vault = await tmpVault();
  await vault.createProject({ key: "OPS", name: "Ops" });
  await assert.rejects(() => vault.renameProject("ACME", "OPS"), /already exists/);
  await assert.rejects(() => vault.renameProject("ACME", "lower"), /not a valid project key/);
  assert.equal(vault.getProject("ACME").key, "ACME", "a refusal changes nothing");
});

test("moveItemsToProject issues new keys and takes the subtree along", async () => {
  const vault = await tmpVault();
  await vault.createProject({ key: "OPS", name: "Ops" });

  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Epic" });
  const story = await vault.createItem({
    project: "ACME",
    type: "story",
    summary: "Story",
    parent: epic.key,
  });
  const sub = await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Subtask",
    parent: story.key,
  });
  const storyId = story.id;

  // Moving the story takes its subtask, and drops the epic parent left behind.
  const result = await vault.moveItemsToProject(story.key, "OPS");
  assert.equal(result.parentDropped, epic.key);
  assert.deepEqual(result.rekeyed.map((r) => r.from), [story.key, sub.key]);

  const movedStory = vault.getItem("OPS-1");
  const movedSub = vault.getItem("OPS-2");
  assert.equal(movedStory.project, "OPS");
  assert.equal(movedStory.id, storyId, "identity survives the move");
  assert.equal(movedStory.parent, undefined, "the parent stayed behind");
  assert.equal(movedSub.parent, "OPS-1", "the subtree keeps its own shape");
  assert.equal(vault.hasItem(story.key), false);
  assert.equal(vault.hasItem(sub.key), false);

  const reopened = await Vault.open(vault.root);
  assert.deepEqual((await reopened.load()).errors, []);
});

test("moveItemsToProject respects an explicit new parent, and guards subtasks", async () => {
  const vault = await tmpVault();
  await vault.createProject({ key: "OPS", name: "Ops" });
  const opsEpic = await vault.createItem({ project: "OPS", type: "epic", summary: "Ops epic" });
  const acmeEpic = await vault.createItem({ project: "ACME", type: "epic", summary: "Acme epic" });
  const task = await vault.createItem({
    project: "ACME",
    type: "task",
    summary: "Task",
    parent: acmeEpic.key,
  });
  const sub = await vault.createItem({
    project: "ACME",
    type: "subtask",
    summary: "Subtask",
    parent: task.key,
  });

  // A subtask cannot be moved alone: clearing its parent would be invalid.
  await assert.rejects(() => vault.moveItemsToProject(sub.key, "OPS"), /Name a parent in OPS/);
  // Nor onto a parent in the wrong project.
  await assert.rejects(
    () => vault.moveItemsToProject(task.key, "OPS", { parent: acmeEpic.key }),
    /is in ACME, not OPS/,
  );

  const result = await vault.moveItemsToProject(task.key, "OPS", { parent: opsEpic.key });
  assert.equal(result.parentDropped, undefined);
  const moved = vault.getItem(result.rekeyed[0].to);
  assert.equal(moved.parent, opsEpic.key);
  assert.deepEqual((await Vault.open(vault.root).then((v) => v.load())).errors, []);
});

test("deleteProject will not quietly take its items with it", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", type: "epic", summary: "Epic" });
  await vault.createItem({ project: "ACME", type: "story", summary: "Story", parent: epic.key });

  await assert.rejects(() => vault.deleteProject("ACME"), /still holds 2 item/);
  assert.equal(vault.listProjects().length, 1, "the refusal deleted nothing");

  const result = await vault.deleteProject("ACME", { cascade: true });
  assert.equal(result.items.length, 2);
  assert.match(result.trashedTo, /^\.trash\/projects\//);
  assert.equal(vault.listProjects().length, 0);
  assert.equal(vault.listItems().total, 0);

  // Project and item trash are listed separately, and the project filename is
  // not mistaken for an item key.
  const projects = await vault.listTrashedProjects();
  assert.equal(projects.length, 1);
  assert.equal(projects[0].key, "ACME");
  const items = await vault.listTrash();
  assert.equal(items.length, 2);
  assert.ok(items.every((e) => e.key.startsWith("ACME-")), "item keys keep their numbers");

  const restored = await vault.restoreProject(projects[0].file);
  assert.equal(restored.key, "ACME");
  assert.equal(vault.listItems().total, 0, "items stay in the trash, restored separately");

  await vault.restoreItem(items[0].file);
  assert.equal(vault.listItems().total, 1);
});

// ------------------------------------------------------- portability and git

test("attachment paths are stored POSIX-style on every platform", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Portable paths" });

  const src = path.join(vault.root, "..", `posix-fixture-${Date.now()}.txt`);
  await fs.writeFile(src, "x", "utf8");
  const updated = await vault.addAttachment(item.key, src, { copy: true });
  await fs.rm(src, { force: true });

  const stored = updated.attachments[0].path;
  assert.ok(!stored.includes("\\"), `stored path must not contain backslashes: ${stored}`);
  assert.match(stored, /^attachments\/ACME-1\//);

  // And it still resolves to something real on this platform.
  assert.equal(await exists(vault.resolveAttachment(stored)), true);

  const raw = await fs.readFile(vault.itemPath(item.key), "utf8");
  assert.ok(!raw.includes("attachments\\"), "the file on disk must be portable too");
});

test("addComment validates instead of writing a file that will not load", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Comments" });

  await assert.rejects(() => vault.addComment(item.key, "   "), /needs a body/);

  // The rejection must not have left a broken file behind.
  const { errors } = await vault.load();
  assert.deepEqual(errors, []);

  const commented = await vault.addComment(item.key, "  trimmed  ");
  assert.equal(commented.comments[0].body, "trimmed");
});

test("gitStatus tells the truth about whether history is being kept", async () => {
  const withoutGit = await tmpVault();
  const off = await withoutGit.gitStatus();
  assert.equal(off.enabled, false);
  assert.equal(off.healthy, false, "auto-commit was never asked for");

  // Asking for git in a directory that is not a repo is the dangerous case:
  // every write succeeds and no history is kept.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-nogit-"));
  const notARepo = await Vault.init(dir, { git: true });
  await notARepo.createProject({ key: "ACME", name: "Acme" });
  await notARepo.createItem({ project: "ACME", summary: "Unversioned" });

  const status = await notARepo.gitStatus();
  assert.equal(status.enabled, true);
  assert.equal(status.isRepo, false);
  assert.equal(status.healthy, false, "must not claim health outside a repo");
  assert.ok(status.lastError, "and must say why, rather than staying quiet");
});
