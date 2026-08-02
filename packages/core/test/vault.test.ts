import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { Vault } from "../src/vault.js";
import type { Item } from "../src/schema.js";
import {
  isLosslessDescription,
  parseDescription,
  serializeDescription,
  type Block,
} from "../src/description.js";
import { buildPushPlan, markdownToAdf, JiraMapSchema } from "../src/jira.js";
import { parseFrontmatter } from "../src/markdown.js";
import { isTransientRenameError, RANK_GAP, rankBetween, writeFileAtomic } from "../src/util.js";
import { cadencePeriod, todayIso, addDays } from "../src/recurrence.js";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

const execFileAsync = promisify(execFile);

/** A vault backed by a real git repo, for tests that count commits. */
async function gitVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-git-test-"));
  await execFileAsync("git", ["init"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  const vault = await Vault.init(dir, { git: true });
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

async function commitCount(dir: string): Promise<number> {
  const { stdout } = await execFileAsync("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
  return Number.parseInt(stdout.trim(), 10);
}

/** The minimum map buildPushPlan needs, for tests that care about eligibility. */
function planMap() {
  return JiraMapSchema.parse({
    jiraProjectKey: "ENG",
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Bug", subtask: "Subtask" },
  });
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
    assignee: "Sam Okafor",
    reporter: "Priya Raman",
  });

  const reopened = await Vault.open(vault.root);
  const loaded = reopened.getItem(created.key);
  assert.equal(loaded.summary, "Send the vendor SOW");
  assert.equal(loaded.dueDate, "2026-08-14");
  assert.equal(loaded.cadence, "weekly");
  assert.deepEqual(loaded.labels, ["vendor", "legal"]);
  assert.equal(loaded.assignee, "Sam Okafor");
  assert.equal(loaded.reporter, "Priya Raman");
  assert.match(loaded.description, /legal review/);
});

/*
 * Reporter is set from three surfaces that cannot see each other — the app's form,
 * the CLI's --reporter, and the MCP server's tool schema — so the field is only
 * useful if a name typed into one is findable from another. These cover the two
 * ways it gets read back: the filter, and free-text search.
 */
test("filters by reporter, folding case the way the app's menu does", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Raised properly", reporter: "John Doe" });
  await vault.createItem({ project: "ACME", summary: "Raised again", reporter: "john doe" });
  await vault.createItem({ project: "ACME", summary: "Someone else", reporter: "Priya Raman" });
  await vault.createItem({ project: "ACME", summary: "Nobody asked" });

  const summaries = (reporter: string): string[] =>
    vault
      .listItems({ reporter })
      .items.map((i) => i.summary)
      .sort();

  // knownReporters offers one menu entry per person, so both spellings have to
  // come back however the filter value was capitalised — otherwise picking a name
  // off that menu silently hides half of what it claims to match.
  assert.deepEqual(summaries("john doe"), ["Raised again", "Raised properly"]);
  assert.deepEqual(summaries("JOHN DOE"), ["Raised again", "Raised properly"]);
  assert.deepEqual(summaries("  John Doe  "), ["Raised again", "Raised properly"]);
  assert.deepEqual(summaries("Priya Raman"), ["Someone else"]);
  assert.deepEqual(summaries("Nobody"), [], "an unused name matches nothing, not everything");

  // The point of the field: a name in `reporter` is queryable, where the same name
  // buried in the description prose would only ever surface by accident.
  assert.deepEqual(
    vault
      .listItems({ text: "priya" })
      .items.map((i) => i.summary),
    ["Someone else"],
  );
});

test("reporter survives an update, and null clears it", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Check who asked",
    reporter: "Priya Raman",
  });

  const renamed = await vault.updateItem(item.key, { reporter: "Sam Okafor" });
  assert.equal(renamed.reporter, "Sam Okafor");

  const cleared = await vault.updateItem(item.key, { reporter: null });
  assert.equal(cleared.reporter, undefined);

  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.getItem(item.key).reporter, undefined, "the clear has to reach disk");
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

test("starting something dates it, whichever way the status is set", async () => {
  const vault = await tmpVault();

  const dragged = await vault.createItem({ project: "ACME", summary: "Via transition" });
  assert.equal(dragged.startDate, undefined, "nothing types a start date up front");
  const started = await vault.transition(dragged.key, "in_progress");
  assert.equal(started.startDate, todayIso());

  // The caller a rule written inside transition() would silently skip.
  const patched = await vault.createItem({ project: "ACME", summary: "Via updateItem" });
  const direct = await vault.updateItem(patched.key, { status: "in_progress" });
  assert.equal(direct.startDate, todayIso(), "vault_update_item and `vault set --status` land here");

  // Born in progress, so there is no transition to hang the rule on.
  const born = await vault.createItem({
    project: "ACME",
    summary: "Born in progress",
    status: "in_progress",
  });
  assert.equal(born.startDate, todayIso());

  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.getItem(started.key).startDate, todayIso(), "and it survives a round trip");
});

