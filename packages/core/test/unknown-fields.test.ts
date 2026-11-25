/**
 * What this build does with a file written by a newer one.
 *
 * The desktop app and the MCP servers routinely run different builds of core
 * against one vault, so a field added in one build will be on disk before every
 * reader knows it. Until TV-3, item and project frontmatter was strict, and an
 * older build dropped such a file from every view and refused every write to
 * it. Now a top-level field this build does not know is kept: the file loads,
 * the field rides along on every write, and `load().notices` names it for
 * `vault doctor`. Fields nested inside a link, attachment, comment or sync
 * block are still strict (TV-11); one test here records that gap. A key named
 * `description` is the exception and is still rejected, because the body is
 * the description and a save would drop the key's text.
 *
 * "A newer build" is simulated by writing an item with this build and then
 * adding a field to its frontmatter by hand, which is byte for byte what a
 * newer build's serializer would have produced for that field.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { FRONTMATTER_ORDER } from "../src/constants.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/markdown.js";
import { unknownFrontmatterKeys } from "../src/schema.js";
import { Vault } from "../src/vault.js";

const execFileAsync = promisify(execFile);

async function tmpVault(): Promise<Vault> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-unknown-"));
  const vault = await Vault.init(dir);
  await vault.createProject({ key: "ACME", name: "Acme rollout" });
  return vault;
}

/** Insert `line` into a file's frontmatter, on the line after the one matching `after`. */
async function addFrontmatterLine(file: string, after: RegExp, line: string): Promise<string> {
  const raw = await fs.readFile(file, "utf8");
  assert.match(raw, after, "the anchor line must be there to insert after");
  const next = raw.replace(after, (m) => `${m}\n${line}`);
  await fs.writeFile(file, next, "utf8");
  return next;
}

/** The parsed frontmatter of a file on disk, as the next reader will see it. */
async function frontmatterOf(file: string): Promise<Record<string, unknown>> {
  return parseFrontmatter(await fs.readFile(file, "utf8")).data;
}

/** A field the exported types deliberately do not know, read off a loaded object. */
function extra(obj: object, field: string): unknown {
  return (obj as Record<string, unknown>)[field];
}

/** An item written by "a newer build": ACME-1 with `claimedBy`, ACME-2 untouched. */
async function vaultWithNewerItem() {
  const vault = await tmpVault();
  const newer = await vault.createItem({ project: "ACME", summary: "Written by a newer build" });
  const plain = await vault.createItem({ project: "ACME", summary: "Nothing new here" });
  const file = vault.itemPath(newer.key);
  await addFrontmatterLine(file, /^key: ACME-1$/m, "claimedBy: core-worker@x");
  return { vault, newer, plain, file };
}

test("an item with an unknown top-level field loads, and the field is kept on it", async () => {
  const { vault, newer, plain } = await vaultWithNewerItem();

  const result = await vault.load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.items, 2);
  assert.equal(extra(vault.getItem(newer.key), "claimedBy"), "core-worker@x");

  // A fresh open is what a newly started MCP server does.
  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.hasItem(newer.key), true);
  assert.equal(reopened.hasItem(plain.key), true);
});

test("the item is listed and searchable like any other", async () => {
  const { vault, newer, plain } = await vaultWithNewerItem();
  await vault.load();

  assert.deepEqual(
    vault
      .listItems({ project: "ACME" })
      .items.map((i) => i.key)
      .sort(),
    [newer.key, plain.key],
  );
  assert.deepEqual(
    vault.listItems({ text: "newer build" }).items.map((i) => i.key),
    [newer.key],
  );
  assert.equal(vault.getItem(newer.key).summary, "Written by a newer build");
});

test("every kind of save writes the unknown field back", async () => {
  const { vault, newer, file } = await vaultWithNewerItem();
  await vault.load();

  await vault.updateItem(newer.key, { summary: "Edited by an older build", dueDate: "2026-12-01" });
  await vault.transition(newer.key, "in_progress");
  await vault.addComment(newer.key, "hello", "tester");
  await vault.addLink(newer.key, { type: "url", target: "https://example.com" });
  await vault.updateItems([newer.key], { priority: "high" });
  await vault.updateItem(newer.key, { dueDate: null });

  const front = await frontmatterOf(file);
  assert.equal(front.claimedBy, "core-worker@x");
  assert.equal(front.summary, "Edited by an older build");
  assert.equal(front.status, "in_progress");
  assert.equal(front.priority, "high");
  assert.equal(front.dueDate, undefined, "clearing a known field leaves the unknown one alone");

  // Known fields keep their order; the unknown one is written after them.
  const keys = Object.keys(front);
  assert.equal(keys.at(-1), "claimedBy");

  // And the next reader still sees it.
  await vault.load();
  assert.equal(extra(vault.getItem(newer.key), "claimedBy"), "core-worker@x");
});

