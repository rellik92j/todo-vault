import { useEffect, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor, type JSONContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import {
  parseDescription,
  serializeDescription,
  type Block,
  type Inline,
} from "todo-vault/description";

/**
 * A description, edited as formatting rather than as syntax.
 *
 * Ctrl+B bolds, the toolbar makes lists, and nothing shows its markers — but the
 * file on disk is still the same plain markdown the CLI, the MCP server and the
 * Jira push read. The editor is a way of typing into the document, not a second
 * copy of it.
 *
 * There is deliberately no markdown library here. The grammar lives in the
 * core's description.ts, shared with the ADF converter, and this maps TipTap's
 * document to and from that AST. A second markdown implementation in the
 * renderer is exactly the drift the core module exists to prevent.
 *
 * Callers must check `isLosslessDescription` before mounting this. The mapping
 * below normalises — one spelling per construct — so on content that does not
 * already round-trip it would rewrite the file on the way out.
 */

/** The subset the core grammar can express, and therefore all this may produce. */
const EXTENSIONS = [
  StarterKit.configure({
    // Everything the grammar has no node for. Turned off at the schema rather
    // than merely left off the toolbar: a paste, a keyboard shortcut or an
    // input rule would otherwise create something the file cannot hold, and it
    // would vanish on save with no way for anyone to see why.
    strike: false,
    underline: false,
    horizontalRule: false,
    // Appends a stray paragraph after a trailing block, which would serialize
    // as blank lines the file never had.
    trailingNode: false,
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // The renderer never navigates a link itself — the main process owns that,
    // and its scheme allowlist is the reason why.
    link: { openOnClick: false, autolink: false },
  }),
];

const LINK_SCHEMES = ["http:", "https:", "mailto:"];

export function RichEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  /**
   * Every edit, for a form holding its own state. There is no file yet, so
   * there is nothing to be expensive about.
   */
  onChange?: (next: string) => void;
  /**
   * Leaving the field, or Ctrl+Enter. Omitted by callers that take onChange —
   * a write per keystroke would be a git commit per keystroke.
   */
  onCommit?: (next: string) => void;
  /** Escape. Omitted where Escape belongs to something outer, like a dialog. */
  onCancel?: () => void;
}): React.JSX.Element {
  const [linkForm, setLinkForm] = useState<{ href: string; error: string | null } | null>(null);
  const linkRef = useRef<HTMLInputElement | null>(null);
  // Read by the blur handler, which fires after a commit has already happened
  // via Escape or Ctrl+Enter and must not then fire a second one.
  const settled = useRef(false);

  const editor = useEditor({
    extensions: EXTENSIONS,
    content: docFromBlocks(parseDescription(value)),
    editorProps: {
      // Reuses the read view's block styling, so the text does not change shape
      // between reading it and editing it.
      attributes: { class: "description rich-surface" },
    },
    ...(onChange
      ? { onUpdate: ({ editor: e }) => onChange(serializeDescription(blocksFromDoc(e.getJSON()))) }
      : {}),
  });

  useEffect(() => {
    if (linkForm) linkRef.current?.focus();
  }, [linkForm]);

  if (!editor) return <div className="description rich-surface" />;

  const commit = (): void => {
    if (settled.current || !onCommit) return;
    settled.current = true;
    onCommit(serializeDescription(blocksFromDoc(editor.getJSON())));
  };

  const cancel = (): void => {
    if (settled.current || !onCancel) return;
    settled.current = true;
    onCancel();
  };

  const openLinkForm = (): void => {
    setLinkForm({ href: (editor.getAttributes("link").href as string) ?? "", error: null });
  };

  const applyLink = (): void => {
    if (!linkForm) return;
    const href = linkForm.href.trim();
    if (!href) {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      setLinkForm(null);
      return;
    }
    // Refused here rather than written and refused later: the main process will
    // not open a scheme off its allowlist, so a link that could never be
    // followed is worth stopping while the person is still looking at it.
    let scheme: string;
    try {
      scheme = new URL(href).protocol;
    } catch {
      setLinkForm({ ...linkForm, error: "That is not a full URL — try https://…" });
      return;
    }
    if (!LINK_SCHEMES.includes(scheme)) {
      setLinkForm({ ...linkForm, error: `${scheme} links cannot be opened from here` });
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    setLinkForm(null);
  };

  return (
    <div
      className="rich-editor"
      /*
       * Capture, not bubble. ProseMirror's own keymap is a listener on the
       * editable element itself, and TipTap binds Mod-Enter to hardBreak — so a
       * bubble-phase handler here runs *after* Ctrl+Enter has already replaced
       * the selection with a line break, and "save this" silently deleted the
       * selected word. Stopping the event during capture means the editor never
       * sees the three combinations this field has claimed for itself.
       */
      onKeyDownCapture={(e) => {
        if (e.key === "Escape") {
          // Closes the link form first if it is open, so Escape means "back out
          // of the thing I am in" rather than always "abandon the edit".
          if (linkForm) {
            e.preventDefault();
            e.stopPropagation();
            setLinkForm(null);
            editor.commands.focus();
            return;
          }
          // Only swallowed when this field owns Escape. In a dialog it belongs
          // to the dialog, and closing that is what the key should do.
          if (!onCancel) return;
          e.preventDefault();
          e.stopPropagation();
          cancel();
          return;
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          commit();
          return;
        }
        if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          openLinkForm();
        }
      }}
      // Leaving the whole control commits, the same bargain every other field in
      // this panel makes. Checked at the container so that clicking a toolbar
      // button — which blurs the text — is not mistaken for leaving.
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        commit();
      }}
    >
      <div className="rich-toolbar">
        <ToolButton editor={editor} label="B" title="Bold  (Ctrl+B)" mark="bold" onClick={() => editor.chain().focus().toggleBold().run()} />
        <ToolButton editor={editor} label="I" title="Italic  (Ctrl+I)" mark="italic" onClick={() => editor.chain().focus().toggleItalic().run()} />
        <ToolButton editor={editor} label="‹›" title="Inline code" mark="code" onClick={() => editor.chain().focus().toggleCode().run()} />
        <span className="rich-sep" />
        <ToolButton editor={editor} label="H" title="Heading" mark="heading" attrs={{ level: 4 }} onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()} />
        <ToolButton editor={editor} label="•" title="Bullet list" mark="bulletList" onClick={() => editor.chain().focus().toggleBulletList().run()} />
        <ToolButton editor={editor} label="1." title="Numbered list" mark="orderedList" onClick={() => editor.chain().focus().toggleOrderedList().run()} />
        <ToolButton editor={editor} label="❝" title="Quote" mark="blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()} />
        <ToolButton editor={editor} label="{ }" title="Code block" mark="codeBlock" onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
        <span className="rich-sep" />
        <ToolButton editor={editor} label="🔗" title="Link  (Ctrl+K)" mark="link" onClick={openLinkForm} />
        <span className="spacer" />
        {/* Only where those keys mean that. In a dialog the field commits with
            the form and Escape belongs to the dialog, so the hint would be
            telling you about two shortcuts this field does not have. */}
        {onCommit && <span className="field-note">Ctrl+Enter saves · Esc cancels</span>}
      </div>

      {linkForm && (
        <div className="rich-link-form">
          <input
            ref={linkRef}
            value={linkForm.href}
            placeholder="https://…  (empty removes the link)"
            onChange={(e) => setLinkForm({ href: e.target.value, error: null })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                applyLink();
              }
            }}
          />
          <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>
            Apply
          </button>
          {linkForm.error && <span className="field-note">{linkForm.error}</span>}
        </div>
      )}

      <EditorContent editor={editor} />
    </div>
  );
}