test("the start stamp never overwrites, and never blocks the move", async () => {
  const vault = await tmpVault();

  const planned = await vault.createItem({
    project: "ACME",
    summary: "Started when I said",
    startDate: "2026-01-05",
  });
  const kept = await vault.transition(planned.key, "in_progress");
  assert.equal(kept.startDate, "2026-01-05", "an explicit date always wins");

  // dueDate cannot precede startDate, so stamping an overdue item would reject
  // the whole write — including the status change, which works today.
  const overdue = await vault.createItem({
    project: "ACME",
    summary: "Overdue before it began",
    dueDate: addDays(todayIso(), -7),
  });
  const moved = await vault.transition(overdue.key, "in_progress");
  assert.equal(moved.status, "in_progress", "the drag must still succeed");
  assert.equal(moved.startDate, undefined, "and it is skipped rather than clamped");

  // Due today is legal: the schema rejects startDate > dueDate, not equality.
  const dueToday = await vault.createItem({
    project: "ACME",
    summary: "Due today",
    dueDate: todayIso(),
  });
  assert.equal((await vault.transition(dueToday.key, "in_progress")).startDate, todayIso());
});

test("any route into in_progress stamps, and no other status does", async () => {
  const vault = await tmpVault();

  // todo -> blocked -> in_progress is the ordinary shape of picking up work
  // that was waiting on somebody, and the narrow todo-only rule misses it.
  const waiting = await vault.createItem({ project: "ACME", summary: "Was blocked" });
  await vault.transition(waiting.key, "blocked");
  assert.equal((await vault.transition(waiting.key, "in_progress")).startDate, todayIso());

  const closed = await vault.createItem({ project: "ACME", summary: "Straight to done" });
  const done = await vault.transition(closed.key, "done");
  assert.equal(done.startDate, undefined, "only in_progress means started");

  const dropped = await vault.createItem({ project: "ACME", summary: "Not doing it" });
  assert.equal((await vault.transition(dropped.key, "disregard")).startDate, undefined);

  // Reopening an item that already ran keeps the date it started the first time.
  const resumed = await vault.transition(waiting.key, "done");
  const again = await vault.transition(resumed.key, "in_progress");
  assert.equal(again.startDate, todayIso(), "the original date, not a second one");
});

test("disregard closes an item without claiming the work happened", async () => {
  const vault = await tmpVault();
  const shelved = await vault.createItem({ project: "ACME", summary: "Waiting on legal" });
  await vault.transition(shelved.key, "blocked");

  // Straight from blocked, which `done` deliberately cannot do. Deciding not to
  // do something is not a claim that it was worked on, so it needs no route
  // through todo first.
  const dropped = await vault.transition(shelved.key, "disregard");
  assert.equal(dropped.status, "disregard");

  await assert.rejects(
    () => vault.transition(dropped.key, "in_review"),
    /From disregard you can go to/,
    "reopening still has to pass through work before review",
  );

  const live = await vault.createItem({ project: "ACME", summary: "Still live" });
  const abandoned = await vault.createItem({
    project: "ACME",
    summary: "Never happening",
    dueDate: "2026-01-05",
  });
  await vault.transition(abandoned.key, "disregard");

  assert.deepEqual(
    vault.listItems({ open: true }).items.map((i) => i.key),
    [live.key],
    "open-only listings exclude disregarded work as well as done work",
  );
  assert.equal(
    vault.listItems({ status: ["disregard"] }).total,
    2,
    "but it is still there when asked for by name",
  );
  assert.equal(
    vault.agenda("today", "2026-06-17").find((s) => s.kind === "overdue"),
    undefined,
    "a disregarded item is past its due date and nobody cares",
  );
  assert.equal(
    vault.listItems({}).items[0].key,
    live.key,
    "work order sinks closed items, disregarded ones included",
  );
});

// ------------------------------------------------------------- bulk update

