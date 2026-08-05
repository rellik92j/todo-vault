import assert from "node:assert/strict";
import test from "node:test";

import type { FileChange, HistoryEntry } from "todo-vault";
import {
  ABSENT,
  changeLine,
  displayValue,
  fallbackNote,
  fieldLabel,
  groupByDay,
  kindBadge,
  timeOfDay,
  truncate,
} from "../src/renderer/src/history-format";

/** A modified item file with nothing changed, for the fallback cases to bend. */
function file(patch: Partial<FileChange> = {}): FileChange {
  return {
    kind: "modified",
    path: "items/OPS-5.md",
    subject: "item",
    key: "OPS-5",
    fields: [],
    bodyChanged: false,
    ...patch,
  };
}

function entry(at: string, hash: string): HistoryEntry {
  return { hash, shortHash: hash.slice(0, 8), author: "Test", at, subject: "Update", files: [] };
}

test("an absent side is drawn, not skipped", () => {
  // The whole point: "due — → 2026-08-19" says a date was set, where a blank
  // left-hand side would read as a rendering bug.
  assert.equal(displayValue(undefined), ABSENT);
  assert.equal(displayValue(""), ABSENT);
  assert.equal(displayValue("2026-08-19"), "2026-08-19");
  assert.equal(
    changeLine({ field: "dueDate", after: "2026-08-19" }),
    `due ${ABSENT} → 2026-08-19`,
  );
});

test("only the fields that read badly raw get renamed", () => {
  assert.equal(fieldLabel("sync.state"), "sync");
  assert.equal(fieldLabel("dueDate"), "due");
  // Unlisted fields keep their schema name, so the log and the file on disk
  // never disagree about what a field is called.
  assert.equal(fieldLabel("status"), "status");
  assert.equal(fieldLabel("id"), "id");
});

test("truncate keeps short text exactly and marks what it cut", () => {
  assert.equal(truncate("Short", 10), "Short");
  assert.equal(truncate("0123456789", 10), "0123456789");
  assert.equal(truncate("01234567890", 10), "012345678…");
});

test("a badge appears only for the kinds a row cannot otherwise show", () => {
  assert.equal(kindBadge("modified"), null);
  assert.equal(kindBadge("renamed"), null, "the path change is already visible");
  assert.equal(kindBadge("added"), "added");
  assert.equal(kindBadge("trashed"), "trashed");
  assert.equal(kindBadge("restored"), "restored");
});

test("a file with no visible change says so rather than looking truncated", () => {
  // The real case: every write rewrites `updated`, which is hidden, so a commit
  // can touch a file without changing anything a person would recognise.
  assert.equal(fallbackNote(file()), "touched, no visible change");
  assert.equal(fallbackNote(file({ fields: [{ field: "status", after: "done" }] })), null);
  assert.equal(fallbackNote(file({ bodyChanged: true })), null, "the description line covers it");
  assert.equal(fallbackNote(file({ kind: "added" })), null, "the badge covers it");
  assert.equal(fallbackNote(file({ unparsed: "binary" })), "binary file");
  assert.equal(fallbackNote(file({ unparsed: "partial" })), "changed — too large to summarise");
});

test("commits group into calendar days without being re-sorted", () => {
  const days = groupByDay([
    entry("2026-08-04T09:50:12+01:00", "aaaaaaaaaa"),
    entry("2026-08-04T08:10:00+01:00", "bbbbbbbbbb"),
    entry("2026-08-03T17:50:00+01:00", "cccccccccc"),
  ]);
  assert.deepEqual(
    days.map((d) => [d.day, d.entries.length]),
    [
      ["2026-08-04", 2],
      ["2026-08-03", 1],
    ],
  );
  assert.equal(timeOfDay("2026-08-04T09:50:12+01:00"), "09:50");

  // git returns newest first and this must not disagree with it, so a day that
  // reappears out of order opens a new group rather than being merged back.
  const jumbled = groupByDay([
    entry("2026-08-04T09:00:00+01:00", "1111111111"),
    entry("2026-08-03T09:00:00+01:00", "2222222222"),
    entry("2026-08-04T07:00:00+01:00", "3333333333"),
  ]);
  assert.equal(jumbled.length, 3);
});
