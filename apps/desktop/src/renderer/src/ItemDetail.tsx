import { useEffect, useState } from "react";
import type { Item } from "todo-vault";
import { Cadence, DueDate, PriorityMark, StatusPill } from "./pieces";

/**
 * Everything the vault knows about one item.
 *
 * Read-only for now — editing is the next phase. The reveal-in-folder buttons
 * matter more than they look: they make the point that the item *is* a markdown
 * file, and that the app is a view over it rather than the thing holding it.
 */
export function ItemDetail({
  item,
  onClose,
  onSelect,
}: {
  item: Item;
  onClose: () => void;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  const [related, setRelated] = useState<{ children: Item[]; backlinks: Item[] }>({
    children: [],
    backlinks: [],
  });

  useEffect(() => {
    let live = true;
    void window.vault.getRelated(item.key).then((result) => {
      if (live && result.ok) setRelated(result.value);
    });
    return () => {
      live = false;
    };
  }, [item.key, item.updated]);

  const reveal = (kind: "item" | "attachment", value: string): void => {
    void window.vault.revealPath({ kind, value });
  };

  return (
    <aside className="detail">
      <header className="detail-head">
        <span className="cell-key">{item.key}</span>
        <span className="type">{item.type}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => reveal("item", item.key)} title="Show the markdown file">
          Reveal file
        </button>
        <button className="btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="detail-body">
        <h2 className="detail-summary">{item.summary}</h2>

        <dl className="fields">
          <dt>Status</dt>
          <dd>
            <StatusPill status={item.status} />
          </dd>
          <dt>Priority</dt>
          <dd>
            <PriorityMark priority={item.priority} />
          </dd>
          <dt>Project</dt>
          <dd>{item.project}</dd>
          {item.parent && (
            <>
              <dt>Parent</dt>
              <dd>
                <button className="link-btn" onClick={() => onSelect(item.parent as string)}>
                  {item.parent}
                </button>
              </dd>
            </>
          )}
          {item.category && (
            <>
              <dt>Category</dt>
              <dd>{item.category}</dd>
            </>
          )}
          {item.dueDate && (
            <>
              <dt>Due</dt>
              <dd>
                <DueDate item={item} />
              </dd>
            </>
          )}
          {item.startDate && (
            <>
              <dt>Start</dt>
              <dd>{item.startDate}</dd>
            </>
          )}
          {item.cadence !== "none" && (
            <>
              <dt>Cadence</dt>
              <dd>
                <Cadence cadence={item.cadence} />
              </dd>
            </>
          )}
          {item.estimate !== undefined && (
            <>
              <dt>Estimate</dt>
              <dd>{item.estimate}</dd>
            </>
          )}
          {item.assignee && (
            <>
              <dt>Assignee</dt>
              <dd>{item.assignee}</dd>
            </>
          )}
          {item.rank !== undefined && (
            <>
              <dt>Rank</dt>
              <dd className="mono-path">{item.rank}</dd>
            </>
          )}
          {item.labels.length > 0 && (
            <>
              <dt>Labels</dt>
              <dd>
                {item.labels.map((l) => (
                  <span className="label" key={l}>
                    {l}
                  </span>
                ))}
              </dd>
            </>
          )}
          <dt>Jira</dt>
          <dd>
            {item.sync.jiraKey ? (
              <>
                {item.sync.jiraKey} <span className="pill">{item.sync.state}</span>
              </>
            ) : (
              <span style={{ color: "var(--text-faint)" }}>not pushed</span>
            )}
          </dd>
          <dt>Updated</dt>
          <dd className="mono-path">{item.updated.replace("T", " ").slice(0, 19)}</dd>
        </dl>

        {item.description.trim() && (
          <div className="detail-section">
            <h3>Description</h3>
            <pre className="description">{item.description.trim()}</pre>
          </div>
        )}

        {related.children.length > 0 && (
          <div className="detail-section">
            <h3>Children</h3>
            <div className="rows">
              {related.children.map((child) => (
                <button type="button" className="row" key={child.key} onClick={() => onSelect(child.key)}>
                  <span className="cell-key">{child.key}</span>
                  <span className="row-summary">{child.summary}</span>
                  <StatusPill status={child.status} />
                </button>
              ))}
            </div>
          </div>
        )}

        {item.links.length > 0 && (
          <div className="detail-section">
            <h3>Links</h3>
            {item.links.map((link, index) => (
              <div className="link-row" key={`${link.type}-${link.target}-${index}`}>
                <span className="link-type">{link.type}</span>
                <span className="link-target">
                  {link.type === "item" ? (
                    <button className="link-btn" onClick={() => onSelect(link.target)}>
                      {link.label ?? link.target}
                    </button>
                  ) : link.type === "url" ? (
                    <a
                      className="link-btn"
                      href={link.target}
                      target="_blank"
                      rel="noreferrer"
                      title={link.target}
                    >
                      {link.label ?? link.target}
                    </a>
                  ) : (
                    <>
                      {link.label && <div>{link.label}</div>}
                      <div className="mono-path">{link.target}</div>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {item.attachments.length > 0 && (
          <div className="detail-section">
            <h3>Attachments</h3>
            {item.attachments.map((attachment) => (
              <div className="link-row" key={attachment.path}>
                <span className="link-type">file</span>
                <span className="link-target">
                  <button className="link-btn" onClick={() => reveal("attachment", attachment.path)}>
                    {attachment.title ?? attachment.path.split("/").pop()}
                  </button>
                  <div className="mono-path">
                    {attachment.path}
                    {attachment.bytes !== undefined && ` · ${formatBytes(attachment.bytes)}`}
                  </div>
                </span>
              </div>
            ))}
          </div>
        )}

        {related.backlinks.length > 0 && (
          <div className="detail-section">
            <h3>Linked from</h3>
            <div className="rows">
              {related.backlinks.map((source) => (
                <button type="button" className="row" key={source.key} onClick={() => onSelect(source.key)}>
                  <span className="cell-key">{source.key}</span>
                  <span className="row-summary">{source.summary}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {item.comments.length > 0 && (
          <div className="detail-section">
            <h3>Comments</h3>
            {item.comments.map((comment, index) => (
              <div className="comment" key={`${comment.at}-${index}`}>
                <div className="comment-meta">
                  {comment.author} · {comment.at.replace("T", " ").slice(0, 16)}
                </div>
                <div className="comment-body">{comment.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
