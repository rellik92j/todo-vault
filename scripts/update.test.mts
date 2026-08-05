import assert from "node:assert/strict";
import test from "node:test";

import { classifyLockfile, parseStatus, type StatusEntry } from "./update.mjs";

const entry = (index: string, worktree: string, path: string): StatusEntry => ({
  index,
  worktree,
  path,
});

test("a clean tree needs nothing doing", () => {
  assert.equal(classifyLockfile([]), "clean");
});

test("a lockfile nobody touched is left alone", () => {
  assert.equal(classifyLockfile([entry(" ", "M", "README.md")]), "clean");
});

test("an unstaged lockfile with no manifest change is install churn", () => {
  // The case this whole script exists for.
  assert.equal(classifyLockfile([entry(" ", "M", "package-lock.json")]), "restore");
});

test("other dirty files do not make the lockfile someone's work", () => {
  const verdict = classifyLockfile([
    entry(" ", "M", "package-lock.json"),
    entry(" ", "M", "apps/desktop/src/App.tsx"),
    entry("?", "?", "notes.txt"),
  ]);
  assert.equal(verdict, "restore");
});

test("a dirty root manifest alongside it stops", () => {
  const verdict = classifyLockfile([
    entry(" ", "M", "package.json"),
    entry(" ", "M", "package-lock.json"),
  ]);
  assert.equal(verdict, "stop");
});

test("a dirty workspace manifest stops too, since one lockfile serves them all", () => {
  const verdict = classifyLockfile([
    entry(" ", "M", "apps/desktop/package.json"),
    entry(" ", "M", "package-lock.json"),
  ]);
  assert.equal(verdict, "stop");
});

test("a staged lockfile stops even with every manifest clean", () => {
  // Staging it is a deliberate act; discarding that would discard real work.
  assert.equal(classifyLockfile([entry("M", " ", "package-lock.json")]), "stop");
  assert.equal(classifyLockfile([entry("M", "M", "package-lock.json")]), "stop");
});

test("a filename merely ending in package.json is not a manifest", () => {
  const verdict = classifyLockfile([
    entry(" ", "M", "package-lock.json"),
    entry(" ", "M", "docs/notes-about-package.json"),
  ]);
  assert.equal(verdict, "restore");
});

test("parses the status codes and path out of porcelain output", () => {
  assert.deepEqual(parseStatus(" M package-lock.json\n?? notes.txt\n"), [
    entry(" ", "M", "package-lock.json"),
    entry("?", "?", "notes.txt"),
  ]);
});

test("keeps the destination of a rename", () => {
  assert.deepEqual(parseStatus("R  old.md -> new.md\n"), [entry("R", " ", "new.md")]);
});

test("ignores blank and truncated lines", () => {
  assert.deepEqual(parseStatus(""), []);
  assert.deepEqual(parseStatus("\n\n"), []);
});