function ToolButton({
  editor,
  label,
  title,
  mark,
  attrs,
  onClick,
}: {
  editor: Editor;
  label: string;
  title: string;
  mark: string;
  attrs?: Record<string, unknown>;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`rich-btn ${editor.isActive(mark, attrs) ? "rich-btn-on" : ""}`}
      title={title}
      // Without this the text loses its selection before the command runs, so
      // "bold this word" would bold nothing.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

// ------------------------------------------------------- the AST, both ways

function inlineToNodes(nodes: Inline[]): JSONContent[] {
  return nodes.flatMap((node) => {
    if (node.kind === "break") return [{ type: "hardBreak" }];
    // ProseMirror rejects an empty text node outright.
    if (!node.text) return [];
    switch (node.kind) {
      case "strong":
        return [{ type: "text", text: node.text, marks: [{ type: "bold" }] }];
      case "em":
        return [{ type: "text", text: node.text, marks: [{ type: "italic" }] }];
      case "code":
        return [{ type: "text", text: node.text, marks: [{ type: "code" }] }];
      case "link":
        return [
          { type: "text", text: node.text, marks: [{ type: "link", attrs: { href: node.href } }] },
        ];
      default:
        return [{ type: "text", text: node.text }];
    }
  });
}

export function docFromBlocks(blocks: Block[]): JSONContent {
  const content = blocks.map((block): JSONContent => {
    switch (block.kind) {
      case "heading":
        return {
          type: "heading",
          attrs: { level: block.level },
          content: inlineToNodes(block.content),
        };
      case "list":
        return {
          type: block.ordered ? "orderedList" : "bulletList",
          content: block.items.map((item) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: inlineToNodes(item) }],
          })),
        };
      case "quote":
        return {
          type: "blockquote",
          content: [{ type: "paragraph", content: inlineToNodes(block.content) }],
        };
      case "code":
        return {
          type: "codeBlock",
          attrs: { language: block.language ?? null },
          content: block.text ? [{ type: "text", text: block.text }] : [],
        };
      default:
        return { type: "paragraph", content: inlineToNodes(block.content) };
    }
  });

  // An empty document still needs somewhere to put the cursor.
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/**
 * TipTap's text nodes back to inline runs.
 *
 * The grammar has no nesting — `**bold *and italic***` is not something
 * parseDescription can read back — so a run carrying two marks has to pick one.
 * The order below is by how much meaning each mark carries: a link is a
 * destination, code is a literal, and emphasis is the least of the three. The
 * dropped mark is visible immediately, because the field re-renders from what
 * was written rather than from what was on screen.
 */
