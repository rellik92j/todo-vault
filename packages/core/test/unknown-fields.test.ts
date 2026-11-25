/**
 * What this build does with a file written by a newer one.
 *
 * The desktop app and the MCP servers routinely run different builds of core
 * against one vault, so a field added in one build will be on disk before every
 * reader knows it. These tests pin down what a reader that does not know the
 * field does today. They assert the current behaviour, not the intended one:
 * TV-3 decides which of the two is to be kept, and whichever is chosen changes
 * these assertions in the same PR.
 *
 * "A newer build" is simulated by writing an item with this build and then
 * adding a field to its frontmatter by hand, which is byte for byte what a
 * newer build's serializer would have produced for that field.
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FRONTMATTER_ORDER } from "../src/constants.js";
import { parseFrontmatter, serializeFrontmatter } from "../src/markdown.js";
import { Vault, VaultError } from "../src/vault.js";

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

/** An item written by "a newer build": ACME-1 with `claimedBy`, ACME-2 untouched. */
async function vaultWithNewerItem() {
  const vault = await tmpVault();
  const newer = await vault.createItem({ project: "ACME", summary: "Written by a newer build" });
  const plain = await vault.createItem({ project: "ACME", summary: "Nothing new here" });
  const file = vault.itemPath(newer.key);
  const onDisk = await addFrontmatterLine(file, /^key: ACME-1$/m, "claimedBy: core-worker@x");
  return { vault, newer, plain, file, onDisk };
}

test("an item with an unknown top-level field is skipped by load(), not thrown", async () => {
  const { vault, newer, plain } = await vaultWithNewerItem();

  // load() catches the parse failure and reports it. It does not throw, so
  // Vault.open, the MCP server's reload-before-every-call, and the desktop
  // snapshot all carry on with the rest of the vault.
  const result = await vault.load();
  assert.equal(result.items, 1, "only the item without the new field is indexed");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /ACME-1\.md/);
  assert.match(result.errors[0], /Unrecognized key\(s\) in object: 'claimedBy'/);

  // The same is true of a fresh open, which is what a newly started MCP server does.
  const reopened = await Vault.open(vault.root);
  assert.equal(reopened.hasItem(newer.key), false);
  assert.equal(reopened.hasItem(plain.key), true);
});

test("the skipped item is missing from every read path", async () => {
  const { vault, newer, plain } = await vaultWithNewerItem();
  await vault.load();

  assert.deepEqual(
    vault.listItems({ project: "ACME" }).items.map((i) => i.key),
    [plain.key],
    "listings (vault_list_items, the backlog, the board) do not show it",
  );
  assert.equal(vault.listItems({ text: "newer build" }).total, 0, "a text search does not find it");
  assert.equal(vault.hasItem(newer.key), false);
  assert.throws(
    () => vault.getItem(newer.key),
    (err: unknown) => err instanceof VaultError && /No item with key ACME-1/.test(err.message),
    "vault_get_item and the detail panel report it as not existing",
  );
});

test("an older build cannot save the item, so the file and its new field are left as they were", async () => {
  const { vault, newer, file, onDisk } = await vaultWithNewerItem();
  await vault.load();

  // Every write that names the key goes through getItem first and is refused.
  const notFound = (err: unknown) =>
    err instanceof VaultError && /No item with key ACME-1/.test(err.message);
  await assert.rejects(vault.updateItem(newer.key, { summary: "Edited" }), notFound);
  await assert.rejects(vault.transition(newer.key, "in_progress"), notFound);
  await assert.rejects(vault.addComment(newer.key, "hello", "tester"), notFound);
  await assert.rejects(
    vault.addLink(newer.key, { type: "url", target: "https://example.com" }),
    notFound,
  );
  await assert.rejects(vault.deleteItem(newer.key), notFound);

  // Nothing was written over it, so no data is lost — it is only invisible.
  assert.equal(await fs.readFile(file, "utf8"), onDisk);
});