test("updateItems writes every item and produces one commit", async () => {
  const vault = await gitVault();

  const items: Item[] = [];
  // Sequential: allocateKey reads and writes the shared counters file, which
  // is not safe for concurrent createItem calls.
  for (let i = 0; i < 5; i++) {
    items.push(await vault.createItem({ project: "ACME", summary: `Bulk ${i}` }));
  }
  const beforeBulk = await commitCount(vault.root);

  const result = await vault.updateItems(
    items.map((i) => i.key),
    { priority: "highest" },
  );

  assert.equal(result.updated.length, 5);
  assert.deepEqual(result.skipped, []);
  assert.ok(result.updated.every((i) => i.priority === "highest"));

  const afterBulk = await commitCount(vault.root);
  assert.equal(afterBulk, beforeBulk + 1, "one commit for the whole batch, not one per item");
});

test("an illegal transition in the set is skipped, the rest update, and the reason names what's reachable", async () => {
  const vault = await tmpVault();
  const todo = await vault.createItem({ project: "ACME", summary: "Still todo" });
  const working = await vault.createItem({ project: "ACME", summary: "Already in progress" });
  await vault.transition(working.key, "in_progress");

  // todo -> in_review is illegal; in_progress -> in_review is legal, so the
  // set has one bad key riding along with a good one.
  const result = await vault.updateItems([todo.key, working.key], { status: "in_review" });

  assert.deepEqual(
    result.updated.map((i) => i.key),
    [working.key],
  );
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].key, todo.key);
  assert.match(result.skipped[0].reason, /From todo you can go to/);
});

test("nothing is written when validation fails — the rejected item is untouched on disk", async () => {
  const vault = await tmpVault();
  const rejected = await vault.createItem({ project: "ACME", summary: "Rejected" });
  const accepted = await vault.createItem({ project: "ACME", summary: "Accepted" });
  await vault.transition(accepted.key, "in_progress");

  await vault.updateItems([rejected.key, accepted.key], { status: "in_review" });

  const reopened = await Vault.open(vault.root);
  assert.equal(
    reopened.getItem(rejected.key).updated,
    rejected.updated,
    "an item that fails validation must be exactly as createItem left it, not partially written",
  );
  assert.equal(reopened.getItem(accepted.key).status, "in_review");
});

test("bulk labels: add unions without duplicating, remove of an absent label is a no-op", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "A", labels: ["urgent"] });
  const b = await vault.createItem({
    project: "ACME",
    summary: "B",
    labels: ["urgent", "blocked-on-legal"],
  });

  const added = await vault.updateItems([a.key, b.key], {
    labels: { mode: "add", values: ["blocked-on-legal", "urgent"] },
  });
  assert.deepEqual(added.updated.find((i) => i.key === a.key)?.labels.slice().sort(), [
    "blocked-on-legal",
    "urgent",
  ]);
  assert.deepEqual(
    added.updated.find((i) => i.key === b.key)?.labels.slice().sort(),
    ["blocked-on-legal", "urgent"],
    "already present, so add must not duplicate it",
  );

  const removed = await vault.updateItems([a.key, b.key], {
    labels: { mode: "remove", values: ["nonexistent-label", "urgent"] },
  });
  assert.deepEqual(removed.updated.find((i) => i.key === a.key)?.labels, ["blocked-on-legal"]);
  assert.deepEqual(
    removed.updated.find((i) => i.key === b.key)?.labels,
    ["blocked-on-legal"],
    "removing a label that was never there is a no-op, not an error",
  );
});

test("the in_progress start-date stamp fires through the bulk path too", async () => {
  const vault = await tmpVault();
  const a = await vault.createItem({ project: "ACME", summary: "Bulk pickup A" });
  const b = await vault.createItem({ project: "ACME", summary: "Bulk pickup B" });

  const result = await vault.updateItems([a.key, b.key], { status: "in_progress" });

  assert.equal(result.skipped.length, 0);
  for (const item of result.updated) {
    assert.equal(
      item.startDate,
      todayIso(),
      "mergeUpdate's stamp must fire for every item in the batch, the same as the single-item path",
    );
  }
});

