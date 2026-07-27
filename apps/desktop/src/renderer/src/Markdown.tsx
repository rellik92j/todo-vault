// The grammar comes from the core, shared with the Jira push, so this renders
// exactly the subset that survives a push and nothing more. Imported from the
// description subpath rather than the package root for the usual reason: the
// root pulls vault.js and with it node:fs.
import { parseDescription, type Block, type Inline } from "todo-vault/description";

/**
 * A description, rendered.
 *
 * Built as React elements from the parsed blocks — never
 * `dangerouslySetInnerHTML`. A description can be written by an external Claude
 * or typed into Notepad, so markup inside one is text, not markup, and there is
 * no path from a vault file to script in this window.
 *
 * Links hand their target to the caller instead of navigating. A renderer-side
 * navigation would replace the app itself, and the target is untrusted anyway:
 * `onOpenLink` routes to the main process, which holds the scheme allowlist.
 */
export function Markdown({
  source,
  onOpenLink,
}: {
  source: string;
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  return (
    <>
      {parseDescription(source).map((block, index) => (
        <BlockNode key={index} block={block} onOpenLink={onOpenLink} />
      ))}
    </>
  );
}

function BlockNode({
  block,
  onOpenLink,
}: {
  block: Block;
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  const inline = (nodes: Inline[]): React.JSX.Element => (
    <InlineNodes nodes={nodes} onOpenLink={onOpenLink} />
  );

  switch (block.kind) {
    case "heading": {
      // The panel's own headings are h2 and h3, so a description's h1 would
      // outrank the item's summary. Clamped to h4-h6 to keep the outline
      // honest; the CSS sizes them, not the tag.
      const Tag = `h${Math.min(6, block.level + 3)}` as "h4" | "h5" | "h6";
      return <Tag>{inline(block.content)}</Tag>;
    }
    case "list":
      return block.ordered ? (
        <ol>
          {block.items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul>
          {block.items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>
      );
    case "quote":
      return <blockquote>{inline(block.content)}</blockquote>;
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    default:
      return <p>{inline(block.content)}</p>;
  }
}

function InlineNodes({
  nodes,
  onOpenLink,
}: {
  nodes: Inline[];
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.kind) {
          case "strong":
            return <strong key={index}>{node.text}</strong>;
          case "em":
            return <em key={index}>{node.text}</em>;
          case "code":
            return <code key={index}>{node.text}</code>;
          case "break":
            return <br key={index} />;
          case "link":
            return (
              // An anchor for the affordance — hover, and a target worth
              // reading — but the click never navigates.
              <a
                key={index}
                className="link-btn"
                href={node.href}
                title={node.href}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenLink(node.href);
                }}
              >
                {node.text}
              </a>
            );
          default:
            return <span key={index}>{node.text}</span>;
        }
      })}
    </>
  );
}
