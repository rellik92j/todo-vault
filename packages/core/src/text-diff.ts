/**
 * A line-level diff for description text.
 *
 * No dependency, deliberately — this is bundled into the Electron renderer
 * alongside `description.ts`, `recurrence.ts`, and `constants.ts`, and pulling in
 * a diff library there would cost more than the ~60 lines below save.
 */

export interface DiffLine {
  op: "add" | "remove";
  text: string;
}

export interface TextDiff {
  added: number;
  removed: number;
  /** Changed lines only, in file order. No context lines. */
  lines: DiffLine[];
  /** Too large to diff; counts are line totals, `lines` is empty. */
  truncated?: boolean;
}

/**
 * DP cells beyond this are not attempted. The DP is O(n·m) and a history page
 * holds up to 100 commits, so this is the one real perf risk in the feature.
 * 40,000 cells (~200×200 lines) holds the worst case to under a millisecond —
 * see the measurement note in plans/plan-history-detail.md for the number this
 * replaced and why.
 */
const MAX_DP_CELLS = 40_000;

export function diffLines(before: string, after: string): TextDiff {
  if (before === after) return { added: 0, removed: 0, lines: [] };

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // Trim the common prefix and suffix first. This is load-bearing, not
  // micro-tuning: a pure append to a description trims to zero DP cells,
  // because the whole unchanged prefix never enters the table.
  let start = 0;
  const maxStart = Math.min(beforeLines.length, afterLines.length);
  while (start < maxStart && beforeLines[start] === afterLines[start]) start++;

  let end = 0;
  while (
    end < maxStart - start &&
    beforeLines[beforeLines.length - 1 - end] === afterLines[afterLines.length - 1 - end]
  ) {
    end++;
  }

  const b = beforeLines.slice(start, beforeLines.length - end);
  const a = afterLines.slice(start, afterLines.length - end);

  if (b.length * a.length > MAX_DP_CELLS) {
    return { added: a.length, removed: b.length, lines: [], truncated: true };
  }

  const lines = lcsDiff(b, a);
  const added = lines.filter((l) => l.op === "add").length;
  const removed = lines.filter((l) => l.op === "remove").length;
  return { added, removed, lines };
}

/** Flat `Uint32Array` rather than nested arrays: a worst-case table is 160 KB
 * contiguous instead of thousands of boxed arrays. */
function lcsDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      lines.push({ op: "remove", text: before[i]! });
      i++;
    } else {
      lines.push({ op: "add", text: after[j]! });
      j++;
    }
  }
  while (i < n) lines.push({ op: "remove", text: before[i++]! });
  while (j < m) lines.push({ op: "add", text: after[j++]! });

  return lines;
}