test("cadencePeriod bounds each cadence, and none has no period", () => {
  // A Wednesday, mid-month, mid-quarter — so every boundary below is a real
  // calculation rather than the reference date leaking through unchanged.
  const ref = "2026-06-17";
  assert.deepEqual(cadencePeriod("daily", ref), { from: ref, to: ref });
  assert.deepEqual(
    cadencePeriod("weekly", ref),
    { from: "2026-06-15", to: "2026-06-21" },
    "weeks run Monday to Sunday",
  );
  assert.deepEqual(cadencePeriod("monthly", ref), { from: "2026-06-01", to: "2026-06-30" });
  assert.deepEqual(cadencePeriod("quarterly", ref), { from: "2026-04-01", to: "2026-06-30" });
  assert.equal(cadencePeriod("none", ref), null);

  assert.deepEqual(
    cadencePeriod("weekly", "2026-06-15"),
    cadencePeriod("weekly", "2026-06-21"),
    "Monday and the Sunday after it are the same week",
  );
  assert.notDeepEqual(
    cadencePeriod("weekly", "2026-06-21"),
    cadencePeriod("weekly", "2026-06-22"),
    "but the Monday after that is not",
  );
  assert.deepEqual(cadencePeriod("monthly", "2026-02-03").to, "2026-02-28", "short months");
  assert.deepEqual(cadencePeriod("quarterly", "2026-12-31").from, "2026-10-01", "year end");
});

test("a tick records the date and leaves status alone", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Morning check",
    cadence: "daily",
  });

  const ticked = await vault.tickItem(item.key, "2026-06-17");
  assert.deepEqual(ticked.completions, ["2026-06-17"]);
  assert.equal(ticked.status, "todo", "a tick is not a transition");

  const again = await vault.tickItem(item.key, "2026-06-17");
  assert.deepEqual(again.completions, ["2026-06-17"], "ticking the same date twice is a no-op");

  // Backfilling an earlier day must not leave the list out of order.
  const backfilled = await vault.tickItem(item.key, "2026-06-15");
  assert.deepEqual(backfilled.completions, ["2026-06-15", "2026-06-17"]);

  const undone = await vault.untickItem(item.key, "2026-06-15");
  assert.deepEqual(undone.completions, ["2026-06-17"]);
  assert.deepEqual(
    (await vault.untickItem(item.key, "2020-01-01")).completions,
    ["2026-06-17"],
    "removing a date that was never there is a no-op, not an error",
  );

  const reopened = await Vault.open(vault.root);
  assert.deepEqual(
    reopened.getItem(item.key).completions,
    ["2026-06-17"],
    "completions survive the round trip through disk",
  );
});

test("ticking refuses an item with no cadence, and names the way out", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "One-off" });
  await assert.rejects(() => vault.tickItem(item.key, "2026-06-17"), /no cadence/);
  await assert.rejects(() => vault.tickItem(item.key, "2026-06-17"), /done instead/);
});

test("a ticked item leaves only the agenda windows its period covers", async () => {
  const vault = await tmpVault();
  const daily = await vault.createItem({ project: "ACME", summary: "Standup", cadence: "daily" });
  const weekly = await vault.createItem({ project: "ACME", summary: "Report", cadence: "weekly" });

  const recurringIn = (scope: "today" | "week", ref = "2026-06-17"): string[] =>
    vault.agenda(scope, ref).find((s) => s.kind === "recurring")?.items.map((i) => i.summary) ?? [];

  assert.deepEqual(recurringIn("today"), ["Standup"]);
  assert.deepEqual(recurringIn("week"), ["Standup", "Report"]);

  await vault.tickItem(daily.key, "2026-06-17");
  assert.deepEqual(recurringIn("today"), [], "today's daily work is done");
  assert.deepEqual(
    recurringIn("week"),
    ["Standup", "Report"],
    "but it comes round again tomorrow, which is inside this week",
  );

  await vault.tickItem(weekly.key, "2026-06-17");
  assert.deepEqual(
    recurringIn("week"),
    ["Standup"],
    "the weekly item's period covers the rest of the window, so it drops out",
  );

  // Yesterday's tick buys nothing today: the daily period has rolled over.
  await vault.untickItem(daily.key, "2026-06-17");
  await vault.tickItem(daily.key, "2026-06-16");
  assert.deepEqual(recurringIn("today"), ["Standup"], "a daily tick expires overnight");
});

test("a tick never marks a pushed item as drifted", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Weekly report",
    cadence: "weekly",
  });
  await vault.markPushed(item.key, "JIRA-1", "1");
  assert.equal(vault.getItem(item.key).sync.state, "pushed");

  const ticked = await vault.tickItem(item.key, "2026-06-17");
  assert.equal(
    ticked.sync.state,
    "pushed",
    "completions are local-only, so Jira has not gone stale",
  );
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

