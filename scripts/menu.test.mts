import assert from "node:assert/strict";
import test from "node:test";

import { connectionSnippet, tokenize } from "./menu.mjs";

test("splits a plain command line on whitespace", () => {
  assert.deepEqual(tokenize("agenda week"), ["agenda", "week"]);
  assert.deepEqual(tokenize("  list   --project   ENG  "), ["list", "--project", "ENG"]);
});

test("keeps a quoted value as one argument", () => {
  // The case a plain .split(/\s+/) gets wrong, and the reason this exists.
  assert.deepEqual(tokenize('new --summary "Two words"'), ["new", "--summary", "Two words"]);
  assert.deepEqual(tokenize("new --summary 'Two words'"), ["new", "--summary", "Two words"]);
});

test("handles a quote that starts mid-argument", () => {
  assert.deepEqual(tokenize('--summary="Two words"'), ["--summary=Two words"]);
});

test("preserves a deliberately empty argument", () => {
  assert.deepEqual(tokenize('--summary ""'), ["--summary", ""]);
});

test("returns nothing for blank input", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
});

test("does not treat an inner apostrophe as a quote when already quoted", () => {
  assert.deepEqual(tokenize(`--summary "it's fine"`), ["--summary", "it's fine"]);
});

test("the Claude config is valid JSON carrying the server and its environment", () => {
  const parsed = JSON.parse(connectionSnippet("C:\\repo\\todo-vault", "C:\\vaults\\work")) as {
    mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
  };
  const server = parsed.mcpServers["todo-vault"];

  assert.ok(server, "the block must be keyed todo-vault — that name is what a user removes later");
  assert.equal(server.command, "node");
  assert.equal(server.args.length, 1);
  assert.deepEqual(server.env, { VAULT_DIR: "C:/vaults/work", VAULT_GIT: "1" });
});

test("points at the built server, not the source and not the repo root", () => {
  // The assertion the README was missing: it advertised dist/mcp-server.js for
  // long enough that anyone who pasted it got a server that never started, and
  // a failed MCP launch is invisible unless you go and read Claude's logs.
  const args = (JSON.parse(connectionSnippet("/home/me/todo-vault", "/home/me/vault")) as {
    mcpServers: Record<string, { args: string[] }>;
  }).mcpServers["todo-vault"].args;

  assert.equal(args[0], "/home/me/todo-vault/packages/core/dist/mcp-server.js");
});

test("emits forward slashes so a hand-edited path does not need doubling", () => {
  // JSON only accepts a backslash doubled, and this block is written to be
  // pasted and then edited. Node opens either form on Windows.
  const snippet = connectionSnippet("C:\\Users\\me\\Desktop\\files", "D:\\OneDrive\\vault");

  assert.ok(!snippet.includes("\\"), `no backslash should survive:\n${snippet}`);
  assert.ok(snippet.includes("C:/Users/me/Desktop/files/packages/core/dist/mcp-server.js"));
  assert.ok(snippet.includes("D:/OneDrive/vault"));
});
