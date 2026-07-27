/**
 * The markdown an item description is allowed to contain, parsed and written.
 *
 * An item's body *is* its description, so the same text has to be understood in
 * three places: the desktop panel that renders it, the rich editor that writes
 * it, and the Jira push that converts it to ADF. This file is the single grammar
 * all of them read, so the app can never show or produce formatting the push
 * would drop, or drop formatting the push keeps.
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

// ------------------------------------------------------------- writing it back

function serializeInline(nodes: Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case "strong":
          return `**${node.text}**`;
        case "em":
          return `*${node.text}*`;
        case "code":
          return `\`${node.text}\``;
        case "link":
          return `[${node.text}](${node.href})`;
        case "break":
          return "\n";
        default:
          return node.text;
      }
    })
    .join("");
}

/**
 * Blocks back to markdown — the inverse of parseDescription.
 *
 * This exists so a rich editor can write the file without a second markdown
 * implementation in the app. The grammar has one home, and both directions of it
 * live here next to each other where they can be read together.
 *
 * It emits one spelling of each construct: `*em*` not `_em_`, `-` bullets not `*`
 * or `+`, `1.` not `1)`, and ordered lists renumbered from one. That makes it a
 * normaliser, which is exactly why nothing calls it on content it has not first
 * checked with isLosslessDescription.
 */
export function serializeDescription(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case "heading":
          return `${"#".repeat(block.level)} ${serializeInline(block.content)}`;
        case "list":
          return block.items
            .map((item, index) =>
              block.ordered
                ? `${index + 1}. ${serializeInline(item)}`
                : `- ${serializeInline(item)}`,
            )
            .join("\n");
        case "quote":
          // Every line of the quotation carries its own marker, which is what
          // the parser needs to read them back as one block rather than as a
          // quote followed by a paragraph.
          return serializeInline(block.content)
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n");
        case "code":
          return `\`\`\`${block.language ?? ""}\n${block.text}\n\`\`\``;
        default:
          return serializeInline(block.content);
      }
    })
    .join("\n\n");
}

/**
 * Whether this description survives a parse-and-write round trip byte for byte.
 *
 * The app asks this before offering the rich editor. True means editing richly
 * can only ever write back what a person actually changed. False means the
 * round trip would reformat the file on its own — `_em_` rewritten to `*em*`,
 * `+` bullets to `-`, blank-line runs collapsed — so the app falls back to
 * editing the raw text instead.
 *
 * That matters because this vault is written by the CLI, the MCP server and any
 * text editor as well as by this app, and `--git` commits every write: a
 * normalising editor would fill the history with commits nobody typed, and would
 * quietly restyle prose its author wrote deliberately.
 *
 * Safe to call on `item.description` directly — parseFrontmatter hands back a
 * body that is already LF-normalised and trimmed, and serializeFrontmatter
 * trims it again on the way out, so there is no trailing whitespace in play.
 */
export function isLosslessDescription(source: string): boolean {
  return serializeDescription(parseDescription(source)) === source;
}