test("agenda's nextWeek scope covers the following Monday to Sunday", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "This week", dueDate: "2026-06-19" });
  await vault.createItem({ project: "ACME", summary: "Next week", dueDate: "2026-06-24" });
  await vault.createItem({ project: "ACME", summary: "Month after", dueDate: "2026-07-10" });
  await vault.createItem({ project: "ACME", summary: "Weekly report", cadence: "weekly" });
  await vault.createItem({ project: "ACME", summary: "Standup", cadence: "daily" });

  const nextWeek = vault.agenda("nextWeek", "2026-06-17");
  const due = nextWeek.find((s) => s.kind === "due")!;
  assert.equal(due.from, "2026-06-22");
  assert.equal(due.to, "2026-06-28");
  assert.deepEqual(due.items.map((i) => i.summary), ["Next week"]);

  const recurring = nextWeek.find((s) => s.kind === "recurring")!;
  assert.deepEqual(
    recurring.items.map((i) => i.summary).sort(),
    ["Standup", "Weekly report"],
    "daily and weekly cadences both recur next week",
  );

  assert.equal(
    nextWeek.find((s) => s.kind === "overdue"),
    undefined,
    "nothing is overdue relative to today in this fixture",
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

test("parses the description grammar into blocks", () => {
  const blocks = parseDescription(
    "## Plan\n\nFirst line\nsecond line\n\n- one **bold**\n- [two](https://x.dev)\n\n1. step\n\n> quoted\n> and still quoted\n\n```ts\nconst a = 1;\n```",
  );
  assert.deepEqual(
    blocks.map((b) => b.kind),
    ["heading", "paragraph", "list", "list", "quote", "code"],
  );

  const heading = blocks[0] as Extract<Block, { kind: "heading" }>;
  assert.equal(heading.level, 2);

  // The point of the whole exercise: a newline inside a paragraph survives as a
  // break rather than being joined away into one line.
  const paragraph = blocks[1] as Extract<Block, { kind: "paragraph" }>;
  assert.deepEqual(
    paragraph.content.map((n) => n.kind),
    ["text", "break", "text"],
  );

  const bullets = blocks[2] as Extract<Block, { kind: "list" }>;
  assert.equal(bullets.ordered, false);
  assert.equal(bullets.items.length, 2);
  assert.ok(bullets.items[0].some((n) => n.kind === "strong"));
  const link = bullets.items[1].find((n) => n.kind === "link");
  assert.equal(link?.kind === "link" ? link.href : null, "https://x.dev");

  assert.equal((blocks[3] as Extract<Block, { kind: "list" }>).ordered, true);

  // Both quoted lines belong to one blockquote, or the left rule renders as a
  // stack of separate quotes with a gap through it.
  const quote = blocks[4] as Extract<Block, { kind: "quote" }>;
  assert.deepEqual(
    quote.content.map((n) => n.kind),
    ["text", "break", "text"],
  );

  const code = blocks[5] as Extract<Block, { kind: "code" }>;
  assert.equal(code.language, "ts");
  assert.equal(code.text, "const a = 1;");
});

/** Every construct the grammar has, in one document. */
const RICH_DESCRIPTION = [
  "## Plan",
  "",
  "First line",
  "second line with **bold**, *em*, `code` and a [link](https://x.dev)",
  "",
  "- one",
  "- two",
  "",
  "1. step",
  "2. another step",
  "",
  "> quoted",
  "> and still quoted",
  "",
  "```ts",
  "const a = 1;",
  "```",
].join("\n");

test("serializeDescription writes back exactly what was parsed", () => {
  assert.equal(serializeDescription(parseDescription(RICH_DESCRIPTION)), RICH_DESCRIPTION);
  assert.ok(isLosslessDescription(RICH_DESCRIPTION));
});

test("parsing is idempotent across a write, for every shape the grammar takes", () => {
  // The property that actually matters. Byte equality is the stricter runtime
  // guard; this is the weaker one that must hold for *anything*, including the
  // inputs the guard rejects — otherwise a rejected description would still be
  // at risk the moment someone edited it in the raw box.
  const inputs = [
    RICH_DESCRIPTION,
    "",
    "just a sentence",
    "_underscore em_ and + a plus bullet",
    "+ plus\n+ bullets",
    "1) paren\n2) numbering",
    "7. starts\n9. at seven",
    "para\n\n\n\nwith blank runs",
    "  - indented bullet",
    "```\nno language\n```",
    "```\n```",
    "> lone quote",
    "###### deep heading",
    "| a | table |\n| - | - |",
    "<div>raw html</div>",
  ];

  for (const input of inputs) {
    const once = parseDescription(input);
    const twice = parseDescription(serializeDescription(once));
    assert.deepEqual(twice, once, `not idempotent for: ${JSON.stringify(input)}`);
  }
});

test("isLosslessDescription refuses anything a write would restyle", () => {
  // Each of these parses fine but writes back differently, so the app must edit
  // it as raw text rather than reformat someone's file behind them.
  for (const input of [
    "_underscore em_",
    "+ plus bullet",
    "* star bullet",
    "1) paren numbering",
    "7. starts at seven",
    "para\n\n\n\nwith a blank run",
    "  - indented bullet",
  ]) {
    assert.equal(isLosslessDescription(input), false, `should have been refused: ${input}`);
  }

  // ...and the everyday shapes must not be refused, or the rich editor would
  // never appear at all. Interior trailing spaces are in that list: they live
  // inside a text node and survive the trip, and the body's own trailing
  // whitespace is already gone by the time a description reaches this.
  for (const input of [
    "",
    "plain prose",
    "two\nlines",
    "- a\n- b",
    "**bold**",
    "trailing spaces   \nnext line",
  ]) {
    assert.equal(isLosslessDescription(input), true, `should have been allowed: ${input}`);
  }
});

test("every description in the worked example vault can be edited richly", async () => {
  // The fixture the desktop UI is developed against. If one of these ever falls
  // into raw-text fallback, the feature is being demoed against content that
  // does not exercise it.
  const dir = path.join(import.meta.dirname, "..", "..", "..", "vault", "items");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return; // No vault checked out here; nothing to assert.
  }

  for (const file of files.filter((f) => f.endsWith(".md"))) {
    const { body } = parseFrontmatter(await fs.readFile(path.join(dir, file), "utf8"));
    assert.ok(isLosslessDescription(body), `${file} would fall back to raw editing`);
  }
});

