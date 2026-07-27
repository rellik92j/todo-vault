/**
 * The markdown an item description is allowed to contain, parsed once.
 *
 * An item's body *is* its description, so the same text has to be understood in
 * two places: the desktop panel that renders it and the Jira push that converts
 * it to ADF. This file is the single grammar both of them read, so the app can
 * never show formatting the push would drop, or drop formatting the push keeps.
 *
 * Split out of jira.ts, which owned it first — importing it from there would
 * pull node:fs, zod and yaml into a browser bundle. Exposed as
 * `todo-vault/description`.
 *
 * Nothing in this file may import anything, the same rule constants.ts keeps
 * and for the same reason.
 *
 * The subset is deliberately small: it is what actually turns up in task
 * descriptions. Anything else degrades to a paragraph rather than failing.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }
  /** A newline inside a paragraph. See parseDescription's note on soft wrap. */
  | { kind: "break" };

export type Block =
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "heading"; level: number; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; content: Inline[] }
  | { kind: "code"; language?: string; text: string };

const INLINE_RE = /(\[[^\]]+\]\([^)]+\)|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;

/** One line of text, split into runs. Newlines are handled a level up. */
function inlineNodes(text: string): Inline[] {
  if (!text) return [];
  const nodes: Inline[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_RE)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) {
      nodes.push({ kind: "text", text: text.slice(lastIndex, index) });
    }

    if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        nodes.push({ kind: "link", text: linkMatch[1], href: linkMatch[2] });
      }
    } else if (token.startsWith("`")) {
      nodes.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("**")) {
      nodes.push({ kind: "strong", text: token.slice(2, -2) });
    } else {
      nodes.push({ kind: "em", text: token.slice(1, -1) });
    }
    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    nodes.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return nodes.length ? nodes : [{ kind: "text", text }];
}

/**
 * Parse a description body into blocks.
 *
 * The one place this departs from strict markdown: a newline inside a paragraph
 * is a hard break, not a soft wrap. Strict markdown joins those lines with a
 * space, which is exactly the collapsing that makes a hand-written description
 * unreadable — people type descriptions in a textarea and mean the line breaks
 * they put there. Both consumers honour the break, so what you see and what
 * Jira gets stay the same document.
 */
export function parseDescription(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const flushList = (ordered: boolean): Block => {
    const items: Inline[][] = [];
    const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
    while (i < lines.length) {
      const m = pattern.exec(lines[i]);
      if (!m) break;
      items.push(inlineNodes(m[1]));
      i += 1;
    }
    return { kind: "list", ordered, items };
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const language = line.slice(3).trim() || undefined;
      i += 1;
      const buffer: string[] = [];
      while (i < lines.length && !lines[i].startsWith("```")) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", ...(language ? { language } : {}), text: buffer.join("\n") });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        content: inlineNodes(heading[2]),
      });
      i += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      blocks.push(flushList(false));
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      blocks.push(flushList(true));
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      // Consecutive `>` lines are one quote, not one each. A quotation is
      // almost always several lines, and a block apiece renders as a stack of
      // separate quotes with the left rule broken between them.
      const content = inlineNodes(quote[1]);
      i += 1;
      while (i < lines.length) {
        const next = /^>\s?(.*)$/.exec(lines[i]);
        if (!next) break;
        content.push({ kind: "break" }, ...inlineNodes(next[1]));
        i += 1;
      }
      blocks.push({ kind: "quote", content });
      continue;
    }

    const content = inlineNodes(line);
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])
    ) {
      content.push({ kind: "break" }, ...inlineNodes(lines[i]));
      i += 1;
    }
    blocks.push({ kind: "paragraph", content });
  }

  return blocks;
}
