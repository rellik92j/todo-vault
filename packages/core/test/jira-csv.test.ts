import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Vault } from "../src/vault.js";
import { blocksToWiki, toJiraCsv, JiraMapSchema } from "../src/jira.js";
import { parseDescription } from "../src/description.js";

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-csv-test-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

function csvMap(overrides: Record<string, unknown> = {}) {
  return JiraMapSchema.parse({
    jiraProjectKey: "ENG",
    issueTypes: { epic: "Epic", story: "Story", task: "Task", bug: "Bug", subtask: "Subtask" },
    ...overrides,
  });
}

/**
 * A reader for what we wrote, so assertions are about cells rather than about
 * substrings of a line. Mirrors the writer's quoting rules and nothing else.
 */
function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** All values under a repeated header, in column order, blanks dropped. */
function valuesUnder(rows: string[][], header: string, rowIndex: number): string[] {
  return rows[0]
    .map((h, i) => (h === header ? rows[rowIndex][i] : undefined))
    .filter((v): v is string => v !== undefined && v !== "");
}

function cell(rows: string[][], header: string, rowIndex: number): string {
  const at = rows[0].indexOf(header);
  assert.notEqual(at, -1, `expected a ${header} column, got ${rows[0].join(", ")}`);
  return rows[rowIndex][at];
}

/** Rows keyed by the local key in Issue Id, so order does not drive assertions. */
function byIssueId(rows: string[][]): Map<string, number> {
  const at = rows[0].indexOf("Issue Id");
  const index = new Map<string, number>();
  for (let i = 1; i < rows.length; i += 1) index.set(rows[i][at], i);
  return index;
}

test("an epic and its child link through Issue Id and Parent id", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", summary: "Rollout", type: "epic" });
  await vault.createItem({
    project: "ACME",
    summary: "Ship the thing",
    type: "story",
    parent: epic.key,
  });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);
  const at = byIssueId(rows);

  // The whole point of the pair: the child names a row that is in this file.
  assert.equal(cell(rows, "Parent id", at.get("ACME-2")!), "ACME-1");
  assert.equal(cell(rows, "Issue Id", at.get("ACME-1")!), "ACME-1");
  // The epic must come first, or the importer resolves a row it has not read.
  assert.ok(at.get("ACME-1")! < at.get("ACME-2")!);
});

test("a parent already in Jira is referenced by its real key, not as an in-file link", async () => {
  const vault = await tmpVault();
  const epic = await vault.createItem({ project: "ACME", summary: "Rollout", type: "epic" });
  await vault.markPushed(epic.key, "ENG-100");
  await vault.createItem({
    project: "ACME",
    summary: "Ship the thing",
    type: "story",
    parent: epic.key,
  });

  const { items } = vault.listItems({});
  const result = toJiraCsv(items, csvMap(), vault);
  const rows = parseCsv(result.csv);
  const at = byIssueId(rows);

  assert.equal(cell(rows, "Parent", at.get("ACME-2")!), "ENG-100");
  assert.equal(cell(rows, "Parent id", at.get("ACME-2")!), "");
  // And the epic itself is not exported again.
  assert.equal(at.has("ACME-1"), false);
  assert.equal(result.skipped[0]?.localKey, "ACME-1");
});

test("a label with a space stays one label", async () => {
  const vault = await tmpVault();
  await vault.createItem({
    project: "ACME",
    summary: "Task",
    labels: ["vendor management", "legal"],
  });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);

  // One column per label, not one cell holding both.
  assert.deepEqual(valuesUnder(rows, "Labels", 1), ["vendor management", "legal"]);
});

test("category folds into labels with its spaces hyphenated", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Task", category: "Vendor management" });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);

  // Jira splits a label on whitespace, so this one has to arrive hyphenated.
  assert.deepEqual(valuesUnder(rows, "Labels", 1), ["Vendor-management"]);
});

test("category goes to its own column when the map names a custom field", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Task", category: "Procurement" });

  const { items } = vault.listItems({});
  const map = csvMap({ fields: { category: "customfield_10050" } });
  const rows = parseCsv(toJiraCsv(items, map, vault).csv);

  assert.equal(cell(rows, "Category", 1), "Procurement");
  assert.deepEqual(valuesUnder(rows, "Labels", 1), []);
});

test("rows pad to the widest label count so every row has the same width", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Three", labels: ["a", "b", "c"] });
  await vault.createItem({ project: "ACME", summary: "One", labels: ["z"] });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);

  assert.equal(rows[0].filter((h) => h === "Labels").length, 3);
  for (const row of rows) assert.equal(row.length, rows[0].length);
});

test("a description with a comma, a quote and a newline survives the round trip", async () => {
  const vault = await tmpVault();
  await vault.createItem({
    project: "ACME",
    summary: 'Send the "final" SOW, then wait',
    description: 'First line, with a comma\n\nAnd a "quoted" second paragraph',
  });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);

  assert.equal(cell(rows, "Summary", 1), 'Send the "final" SOW, then wait');
  const description = cell(rows, "Description", 1);
  assert.ok(description.includes("First line, with a comma"));
  assert.ok(description.includes('And a "quoted" second paragraph'));
});