test("a line break in a description reaches Jira as a hardBreak", () => {
  const doc = markdownToAdf("First line\nsecond line");
  const content = doc.content as Array<{ type: string; content: Array<{ type: string }> }>;
  assert.equal(content.length, 1, "one paragraph, not two");
  assert.deepEqual(
    content[0].content.map((n) => n.type),
    ["text", "hardBreak", "text"],
  );
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

test("a drifted item is warned about rather than drafted in silence", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.markPushed(item.key, "ENG-9");
  await vault.updateItem(item.key, { summary: "Changed after push" });
  await vault.load();

  const plan = buildPushPlan(vault.listItems({ limit: 500 }).items, planMap(), vault);
  assert.ok(
    plan.warnings.some((w) => w.includes(item.key) && /creates a NEW issue/.test(w)),
    "a drifted item must say it is about to duplicate ENG-9, not appear as an ordinary draft",
  );
  assert.ok(plan.drafts.some((d) => d.localKey === item.key));
});

test("a drifted item reverted to its pushed content is skipped", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.markPushed(item.key, "ENG-9");
  await vault.updateItem(item.key, { summary: "Changed after push" });
  const reverted = await vault.updateItem(item.key, { summary: "Original" });
  await vault.load();

  // updateItem only ever moves pushed -> drifted, so the label is still wrong here.
  assert.equal(reverted.sync.state, "drifted", "the state does not heal on its own");

  const plan = buildPushPlan(vault.listItems({ limit: 500 }).items, planMap(), vault);
  assert.ok(
    plan.skipped.some((s) => s.localKey === item.key),
    "the hash matches Jira again, so this must not be re-drafted on the label alone",
  );
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.drafts.length, 0);
});

test("a link added after a push counts as drift", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.markPushed(item.key, "ENG-9");

  // Links are pushed inside the description footer, so adding one leaves Jira
  // holding a description this item no longer matches.
  const linked = await vault.addLink(item.key, { type: "url", target: "https://example.com/spec" });
  assert.equal(linked.sync.state, "drifted");

  await vault.load();
  const plan = buildPushPlan(vault.listItems({ limit: 500 }).items, planMap(), vault);
  assert.ok(
    plan.warnings.some((w) => w.includes(item.key)),
    "an item whose footer has changed must not be skipped as unchanged",
  );
});

test("drift sees a link's target and label, not just its type", async () => {
  // contentHash hands Object.keys() to JSON.stringify as a replacer allowlist,
  // which filters object properties at every depth. Hashing raw link objects
  // would keep `type` (a top-level field name) and drop `target` and `label`,
  // so these two edits are the ones that would silently go unnoticed.
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.addLink(item.key, { type: "url", target: "https://example.com/one", label: "Spec" });
  await vault.markPushed(item.key, "ENG-9");

  await vault.removeLink(item.key, "https://example.com/one");
  const retargeted = await vault.addLink(item.key, {
    type: "url",
    target: "https://example.com/two",
    label: "Spec",
  });
  assert.equal(retargeted.sync.state, "drifted", "a link pointing somewhere else is a change");
});