test("re-keying, trashing and restoring carry the unknown field along", async () => {
  const { vault } = await vaultWithNewerItem();
  await vault.createProject({ key: "OPS", name: "Operations" });
  await vault.load();

  // deleteProject now counts the item, instead of orphaning it.
  await assert.rejects(vault.deleteProject("ACME"), /still holds 2 item\(s\)/);

  await vault.renameProject("ACME", "ACMX");
  assert.equal(vault.hasItem("ACME-1"), false);
  assert.equal(extra(vault.getItem("ACMX-1"), "claimedBy"), "core-worker@x");
  assert.equal((await frontmatterOf(vault.itemPath("ACMX-1"))).claimedBy, "core-worker@x");

  const moved = await vault.moveItemsToProject("ACMX-1", "OPS");
  const opsKey = moved.rekeyed[0].to;
  assert.equal((await frontmatterOf(vault.itemPath(opsKey))).claimedBy, "core-worker@x");

  const [trashed] = await vault.deleteItem(opsKey);
  const restored = await vault.restoreItem(path.basename(trashed.trashedTo));
  assert.equal(extra(restored, "claimedBy"), "core-worker@x");
});

test("an unknown field does not make a pushed item read as drifted", async () => {
  // pushableFields is an allowlist, so Jira never sees the field and its hash
  // never moves because of it.
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Pushed" });
  await vault.markPushed(item.key, "ENG-1");
  await addFrontmatterLine(vault.itemPath(item.key), /^key: ACME-1$/m, "claimedBy: someone");
  await vault.load();

  assert.equal(vault.getItem(item.key).sync.state, "pushed");
  const reranked = await vault.updateItem(item.key, { rank: 5000 });
  assert.equal(reranked.sync.state, "pushed");
  assert.equal(extra(reranked, "claimedBy"), "someone");
});

test("a project with an unknown field loads, is listed, and keeps the field on save", async () => {
  const vault = await tmpVault();
  await vault.createItem({ project: "ACME", summary: "Lives in ACME" });
  const file = vault.projectPath("ACME");
  await addFrontmatterLine(file, /^key: ACME$/m, "owner: someone");

  const { errors } = await vault.load();
  assert.deepEqual(errors, []);
  assert.deepEqual(
    vault.listProjects().map((p) => p.key),
    ["ACME"],
  );
  assert.equal(extra(vault.getProject("ACME"), "owner"), "someone");

  await vault.updateProject("ACME", { name: "Acme renamed", lead: "Dana" });
  assert.equal((await frontmatterOf(file)).owner, "someone");
  assert.equal((await frontmatterOf(file)).name, "Acme renamed");

  await vault.renameProject("ACME", "ACMX");
  assert.equal((await frontmatterOf(vault.projectPath("ACMX"))).owner, "someone");
  await vault.load();
  assert.equal(extra(vault.getProject("ACMX"), "owner"), "someone");
});

test("load() names unknown keys as notices, so doctor can show a misspelled field", async () => {
  const vault = await tmpVault();
  const clean = await vault.load();
  assert.deepEqual(clean.notices, [], "a vault this build wrote has nothing to report");

  const item = await vault.createItem({ project: "ACME", summary: "Hand-edited" });
  await addFrontmatterLine(vault.itemPath(item.key), /^key: ACME-1$/m, "dueDtae: 2026-12-01");
  await addFrontmatterLine(vault.projectPath("ACME"), /^key: ACME$/m, "owner: someone");

  const { errors, notices } = await vault.load();
  assert.deepEqual(errors, [], "notices are not errors");
  assert.equal(notices.length, 2);
  assert.ok(notices.some((n) => /ACME\.md: .*does not know: owner$/.test(n)));
  assert.ok(notices.some((n) => /ACME-1\.md: .*does not know: dueDtae$/.test(n)));
  assert.equal(vault.getItem(item.key).dueDate, undefined, "the typo is not read as the field");
});

test("unknownFrontmatterKeys checks raw frontmatter against this build's field list", () => {
  assert.deepEqual(unknownFrontmatterKeys("item", { key: "ACME-1", summary: "x", b: 1, a: 2 }), [
    "b",
    "a",
  ]);
  assert.deepEqual(unknownFrontmatterKeys("project", { key: "ACME", name: "x" }), []);
  // `name` is a project field, not an item one.
  assert.deepEqual(unknownFrontmatterKeys("item", { name: "x" }), ["name"]);
  // An Object.prototype name is not mistaken for a known field.
  assert.deepEqual(unknownFrontmatterKeys("item", { toString: "x" }), ["toString"]);
  // `description` is an error in frontmatter, never a notice.
  assert.deepEqual(unknownFrontmatterKeys("item", { description: "x", b: 1 }), ["b"]);
  assert.deepEqual(unknownFrontmatterKeys("project", { description: "x" }), []);
});

/**
 * A `description:` key in frontmatter is the one unknown key that is rejected.
 * The body is the description, so loading the file would overwrite the key and
 * the next save would drop its text. Rejecting it keeps the file out of the
 * index, so no build ever rewrites it, and puts it in front of a human.
 */
