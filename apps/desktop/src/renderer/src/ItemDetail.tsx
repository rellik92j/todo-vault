import { useEffect, useRef, useState } from "react";
import {
  CADENCES,
  ITEM_TYPES,
  PRIORITIES,
  type Cadence,
  type ItemType,
  type Priority,
  type Status,
} from "todo-vault/constants";
import type { Item } from "todo-vault";
import type { Result, VaultSnapshot } from "@shared/api";

import { EditableDate, EditableList, EditableSelect, EditableText } from "./Editable";
import {
  Cadence as CadencePill,
  STATUS_LABELS,
  isOverdue,
  legalParents,
  legalTransitions,
} from "./pieces";

/**
 * Everything the vault knows about one item, editable in place.
 *
 * Every field commits straight through to the vault — there is no local draft
 * state to get out of sync, and no save button, because the file on disk is the
 * document. The reveal buttons make that point: the app is a view over markdown.
 */
export function ItemDetail({
  item,
  items,
  editSummary,
  onEditSummaryConsumed,
  onClose,
  onSelect,
  onDelete,
  mutate,
}: {
  item: Item;
  /** Everything this window admits exists, for the parent picker to choose from. */
  items: Item[];
  /** Open with the summary already in edit mode — the `e` shortcut. */
  editSummary?: boolean;
  onEditSummaryConsumed?: () => void;
  onClose: () => void;
  onSelect: (key: string) => void;
  onDelete: (item: Item) => void;
  mutate: (call: () => Promise<Result<VaultSnapshot | null>>) => Promise<string | null>;
}): React.JSX.Element {
  const [related, setRelated] = useState<{ children: Item[]; backlinks: Item[] }>({
    children: [],
    backlinks: [],
  });
  const [comment, setComment] = useState("");
  const [linkDraft, setLinkDraft] = useState({ type: "url", target: "", label: "" });
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [dropping, setDropping] = useState(false);

  useEffect(() => {
    let live = true;
    void window.vault.getRelated(item.key).then((result) => {
      if (live && result.ok) setRelated(result.value);
    });
    return () => {
      live = false;
    };
  }, [item.key, item.updated]);

  const patch = (fields: Record<string, unknown>): void => {
    void mutate(() => window.vault.updateItem(item.key, fields));
  };

  const reveal = (kind: "item" | "attachment", value: string): void => {
    void window.vault.revealPath({ kind, value });
  };

  // Only legal destinations, plus the current one, so a rejected write is
  // impossible rather than merely reported.
  const statusOptions = [item.status, ...legalTransitions(item.status)] as Status[];

  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setDropping(false);
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    const paths = window.vault.pathsForFiles(files);
    void mutate(() => window.vault.attachPaths(item.key, paths, true));
  };

  return (
    <aside
      className={`detail ${dropping ? "detail-dropping" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
    >
      <header className="detail-head">
        <span className="cell-key">{item.key}</span>
        <EditableSelect<ItemType>
          value={item.type}
          options={ITEM_TYPES}
          onCommit={(type) => patch({ type })}
        />
        <div className="spacer" />
        <button className="btn" onClick={() => reveal("item", item.key)} title="Show the markdown file">
          Reveal
        </button>
        <button className="btn btn-danger" onClick={() => onDelete(item)} title="Move to .trash">
          Delete
        </button>
        <button className="btn" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <div className="detail-body">
        <h2 className="detail-summary">
          <EditableText
            value={item.summary}
            autoEdit={editSummary}
            onAutoEditConsumed={onEditSummaryConsumed}
            onCommit={(summary) => patch({ summary })}
          />
        </h2>

        <dl className="fields">
          <dt>Status</dt>
          <dd>
            <EditableSelect<Status>
              value={item.status}
              options={statusOptions}
              labels={STATUS_LABELS}
              onCommit={(status) => void mutate(() => window.vault.transitionItem(item.key, status))}
            />
            {legalTransitions(item.status).length === 0 && (
              <span className="field-note">no moves from here</span>
            )}
          </dd>

          <dt>Priority</dt>
          <dd>
            <EditableSelect<Priority>
              value={item.priority}
              options={PRIORITIES}
              onCommit={(priority) => patch({ priority })}
            />
          </dd>

          <dt>Project</dt>
          <dd>{item.project}</dd>

          <dt>Parent</dt>
          <dd>
            <ParentField
              item={item}
              items={items}
              onSelect={onSelect}
              onCommit={(parent) => patch({ parent })}
            />
          </dd>

          <dt>Category</dt>
          <dd>
            <EditableText
              value={item.category ?? ""}
              placeholder="none"
              onCommit={(category) => patch({ category: category || null })}
            />
          </dd>

          <dt>Labels</dt>
          <dd>
            <EditableList
              value={item.labels}
              placeholder="none"
              onCommit={(labels) => patch({ labels })}
            />
          </dd>

          <dt>Start</dt>
          <dd>
            <EditableDate value={item.startDate} onCommit={(startDate) => patch({ startDate })} />
          </dd>

          <dt>Due</dt>
          <dd>
            <EditableDate value={item.dueDate} onCommit={(dueDate) => patch({ dueDate })} />
            {/*
              The flag only, not the date again: the field beside it is already
              showing the date, and printing it twice made the row read as two
              different facts. Overdue is the part the field itself cannot say.
            */}
            {isOverdue(item) && <span className="field-note due-overdue">overdue</span>}
          </dd>

          <dt>Cadence</dt>
          <dd>
            <EditableSelect<Cadence>
              value={item.cadence}
              options={CADENCES}
              onCommit={(cadence) => patch({ cadence })}
            />
            <CadencePill cadence={item.cadence} />
          </dd>

          <dt>Estimate</dt>
          <dd>
            <EditableText
              value={item.estimate === undefined ? "" : String(item.estimate)}
              placeholder="none"
              onCommit={(raw) => {
                if (!raw) return patch({ estimate: null });
                const parsed = Number(raw);
                if (Number.isFinite(parsed) && parsed >= 0) patch({ estimate: parsed });
              }}
            />
          </dd>

          <dt>Assignee</dt>
          <dd>
            <EditableText
              value={item.assignee ?? ""}
              placeholder="none"
              onCommit={(assignee) => patch({ assignee: assignee || null })}
            />
          </dd>

          <dt>Jira</dt>
          <dd>
            {item.sync.jiraKey ? (
              <>
                {item.sync.jiraKey} <span className="pill">{item.sync.state}</span>
              </>
            ) : (
              <span className="field-note">not pushed</span>
            )}
          </dd>

          <dt>Updated</dt>
          <dd className="mono-path">{item.updated.replace("T", " ").slice(0, 19)}</dd>
        </dl>

        <div className="detail-section">
          <h3>Description</h3>
          <EditableText
            value={item.description}
            placeholder="Click to add a description…"
            multiline
            onCommit={(description) => patch({ description })}
          />
        </div>

        {related.children.length > 0 && (
          <div className="detail-section">
            <h3>Children</h3>
            <div className="rows">
              {related.children.map((child) => (
                <button type="button" className="row" key={child.key} onClick={() => onSelect(child.key)}>
                  <span className="cell-key">{child.key}</span>
                  <span className="row-summary">{child.summary}</span>
                  <span className="pill">{STATUS_LABELS[child.status]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="detail-section">
          <h3>
            Links
            <button className="add-btn" onClick={() => setShowLinkForm((v) => !v)}>
              {showLinkForm ? "cancel" : "+ add"}
            </button>
          </h3>

          {showLinkForm && (
            <form
              className="mini-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!linkDraft.target.trim()) return;
                void mutate(() =>
                  window.vault.addLink(item.key, {
                    type: linkDraft.type,
                    target: linkDraft.target.trim(),
                    label: linkDraft.label.trim() || undefined,
                  }),
                ).then((err) => {
                  if (!err) {
                    setLinkDraft({ type: "url", target: "", label: "" });
                    setShowLinkForm(false);
                  }
                });
              }}
            >
              <select
                value={linkDraft.type}
                onChange={(e) => setLinkDraft({ ...linkDraft, type: e.target.value })}
              >
                {["url", "item", "file", "folder", "outlook", "note"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                placeholder={linkDraft.type === "item" ? "ACME-42" : "target"}
                value={linkDraft.target}
                onChange={(e) => setLinkDraft({ ...linkDraft, target: e.target.value })}
              />
              <input
                placeholder="label (optional)"
                value={linkDraft.label}
                onChange={(e) => setLinkDraft({ ...linkDraft, label: e.target.value })}
              />
              <button className="btn btn-primary" type="submit">
                Add
              </button>
            </form>
          )}

          {item.links.map((link, index) => (
            <div className="link-row" key={`${link.type}-${link.target}-${index}`}>
              <span className="link-type">{link.type}</span>
              <span className="link-target">
                {link.type === "item" ? (
                  <button className="link-btn" onClick={() => onSelect(link.target)}>
                    {link.label ?? link.target}
                  </button>
                ) : link.type === "url" ? (
                  <a className="link-btn" href={link.target} target="_blank" rel="noreferrer">
                    {link.label ?? link.target}
                  </a>
                ) : (
                  <>
                    {link.label && <div>{link.label}</div>}
                    <div className="mono-path">{link.target}</div>
                  </>
                )}
              </span>
              <button
                className="clear-btn"
                title="Remove link"
                onClick={() => void mutate(() => window.vault.removeLink(item.key, link.target))}
              >
                ✕
              </button>
            </div>
          ))}
          {item.links.length === 0 && !showLinkForm && (
            <div className="field-note">No links.</div>
          )}
        </div>

        <div className="detail-section">
          <h3>
            Attachments
            <button className="add-btn" onClick={() => void mutate(() => window.vault.attachViaDialog(item.key, true))}>
              + copy in
            </button>
            <button className="add-btn" onClick={() => void mutate(() => window.vault.attachViaDialog(item.key, false))}>
              + link in place
            </button>
          </h3>

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
          {item.attachments.length === 0 && (
            <div className="field-note">
              None. Drop files anywhere on this panel to copy them in.
            </div>
          )}
        </div>

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

        <div className="detail-section">
          <h3>Comments</h3>
          {item.comments.map((entry, index) => (
            <div className="comment" key={`${entry.at}-${index}`}>
              <div className="comment-meta">
                {entry.author} · {entry.at.replace("T", " ").slice(0, 16)}
              </div>
              <div className="comment-body">{entry.body}</div>
            </div>
          ))}

          <form
            className="mini-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              void mutate(() => window.vault.addComment(item.key, comment)).then((err) => {
                if (!err) setComment("");
              });
            }}
          >
            <input
              placeholder="Add to the running log…"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!comment.trim()}>
              Comment
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

/**
 * The parent: a link you can follow, and a picker you can change it with.
 *
 * Every other field in this panel opens for editing when you click its value,
 * and this one did not — an item with no parent read "none" as dead text, so
 * the only way to attach one was the create form or the CLI. It now clicks
 * through to a picker like the rest of them.
 *
 * A set parent stays a link rather than becoming the picker's trigger, because
 * an item key is a cross-reference everywhere else in this panel and following
 * it is the only way up the hierarchy. So the picker gets its own control
 * beside it, and the click that already meant "go there" still means that.
 *
 * What it offers is legalParents(), the list the create form uses, so a parent
 * the vault would refuse is never on the menu.
 */
function ParentField({
  item,
  items,
  onSelect,
  onCommit,
}: {
  item: Item;
  items: Item[];
  onSelect: (key: string) => void;
  onCommit: (next: string | null) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    ref.current?.focus();
    try {
      // The same bargain EditableDate makes: the click that opened the field is
      // the user activation this needs, and if it has lapsed the select is
      // still a focused select — the list is one more click away, not gone.
      ref.current?.showPicker();
    } catch {
      /* the keyboard and a second click both still work */
    }
  }, [editing]);

  // Nothing to pick from, so the field says why rather than offering an empty
  // menu. The core refuses this outright: epics are the top of the hierarchy.
  if (item.type === "epic") {
    return <span className="field-note">epics sit at the top</span>;
  }

  const parent = item.parent;
  const choices = legalParents(items, item.project, item.type);
  // A parent set from outside this window can be one `choices` excludes — the
  // CLI and MCP server allow a cross-project link, and the project it points
  // into may also be hidden here. Offer it as an option anyway, or the select
  // would render blank and quietly misreport what the file says.
  const offProject = parent && !choices.some((c) => c.key === parent) ? parent : null;

  if (editing) {
    return (
      <select
        ref={ref}
        className="inline-select"
        value={parent ?? ""}
        onChange={(e) => {
          setEditing(false);
          onCommit(e.target.value || null);
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          // No draft to revert — the select commits whole choices only — so
          // Escape just leaves. It closes this before App's handler sees it,
          // which is what stops the same keypress from closing the panel.
          if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      >
        {/* A subtask must name a parent, so detaching is not on offer. */}
        {item.type !== "subtask" && <option value="">none</option>}
        {offProject && <option value={offProject}>{offProject}</option>}
        {choices.map((candidate) => (
          <option key={candidate.key} value={candidate.key}>
            {candidate.key} — {candidate.summary}
          </option>
        ))}
      </select>
    );
  }

  return (
    <span className="parent-field">
      {parent ? (
        <>
          <button className="link-btn" onClick={() => onSelect(parent)}>
            {parent}
          </button>
          <button className="add-btn" onClick={() => setEditing(true)} title="Pick another parent">
            change
          </button>
          {/*
            No detach for a subtask: the schema requires it to name a parent, so
            this button could only ever fail. Moving it means picking another.
          */}
          {item.type !== "subtask" && (
            <button
              className="clear-btn"
              title="Detach from parent"
              onClick={() => onCommit(null)}
            >
              ✕
            </button>
          )}
        </>
      ) : (
        <button
          className="inline-edit inline-empty"
          onClick={() => setEditing(true)}
          title="Click to pick a parent"
        >
          none
        </button>
      )}
      {/*
        Said before the menu is opened rather than discovered inside it, the way
        Status says "no moves from here" instead of offering a dropdown of one.
      */}
      {!parent && choices.length === 0 && (
        <span className="field-note">
          {item.type === "subtask"
            ? `nothing in ${item.project} to hang it off`
            : `no epic in ${item.project} yet`}
        </span>
      )}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