test("an unrelated write does not drift a pushed item that has links", async () => {
  // The check runs in persist(), which sees the item *before* writeAndIndex
  // parses it, while markPushed stamped a hash of an already-parsed one. Nothing
  // in LinkSchema defaults or transforms, so the two agree — this is the test
  // that says so, because if that ever stopped being true every pushed item
  // with a link would read `drifted` after any edit at all.
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.addLink(item.key, { type: "url", target: "https://example.com/one", label: "Spec" });
  await vault.markPushed(item.key, "ENG-9");

  const commented = await vault.addComment(item.key, "Unrelated note");
  assert.equal(commented.sync.state, "pushed", "a comment is not pushed, so it is not drift");

  const ranked = await vault.moveItem(item.key, {});
  assert.equal(ranked.sync.state, "pushed", "nor is a manual reorder");
});

test("a link's label is part of the pushed footer, so it counts too", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Original" });
  await vault.addLink(item.key, { type: "url", target: "https://example.com/one", label: "Spec" });
  const pushed = await vault.markPushed(item.key, "ENG-9");

  const before = pushed.sync.contentHash;
  await vault.removeLink(item.key, "https://example.com/one");
  const relabelled = await vault.addLink(item.key, {
    type: "url",
    target: "https://example.com/one",
    label: "Design",
  });
  assert.equal(relabelled.sync.state, "drifted", "only the label moved, and it is rendered");
  assert.equal(relabelled.sync.contentHash, before, "the baseline itself must not be rewritten");
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

test("hideProject refuses while the project still holds live work, and names it", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Still going" });
  await vault.createItem({ project: "ACME", summary: "Also going" });

  await assert.rejects(
    () => vault.hideProject("ACME"),
    /still has 2 item\(s\) that are not done or disregarded: ACME-1, ACME-2/,
  );
  assert.equal(vault.getProject("ACME").status, "active", "the refusal changed nothing");

  // Both endings count as closed, not just `done` — disregarded work is
  // finished with too, and a project full of it is exactly what you hide.
  await vault.transition("ACME-1", "done");
  await vault.transition("ACME-2", "disregard");

  const hidden = await vault.hideProject("ACME");
  assert.equal(hidden.status, "archived");
  assert.equal((await Vault.open(vault.root)).getProject("ACME").status, "archived");

  // Hiding is not deleting: the project and its items are all still here, and
  // listProjects stays unfiltered so the CLI and MCP server still see them.
  assert.equal(vault.listProjects().length, 1);
  assert.equal(vault.listItems().total, 2);
});

test("unhiding reactivates, and updateProject will not archive behind hideProject's back", async () => {
  const vault = await tmpVault();
  await vault.hideProject("ACME");

  const shown = await vault.unhideProject("ACME");
  assert.equal(shown.status, "active");
  assert.equal((await Vault.open(vault.root)).getProject("ACME").status, "active");

  // Both directions are no-ops when they are already where they are asked to go.
  assert.equal((await vault.unhideProject("ACME")).status, "active");

  // The open-items rule is enforced in hideProject, so the generic setter must
  // not offer a second way in — otherwise `vault project set --status archived`
  // hides a project full of open work.
  await vault.createItem({ project: "ACME", summary: "Open" });
  await assert.rejects(
    () => vault.updateProject("ACME", { status: "archived" }),
    /Use hideProject/,
  );
  assert.equal(vault.getProject("ACME").status, "active");

  // Every other status still goes through the normal path.
  assert.equal((await vault.updateProject("ACME", { status: "on_hold" })).status, "on_hold");
});

test("moveProject reorders the project list by hand", async () => {
  const vault = await tmpVault(); // ACME
  for (const [key, name] of [["BETA", "Beta"], ["OPS", "Ops"], ["ZED", "Zed"]] as const) {
    await vault.createProject({ key, name });
  }
  const order = () => vault.listProjects().map((p) => p.key);

  // Nothing ranked yet, so the list reads exactly as it did before ranks existed.
  assert.deepEqual(order(), ["ACME", "BETA", "OPS", "ZED"]);

  // Only `before` given: immediately before ZED, not merely somewhere above it.
  await vault.moveProject("ACME", { before: "ZED" });
  assert.deepEqual(order(), ["BETA", "OPS", "ACME", "ZED"]);

  await vault.moveProject("ZED", { after: "BETA" });
  assert.deepEqual(order(), ["BETA", "ZED", "OPS", "ACME"]);

  // Neither side: to the end.
  await vault.moveProject("BETA", {});
  assert.deepEqual(order(), ["ZED", "OPS", "ACME", "BETA"]);

  const ranks = vault.listProjects().map((p) => p.rank);
  assert.equal(new Set(ranks).size, ranks.length, `ranks must be distinct: ${ranks.join(", ")}`);

  // A new project lands at the end rather than in the middle of a hand-arranged
  // list, because unranked sorts after ranked.
  await vault.createProject({ key: "NEW", name: "New" });
  assert.deepEqual(order(), ["ZED", "OPS", "ACME", "BETA", "NEW"]);

  // And the order survives a round trip through disk.
  const reopened = await Vault.open(vault.root);
  assert.deepEqual(reopened.listProjects().map((p) => p.key), [
    "ZED",
    "OPS",
    "ACME",
    "BETA",
    "NEW",
  ]);
});

