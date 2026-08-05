/**
 * Turning `git log -p` back into vault terms.
 *
 * The vault auto-commits every write, so the git log is already a complete audit
 * trail — but its subjects are uninformative (`Update OPS-5`, `Update 2 items`)
 * and its patches are YAML. All the meaning is in the diff. This module's job is
 * to turn `-dueDate: 2026-08-06` / `+dueDate: 2026-08-19` back into
 * `dueDate 2026-08-06 → 2026-08-19`.
 *
 * That is only tractable because `FRONTMATTER_ORDER` (constants.ts) fixes field
 * order on every write, so a diff shows what changed and nothing else. This
 * module is the payoff for a decision made for other reasons.
 *
 * Pure by design — no fs, no child_process. `Vault.history()` spawns git and
 * hands the stdout here, which keeps vault.ts the only file in the repo that
 * runs git and keeps this file testable against hand-written fixtures.
 */

import { FRONTMATTER_ORDER, PROJECT_FRONTMATTER_ORDER } from "./constants.js";
import { parseFrontmatter } from "./markdown.js";

export interface FieldChange {
  /** Dotted path into the frontmatter: "dueDate", "sync.state", "labels". */
  field: string;
  /** Rendered value. Absent means the field was not present on that side. */
  before?: string;
  after?: string;
}

export type FileChangeKind =
  | "added"
  | "modified"
  | "deleted"
  | "trashed"
  | "restored"
  | "renamed";

export interface FileChange {
  kind: FileChangeKind;
  /** POSIX, vault-relative. */
  path: string;
  /** The other end of a rename/trash/restore. */
  fromPath?: string;
  subject: "item" | "project" | "other";
  /** OPS-5, or OPS for a project. */
  key?: string;
  /** summary / name, newer side preferred. */
  title?: string;
  fields: FieldChange[];
  bodyChanged: boolean;
  /** Why `fields` is empty despite a change. */
  unparsed?: "binary" | "partial" | "unparsable";
}

export interface HistoryEntry {
  /** Full hash, %H. */
  hash: string;
  shortHash: string;
  author: string;
  /** %cI — the same shape as `gitStatus().lastCommit.at`. */
  at: string;
  subject: string;
  files: FileChange[];
}

export interface HistoryPage {
  entries: HistoryEntry[];
  /** git had more past `limit`. Drives "Load more". */
  hasMore: boolean;
}

/**
 * The `--format` string `Vault.history()` must pass for `parseGitLog` to read
 * the result. Here rather than there so the producer and the consumer of this
 * encoding cannot drift apart.
 */
export const HISTORY_LOG_FORMAT = "%x00%H%x00%an%x00%cI%x00%s";

/**
 * Fields never shown. `updated` changes on every single write and is already
 * implied by the commit timestamp; `sync.contentHash` is a 16-hex-character
 * digest nobody can read.
 *
 * `id` is deliberately *not* hidden. schema.ts calls it "stable identity,
 * survives renames and key changes" — so an `id` that changed means something
 * went wrong, which is exactly what an audit log must not swallow.
 */
const HIDDEN_FIELDS = new Set(["updated", "sync.contentHash"]);

/** `.trash/items/OPS-6-2026-07-25T20-30-44-819Z.md` → `OPS-6`. */
const TRASH_STAMP_RE = /-\d{4}-\d{2}-\d{2}T[\d-]+Z\.md$/;

const FULL_HASH_RE = /^[0-9a-f]{40}$/;

// ------------------------------------------------------------------- paths

export function keyFromPath(p: string): { subject: FileChange["subject"]; key?: string } {
  if (p.startsWith(".trash/items/") && p.endsWith(".md")) {
    const base = p.slice(".trash/items/".length);
    return { subject: "item", key: base.replace(TRASH_STAMP_RE, "") || undefined };
  }
  if (p.startsWith("items/") && p.endsWith(".md")) {
    return { subject: "item", key: p.slice("items/".length, -".md".length) || undefined };
  }
  if (p.startsWith("projects/") && p.endsWith(".md")) {
    return { subject: "project", key: p.slice("projects/".length, -".md".length) || undefined };
  }
  return { subject: "other" };
}

function isTrashPath(p: string): boolean {
  return p.startsWith(".trash/");
}

// ------------------------------------------------------------ field values

function isScalar(v: unknown): boolean {
  return v === null || (typeof v !== "object" && typeof v !== "function");
}

/**
 * A field's value as one line. `undefined` means "not present on this side",
 * which the UI draws as an em dash.
 */
function renderValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 0) return undefined;
    // Scalar arrays (labels, components, completions) read fine inline. Object
    // arrays (links, attachments, comments) do not — three nested keys per entry
    // is unreadable, and comparing them entry-by-entry is a diff algorithm this
    // does not need. Counts say "a comment was added" without the noise.
    if (v.every(isScalar)) return v.map((x) => String(x)).join(", ");
    return String(v.length);
  }
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Deep equality with key order ignored — YAML gives us plain data only. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => sameValue(x, b[i]));
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object).sort();
    const bk = Object.keys(b as object).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) =>
      sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** Schema order first, then anything else the files happen to carry. */
function fieldsInOrder(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  order: readonly string[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of order) {
    if (key in before || key in after) {
      seen.add(key);
      out.push(key);
    }
  }
  for (const key of [...Object.keys(before), ...Object.keys(after)]) {
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Compare two parsed frontmatter blocks, walking in schema order so changes
 * come out in a stable, sensible sequence for free.
 */
export function diffFrontmatter(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  order: readonly string[],
): FieldChange[] {
  const out: FieldChange[] = [];

  for (const field of fieldsInOrder(before, after, order)) {
    const b = before[field];
    const a = after[field];
    if (sameValue(b, a)) continue;

    // One level of nesting, dotted — `sync.state`, not a JSON blob.
    const bNested = b && typeof b === "object" && !Array.isArray(b);
    const aNested = a && typeof a === "object" && !Array.isArray(a);
    if (bNested || aNested) {
      const bo = (bNested ? b : {}) as Record<string, unknown>;
      const ao = (aNested ? a : {}) as Record<string, unknown>;
      for (const sub of fieldsInOrder(bo, ao, [])) {
        const dotted = `${field}.${sub}`;
        if (HIDDEN_FIELDS.has(dotted)) continue;
        if (sameValue(bo[sub], ao[sub])) continue;
        out.push({ field: dotted, before: renderValue(bo[sub]), after: renderValue(ao[sub]) });
      }
      continue;
    }

    if (HIDDEN_FIELDS.has(field)) continue;
    out.push({ field, before: renderValue(b), after: renderValue(a) });
  }

  return out;
}

// -------------------------------------------------------------- log parsing

/**
 * Split the stdout of `git log --format=HISTORY_LOG_FORMAT --patch` into
 * commits with their changes rendered in vault terms.
 *
 * The NUL delimiter is safe because git escapes control characters in paths
 * (`core.quotepath`) and emits binary patches as text; the real vault log,
 * including a committed 2.6 MB PDF, contains no NUL bytes. The hash check below
 * is belt and braces: a stray NUL inside a patch re-joins to the diff it came
 * from rather than desynchronising every commit after it.
 */
export function parseGitLog(stdout: string): HistoryEntry[] {
  const parts = stdout.split("\0");
  const entries: HistoryEntry[] = [];
  const raw: string[] = [];

  let i = 1; // parts[0] is whatever preceded the first record — always "".
  while (i < parts.length) {
    if (!FULL_HASH_RE.test(parts[i] ?? "") || i + 3 >= parts.length) {
      // Not a record boundary. Put the NUL back where it was found.
      if (raw.length > 0) raw[raw.length - 1] += `\0${parts[i]}`;
      i += 1;
      continue;
    }
    const [hash, author, at, tail] = parts.slice(i, i + 4) as [string, string, string, string];
    const cut = tail.indexOf("\n");
    entries.push({
      hash,
      shortHash: hash.slice(0, 8),
      author,
      at,
      subject: cut === -1 ? tail : tail.slice(0, cut),
      files: [],
    });
    raw.push(cut === -1 ? "" : tail.slice(cut + 1));
    i += 4;
  }

  return entries.map((entry, n) => ({ ...entry, files: parseDiff(raw[n] ?? "") }));
}

function parseDiff(patch: string): FileChange[] {
  if (!patch.trim()) return [];
  return patch
    .split(/^(?=diff --git )/m)
    .filter((block) => block.startsWith("diff --git "))
    .map(parseFileBlock);
}

interface HunkHeader {
  beforeStart: number;
  afterStart: number;
}

function parseHunkHeader(line: string): HunkHeader | undefined {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return undefined;
  return { beforeStart: Number(m[1]), afterStart: Number(m[2]) };
}

function stripPrefix(p: string): string {
  if (p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

function parseFileBlock(block: string): FileChange {
  const lines = block.split("\n");

  let isNew = false;
  let isDeleted = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let minusPath: string | undefined;
  let plusPath: string | undefined;
  let binary = false;

  let hunkStart = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@@")) {
      hunkStart = i;
      break;
    }
    if (line.startsWith("new file mode")) isNew = true;
    else if (line.startsWith("deleted file mode")) isDeleted = true;
    else if (line.startsWith("rename from ")) renameFrom = line.slice("rename from ".length);
    else if (line.startsWith("rename to ")) renameTo = line.slice("rename to ".length);
    else if (line.startsWith("--- ")) minusPath = stripPrefix(line.slice(4));
    else if (line.startsWith("+++ ")) plusPath = stripPrefix(line.slice(4));
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
    }
  }

  const isRename = renameFrom !== undefined && renameTo !== undefined;
  const fromPath = isRename ? renameFrom! : minusPath;
  const toPath = isRename ? renameTo! : plusPath;
  const path = toPath || fromPath || "";

  let kind: FileChangeKind = "modified";
  if (isNew) kind = "added";
  else if (isDeleted) kind = "deleted";
  else if (isRename) {
    const from = renameFrom!;
    const to = renameTo!;
    if (!isTrashPath(from) && isTrashPath(to)) kind = "trashed";
    else if (isTrashPath(from) && !isTrashPath(to)) kind = "restored";
    else kind = "renamed";
  }

  const { subject, key: pathKey } = keyFromPath(path);
  const base: FileChange = {
    kind,
    path,
    ...(isRename || (fromPath && toPath && fromPath !== toPath) ? { fromPath } : {}),
    subject,
    ...(pathKey ? { key: pathKey } : {}),
    fields: [],
    bodyChanged: false,
  };

  if (binary) return { ...base, unparsed: "binary" };
  if (subject === "other") return base;

  // Everything below reconstructs the two whole files out of the patch, which
  // only works because `--unified=1000` makes the single hunk span the file.
  // See the note on that flag in vault.ts: this is a property of how the app
  // writes files, not a guarantee, so every failure below degrades to a coarser
  // answer rather than throwing.
  const hunkHeaders: HunkHeader[] = [];
  const beforeLines: string[] = [];
  const afterLines: string[] = [];

  for (let i = hunkStart; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@@")) {
      const header = parseHunkHeader(line);
      if (header) hunkHeaders.push(header);
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (i === lines.length - 1 && line === "") continue; // trailing split artefact
    const marker = line.slice(0, 1);
    const text = line.slice(1);
    if (marker === "-") beforeLines.push(text);
    else if (marker === "+") afterLines.push(text);
    else {
      beforeLines.push(text);
      afterLines.push(text);
    }
  }

  if (hunkHeaders.length === 0) return base; // a pure rename with no content change
  const partial =
    hunkHeaders.length > 1 ||
    (kind !== "added" && hunkHeaders[0]!.beforeStart > 1) ||
    (kind !== "deleted" && hunkHeaders[0]!.afterStart > 1);
  if (partial) return { ...base, bodyChanged: true, unparsed: "partial" };

  let before: { data: Record<string, unknown>; body: string };
  let after: { data: Record<string, unknown>; body: string };
  try {
    before = parseFrontmatter(`${beforeLines.join("\n")}\n`);
    after = parseFrontmatter(`${afterLines.join("\n")}\n`);
  } catch {
    return { ...base, bodyChanged: true, unparsed: "unparsable" };
  }

  const titleOf = (d: Record<string, unknown>): string | undefined => {
    const v = subject === "project" ? d.name : d.summary;
    return typeof v === "string" && v ? v : undefined;
  };
  const keyOf = (d: Record<string, unknown>): string | undefined =>
    typeof d.key === "string" && d.key ? d.key : undefined;

  // Frontmatter wins over the path; the path is the fallback for a delete whose
  // content did not parse.
  const resolved: FileChange = {
    ...base,
    key: keyOf(after.data) ?? keyOf(before.data) ?? base.key,
    title: titleOf(after.data) ?? titleOf(before.data),
  };

  // Twenty fields for a brand-new item is noise. "OPS-9 created · Ship the
  // thing" is the line worth reading, and the same in reverse for a delete.
  if (kind === "added" || kind === "deleted") return resolved;

  const order = subject === "project" ? PROJECT_FRONTMATTER_ORDER : FRONTMATTER_ORDER;
  return {
    ...resolved,
    fields: diffFrontmatter(before.data, after.data, order),
    bodyChanged: before.body !== after.body,
  };
}