function nodesToInline(nodes: JSONContent[] | undefined): Inline[] {
  const out: Inline[] = [];

  /**
   * A marked run with its surrounding spaces pushed outside the markers.
   *
   * Double-clicking or Ctrl+Shift+Right takes the trailing space with the word,
   * which would write `**bold **text` or `[label ](url)text`. Our own parser
   * reads both back, but CommonMark does not accept the first — a closing `**`
   * may not follow whitespace — so every other tool that opens the file would
   * show the asterisks instead of bold text. The space belongs to the sentence,
   * not to the emphasis or the label.
   */
  const spaced = (text: string, make: (core: string) => Inline): void => {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) as RegExpExecArray;
    if (lead) out.push({ kind: "text", text: lead });
    if (core) out.push(make(core));
    else if (!lead && trail) out.push({ kind: "text", text: trail });
    if (core && trail) out.push({ kind: "text", text: trail });
  };

  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out.push({ kind: "break" });
      continue;
    }
    if (node.type !== "text" || !node.text) continue;

    const marks = (node.marks ?? []).map((m) => m.type);
    const href = node.marks?.find((m) => m.type === "link")?.attrs?.href as string | undefined;

    // Inline code keeps its text verbatim — a space inside a code span is part
    // of the literal, and it round-trips as written.
    if (href) spaced(node.text, (text) => ({ kind: "link", text, href }));
    else if (marks.includes("code")) out.push({ kind: "code", text: node.text });
    else if (marks.includes("bold")) spaced(node.text, (text) => ({ kind: "strong", text }));
    else if (marks.includes("italic")) spaced(node.text, (text) => ({ kind: "em", text }));
    else out.push({ kind: "text", text: node.text });
  }
  return out;
}

/**
 * Flattens breaks to spaces for the two blocks that are one line by definition.
 *
 * Shift+Enter works anywhere in a ProseMirror document, including inside a
 * heading or a list item. Written out, that newline would end the block: the
 * second half of a heading would read back as a paragraph. Turning it into a
 * space keeps the words and loses only a line break that the file could not
 * have held anyway.
 */
function oneLine(nodes: Inline[]): Inline[] {
  return nodes.map((node) => (node.kind === "break" ? { kind: "text", text: " " } : node));
}

export function blocksFromDoc(doc: JSONContent): Block[] {
  const blocks: Block[] = [];

  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "heading":
        blocks.push({
          kind: "heading",
          level: (node.attrs?.level as number) ?? 1,
          content: oneLine(nodesToInline(node.content)),
        });
        break;
      case "bulletList":
      case "orderedList":
        blocks.push({
          kind: "list",
          ordered: node.type === "orderedList",
          // A list item holds paragraphs; the grammar's items hold one line, so
          // a hard-wrapped item flattens into a single run.
          items: (node.content ?? []).map((item) =>
            oneLine((item.content ?? []).flatMap((child) => nodesToInline(child.content))),
          ),
        });
        break;
      case "blockquote": {
        // Several paragraphs in one quote become one quote with breaks in it,
        // which is the only shape the grammar has for a multi-line quotation.
        const content: Inline[] = [];
        for (const child of node.content ?? []) {
          if (content.length) content.push({ kind: "break" });
          content.push(...nodesToInline(child.content));
        }
        blocks.push({ kind: "quote", content });
        break;
      }
      case "codeBlock": {
        const language = (node.attrs?.language as string | null) ?? undefined;
        blocks.push({
          kind: "code",
          ...(language ? { language } : {}),
          text: (node.content ?? []).map((c) => c.text ?? "").join(""),
        });
        break;
      }
      default: {
        const content = nodesToInline(node.content);
        // An empty paragraph is the cursor resting between blocks, not a block.
        // Kept out, or every save would grow the file by a blank line.
        if (content.length) blocks.push({ kind: "paragraph", content });
      }
    }
  }

  return blocks;
}