test("moveProject respaces a closed gap and refuses nonsense", async () => {
  const vault = await tmpVault();
  await vault.createProject({ key: "BETA", name: "Beta" });
  await vault.createProject({ key: "OPS", name: "Ops" });

  await assert.rejects(() => vault.moveProject("ACME", { after: "ACME" }), /relative to itself/);
  await assert.rejects(
    () => vault.moveProject("ACME", { before: "NOPE" }),
    /No project with key NOPE/,
  );

  await vault.updateProject("ACME", { rank: 1000 });
  await vault.updateProject("BETA", { rank: 1001 });
  await vault.updateProject("OPS", { rank: 2000 });

  const moved = await vault.moveProject("OPS", { after: "ACME", before: "BETA" });
  const acme = vault.getProject("ACME").rank as number;
  const beta = vault.getProject("BETA").rank as number;
  assert.ok(
    acme < (moved.rank as number) && (moved.rank as number) < beta,
    `expected ${acme} < ${moved.rank} < ${beta} after respacing`,
  );
  assert.deepEqual(vault.listProjects().map((p) => p.key), ["ACME", "OPS", "BETA"]);
});

test("project rank survives a rename", async () => {
  const vault = await tmpVault();
  await vault.createProject({ key: "BETA", name: "Beta" });
  await vault.moveProject("BETA", { before: "ACME" });
  assert.deepEqual(vault.listProjects().map((p) => p.key), ["BETA", "ACME"]);

  const renamed = await vault.renameProject("BETA", "GAMMA");
  assert.equal(typeof renamed.rank, "number");
  assert.deepEqual(
    vault.listProjects().map((p) => p.key),
    ["GAMMA", "ACME"],
    "a rename must not silently send the project to the back of the list",
  );
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

// ------------------------------------------------------------- atomic writes

// Staging a real EPERM by holding a file handle open is not attempted here:
// on Windows it depends on how the OS and antivirus schedule things, varies
// machine to machine, and would make this suite flaky for no honest gain.
// What can be tested straightforwardly is the predicate that decides what
// counts as transient, and that writeFileAtomic's happy path — now wrapped in
// a retry it should never need — still writes, overwrites, creates missing
// directories, and leaves no temp file behind.

function errorWithCode(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

test("isTransientRenameError recognizes only the transient Windows codes", () => {
  assert.equal(isTransientRenameError(errorWithCode("EPERM")), true);
  assert.equal(isTransientRenameError(errorWithCode("EACCES")), true);
  assert.equal(isTransientRenameError(errorWithCode("EBUSY")), true);
  assert.equal(isTransientRenameError(errorWithCode("ENOENT")), false, "a real missing-file error is not transient");

  assert.equal(isTransientRenameError(new Error("no code here")), false, "an Error without a code is not transient");
  assert.equal(isTransientRenameError("EPERM"), false, "a bare string is not an Error, however it reads");
  assert.equal(isTransientRenameError(null), false);
  assert.equal(isTransientRenameError(undefined), false);
});

test("writeFileAtomic writes, overwrites, creates missing directories, and leaves no temp file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "write-atomic-"));
  const target = path.join(dir, "nested", "deeper", "note.md");

  // The parent directories do not exist yet.
  await writeFileAtomic(target, "first");
  assert.equal(await fs.readFile(target, "utf8"), "first");

  // A second write overwrites in place rather than appending or refusing.
  await writeFileAtomic(target, "second");
  assert.equal(await fs.readFile(target, "utf8"), "second");

  const leftInParent = await fs.readdir(path.join(dir, "nested", "deeper"));
  assert.deepEqual(
    leftInParent.filter((f) => f.includes(".tmp-")),
    [],
    "no .tmp-* file should survive either the first write or the overwrite",
  );
});