test("the description carries the provenance footer, not the raw body", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Task",
    description: "## Context\n\n- one\n- two",
  });
  await vault.addLink(item.key, { type: "url", target: "https://example.com", label: "Spec" });

  const { items } = vault.listItems({});
  const rows = parseCsv(toJiraCsv(items, csvMap(), vault).csv);
  const description = cell(rows, "Description", 1);

  // Wiki markup, not markdown: `## Context` would import as literal characters.
  assert.ok(description.includes("h2. Context"));
  assert.ok(description.includes("* one"));
  assert.ok(description.includes("[Spec|https://example.com]"));
  assert.ok(description.includes("Tracked locally as ACME-1"));
});

test("an unchanged pushed item is skipped and a changed one warns", async () => {
  const vault = await tmpVault();
  const settled = await vault.createItem({ project: "ACME", summary: "Settled" });
  const edited = await vault.createItem({ project: "ACME", summary: "Edited" });
  await vault.markPushed(settled.key, "ENG-1");
  await vault.markPushed(edited.key, "ENG-2");
  await vault.updateItem(edited.key, { summary: "Edited after the push" });

  const { items } = vault.listItems({});
  const result = toJiraCsv(items, csvMap(), vault);
  const at = byIssueId(parseCsv(result.csv));

  assert.equal(at.has("ACME-1"), false);
  assert.deepEqual(
    result.skipped.map((s) => s.localKey),
    ["ACME-1"],
  );
  assert.equal(at.has("ACME-2"), true);
  assert.ok(result.warnings.some((w) => w.includes("ACME-2") && w.includes("ENG-2")));
});

test("changing only the category makes a pushed item drift", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Task",
    category: "Procurement",
  });
  await vault.markPushed(item.key, "ENG-1");

  // Category reaches Jira as a label or a custom field, so a changed category
  // means Jira is stale. Before this was in pushableFields the hash did not
  // move, and the item read as pushed-and-unchanged forever.
  await vault.updateItem(item.key, { category: "Legal" });

  const { items } = vault.listItems({});
  const result = toJiraCsv(items, csvMap(), vault);

  assert.deepEqual(result.skipped, []);
  assert.equal(result.rowCount, 1);
});

test("the file opens correctly in Excel: BOM, CRLF, trailing newline", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Café résumé — em dash" });

  const { items } = vault.listItems({});
  const { csv } = toJiraCsv(items, csvMap(), vault);

  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.ok(csv.includes("\r\n"));
  assert.ok(csv.endsWith("\r\n"));
  assert.ok(csv.includes("Café résumé — em dash"));
});

test("Reporter is absent by default and present under the option", async () => {
  const vault = await tmpVault();
  await vault.createItem({
    project: "ACME",
    summary: "Task",
    assignee: "Dan Okafor",
    reporter: "Priya Nair",
  });

  const { items } = vault.listItems({});
  const plain = toJiraCsv(items, csvMap(), vault);
  const withReporter = toJiraCsv(items, csvMap(), vault, { reporter: true });

  assert.equal(parseCsv(plain.csv)[0].includes("Reporter"), false);
  assert.deepEqual(plain.reporters, []);
  assert.equal(cell(parseCsv(withReporter.csv), "Reporter", 1), "Priya Nair");
  // Surfaced so they can be checked against the site's users before importing.
  assert.deepEqual(withReporter.assignees, ["Dan Okafor"]);
  assert.deepEqual(withReporter.reporters, ["Priya Nair"]);
});

test("an object-valued default warns instead of emitting [object Object]", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Task" });

  const { items } = vault.listItems({});
  const map = csvMap({ defaults: { customfield_10001: { id: "team-uuid" }, customfield_2: "web" } });
  const result = toJiraCsv(items, map, vault);
  const rows = parseCsv(result.csv);

  assert.ok(result.warnings.some((w) => w.includes("customfield_10001")));
  assert.equal(rows[0].includes("customfield_10001"), false);
  assert.ok(!result.csv.includes("[object Object]"));
  // The string-valued one still comes through.
  assert.equal(cell(rows, "customfield_2", 1), "web");
});

test("a start date with no field id in the map warns rather than vanishing", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Task", startDate: "2026-09-01" });

  const { items } = vault.listItems({});
  const without = toJiraCsv(items, csvMap(), vault);
  assert.ok(without.warnings.some((w) => w.includes("fields.startDate")));
  assert.equal(parseCsv(without.csv)[0].includes("Start Date"), false);

  const withField = toJiraCsv(items, csvMap({ fields: { startDate: "customfield_10015" } }), vault);
  assert.equal(cell(parseCsv(withField.csv), "Start Date", 1), "2026-09-01");
});

test("blocksToWiki renders the whole grammar", () => {
  const wiki = blocksToWiki(
    parseDescription(
      "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```js\nconst a = 1;\n```",
    ),
  );

  assert.ok(wiki.includes("h1. Title"));
  assert.ok(wiki.includes("*bold*"));
  assert.ok(wiki.includes("_em_"));
  assert.ok(wiki.includes("{{code}}"));
  assert.ok(wiki.includes("* one"));
  assert.ok(wiki.includes("# first"));
  assert.ok(wiki.includes("{quote}\nquoted\n{quote}"));
  assert.ok(wiki.includes("{code:js}\nconst a = 1;\n{code}"));
});