test("an item with a description key in its frontmatter is rejected, and its file is never rewritten", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Hand-edited", description: "The body" });
  const file = vault.itemPath(item.key);
  const before = await addFrontmatterLine(file, /^key: ACME-1$/m, "description: Copied from a Hugo page");

  const { errors, notices } = await vault.load();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ACME-1\.md: .*description is the body, not a frontmatter field/);
  assert.deepEqual(notices, [], "an error, not a notice");
  assert.equal(vault.hasItem(item.key), false);
  assert.throws(() => vault.getItem(item.key), /No item with key ACME-1/);
  assert.deepEqual(vault.listItems({ project: "ACME" }).items, []);

  await assert.rejects(vault.updateItem(item.key, { summary: "Overwrite" }), /No item with key/);
  assert.equal(await fs.readFile(file, "utf8"), before, "the file is byte for byte as it was");

  // A fresh open, as an MCP server starting up, rejects it the same way.
  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.hasItem(item.key), false);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("a project with a description key in its frontmatter is rejected, and its file is never rewritten", async () => {
  const vault = await tmpVault();
  const file = vault.projectPath("ACME");
  const before = await addFrontmatterLine(file, /^key: ACME$/m, "description: Copied from a Jekyll page");

  const { errors, notices } = await vault.load();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ACME\.md: .*description is the body, not a frontmatter field/);
  assert.deepEqual(notices, []);
  assert.deepEqual(vault.listProjects(), []);
  assert.throws(() => vault.getProject("ACME"));

  await assert.rejects(vault.updateProject("ACME", { name: "Overwrite" }));
  await assert.rejects(vault.createItem({ project: "ACME", summary: "Into a project that did not load" }));
  assert.equal(await fs.readFile(file, "utf8"), before, "the file is byte for byte as it was");
});

test("the write paths still accept an item and a project, whose description is the body", async () => {
  // writeAndIndex strips `description` before it parses, so the rejection only
  // ever fires on a file read from disk.
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Body", description: "First" });
  await vault.updateItem(item.key, { description: "Second" });
  await vault.updateProject("ACME", { description: "Project body" });
  await vault.renameProject("ACME", "ACMX");

  const { errors } = await vault.load();
  assert.deepEqual(errors, []);
  assert.equal(vault.getItem("ACMX-1").description, "Second");
  assert.equal(vault.getProject("ACMX").description, "Project body");
  assert.equal((await frontmatterOf(vault.itemPath("ACMX-1"))).description, undefined);
  assert.equal((await frontmatterOf(vault.projectPath("ACMX"))).description, undefined);
});

/** `vault doctor`, run from source the way a user runs the built CLI. */
async function doctor(root: string): Promise<{ code: number; stdout: string }> {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  try {
    const { stdout } = await execFileAsync(process.execPath, [tsx, cli, "doctor", "--vault", root]);
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { code?: number; stdout?: string };
    if (typeof e.code !== "number") throw err;
    return { code: e.code, stdout: e.stdout ?? "" };
  }
}

test("vault doctor lists unknown keys as notices, exits 0, and lists a description key as a problem", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Hand-edited" });
  await addFrontmatterLine(vault.itemPath(item.key), /^key: ACME-1$/m, "dueDtae: 2026-12-01");

  const notices = await doctor(vault.root);
  assert.equal(notices.code, 0, "notices leave the exit code alone");
  assert.match(notices.stdout, /No problems found\./);
  assert.match(notices.stdout, /1 notice\(s\)/);
  assert.match(notices.stdout, /ACME-1\.md: field\(s\) this build does not know: dueDtae/);

  const other = await vault.createItem({ project: "ACME", summary: "Also hand-edited" });
  await addFrontmatterLine(vault.itemPath(other.key), /^key: ACME-2$/m, "description: lost text");

  const problems = await doctor(vault.root);
  assert.equal(problems.code, 1);
  assert.match(problems.stdout, /1 problem\(s\):\n {2}- .*ACME-2\.md: .*description is the body/);
  assert.doesNotMatch(problems.stdout.split("notice(s)")[1] ?? "", /description/);
});

test("gap, TV-11: an unknown field nested inside a link still drops the whole item", async () => {
  // Only the top level is passthrough. LinkSchema, AttachmentSchema,
  // CommentSchema and SyncSchema are still strict, so a field a newer build
  // adds to one link makes this build reject the item and leave it out of
  // every view, as every unknown field did before TV-3. When TV-11 lands,
  // this test flips.
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Has a link",
    links: [{ type: "url", target: "https://example.com", label: "spec" }],
  });
  await addFrontmatterLine(vault.itemPath(item.key), /^ {4}label: spec$/m, "    pinned: true");

  const { errors } = await vault.load();
  assert.equal(vault.hasItem(item.key), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /links\.0: Unrecognized key\(s\) in object: 'pinned'/);
});

test("the item serializer keeps fields it does not know, after the known ones", () => {
  const text = serializeFrontmatter(
    { key: "ACME-1", summary: "x", claimedBy: "core-worker@x" },
    "body",
    FRONTMATTER_ORDER,
  );
  assert.equal(parseFrontmatter(text).data.claimedBy, "core-worker@x");
  assert.ok(text.indexOf("claimedBy") > text.indexOf("summary"), "unknown keys go last");
});