test("a new item does not take the skipped item's key or overwrite its file", async () => {
  const { vault, file, onDisk } = await vaultWithNewerItem();
  await vault.load();

  const created = await vault.createItem({ project: "ACME", summary: "Created by the older build" });
  assert.equal(created.key, "ACME-3", "the counter still knows ACME-1 was handed out");
  assert.equal(await fs.readFile(file, "utf8"), onDisk);

  // Even with the counter gone, the exclusive create refuses to replace the
  // file on disk and moves past it.
  await fs.writeFile(path.join(vault.root, ".counters.json"), "{}\n", "utf8");
  await fs.rm(vault.itemPath("ACME-2"));
  await fs.rm(vault.itemPath("ACME-3"));
  await vault.load();
  const afterReset = await vault.createItem({ project: "ACME", summary: "Counter was lost" });
  assert.equal(afterReset.key, "ACME-2");
  assert.equal(await fs.readFile(file, "utf8"), onDisk);
});

test("project-wide writes in an older build pass over the skipped item", async () => {
  // Not the item's own save, but the writes that should have carried it along.
  const { vault, file, onDisk } = await vaultWithNewerItem();
  await vault.createProject({ key: "OPS", name: "Operations" });
  await vault.load();

  // A rename re-keys the items it can see. The skipped one keeps its old key
  // and project, so it is left pointing at a project that no longer exists.
  await vault.renameProject("ACME", "ACMX");
  assert.equal(await fs.readFile(file, "utf8"), onDisk);
  assert.match(onDisk, /^project: ACME$/m);
  assert.equal(vault.listProjects().some((p) => p.key === "ACME"), false);
  assert.equal(vault.hasItem("ACMX-1"), false);
  assert.equal(vault.hasItem("ACMX-2"), true);

  // Trashing a project without cascade is refused while it holds items, but
  // the skipped item does not count, so a project that holds only it goes.
  const opsFile = vault.itemPath("OPS-1");
  const opsOnDisk = onDisk
    .replace(/^key: ACME-1$/m, "key: OPS-1")
    .replace(/^project: ACME$/m, "project: OPS");
  await fs.writeFile(opsFile, opsOnDisk, "utf8");
  await vault.load();
  assert.equal(vault.hasItem("OPS-1"), false);
  await vault.deleteProject("OPS");
  assert.equal(vault.listProjects().some((p) => p.key === "OPS"), false);
  assert.equal(await fs.readFile(opsFile, "utf8"), opsOnDisk, "the item is left behind, orphaned");
});

test("an unknown field nested inside a link also drops the whole item", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({
    project: "ACME",
    summary: "Has a link",
    links: [{ type: "url", target: "https://example.com", label: "spec" }],
  });
  const file = vault.itemPath(item.key);
  await addFrontmatterLine(file, /^ {4}label: spec$/m, "    pinned: true");

  const { errors } = await vault.load();
  assert.equal(vault.hasItem(item.key), false);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /links\.0: Unrecognized key\(s\) in object: 'pinned'/);
});

test("a project with an unknown field is skipped the same way, and its items stay listed", async () => {
  const vault = await tmpVault();
  const item = await vault.createItem({ project: "ACME", summary: "Lives in ACME" });
  await addFrontmatterLine(vault.projectPath("ACME"), /^key: ACME$/m, "owner: someone");

  const { errors } = await vault.load();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ACME\.md: Unrecognized key\(s\) in object: 'owner'/);
  assert.deepEqual(vault.listProjects(), []);
  assert.equal(vault.hasItem(item.key), true, "load() does not check that an item's project exists");
});

test("the item serializer already keeps fields it does not know", () => {
  // Context for the fix: the write side of option 1 exists. orderKeys appends
  // any key not in FRONTMATTER_ORDER rather than dropping it, so only the
  // strict parse stands between a newer field and a round trip.
  const text = serializeFrontmatter(
    { key: "ACME-1", summary: "x", claimedBy: "core-worker@x" },
    "body",
    FRONTMATTER_ORDER,
  );
  assert.equal(parseFrontmatter(text).data.claimedBy, "core-worker@x");
  assert.ok(text.indexOf("claimedBy") > text.indexOf("summary"), "unknown keys go last");
});
