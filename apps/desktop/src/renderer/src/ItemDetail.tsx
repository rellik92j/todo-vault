import { useEffect, useMemo, useRef, useState } from "react";
import {
  CADENCES,
  ITEM_TYPES,
  PRIORITIES,
  type Cadence,
  type ItemType,
  type Priority,
  type Status,
} from "todo-vault/constants";
import { isTickedFor, todayIso } from "todo-vault/recurrence";
import { classifyLinkTarget } from "todo-vault/link-target";
import type { HistoryEntry, Item } from "todo-vault";
import type { Result, VaultSnapshot } from "@shared/api";

import { parseUriList } from "./drops";
import { HistoryList } from "./History";
import { Markdown } from "./Markdown";
import { RichEditor } from "./RichEditor";
import {
  EditableDate,
  EditableList,
  EditableMarkdown,
  EditableSelect,
  EditableText,
} from "./Editable";
import {
  Cadence as CadencePill,
  CHILD_TYPES,
  STATUS_LABELS,
  StatusPill,
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
  reporters,
  editSummary,
  onEditSummaryConsumed,
  onClose,
  onSelect,
  onDelete,
  onNewChild,
  mutate,
  attachPaths,
}: {
  item: Item;
  /** Everything this window admits exists, for the parent picker to choose from. */
  items: Item[];
  /**
   * Every name the vault has used, for the Reporter menu. A prop rather than
   * derived from `items`, because the two answer different questions: a parent
   * must be somewhere you can see, and a name need only have been used once.
   */
  reporters: string[];
  /** Open with the summary already in edit mode — the `e` shortcut. */
  editSummary?: boolean;
  onEditSummaryConsumed?: () => void;
  onClose: () => void;
  onSelect: (key: string) => void;
  onDelete: (item: Item) => void;
  /** Opens the create form pointed at this item as parent, already typed. */
  onNewChild: (parent: Item, type: ItemType) => void;
  mutate: (call: () => Promise<Result<VaultSnapshot | null>>) => Promise<string | null>;
  /** Dropped paths, which main may link rather than copy — see `onDrop`. */
  attachPaths: (
    key: string,
    paths: string[],
    copy: boolean,
  ) => Promise<{ error: string | null; linkedInstead: string[] }>;
}): React.JSX.Element {
  const [related, setRelated] = useState<{
    children: Item[];
    backlinks: Item[];
    linked: Record<string, Status | null>;
  }>({
    children: [],
    backlinks: [],
    linked: {},
  });
  /*
    `showHistory` survives switching items on purpose. App.tsx mounts
    <ItemDetail> without a `key` prop, so React reuses the instance and this
    stays set — so it reads as a preference ("I want to see history") rather
    than something to re-click on every item. That is only defensible because
    the toggle beside the heading can turn it back off; sticky state with no
    way out is just a section you cannot dismiss.

    If a `key` prop is ever added here, lift this flag up to App or it silently
    becomes per-item.
  */
  const [showHistory, setShowHistory] = useState(false);
  /** null while a page is in flight — distinct from an item with no history. */
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [comment, setComment] = useState("");
  // Bumped after a successful post, to remount the editor — RichEditor takes
  // its content once, at mount, so setComment("") alone would clear the state
  // and leave the typed text on screen. CreateDialog:63 has the same trick.
  const [commentGeneration, setCommentGeneration] = useState(0);
  const [linkDraft, setLinkDraft] = useState({ type: "url", target: "", label: "" });
  const [showLinkForm, setShowLinkForm] = useState(false);
  const [dropping, setDropping] = useState(false);
  /**
   * What a drop did, when that differs from what it looked like it would do.
   * Not an error, so it does not belong on the error banner; dismissible,
   * because it is a statement rather than a question.
   */
  const [dropNote, setDropNote] = useState<string | null>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [sourceDescription, setSourceDescription] = useState(false);

  const ticked = isTickedFor(item, todayIso());

  /**
   * Which of the keys on this panel the rest of the window agrees exist.
   *
   * `related` is resolved in main, over the whole vault, so it can name an item
   * in a hidden project — deliberately, but it means a row here can be one the
   * sidebar, the backlog and the board all say is not there. Clicking it would
   * close this panel rather than move it, so the row says so first.
   */
  const inWindow = useMemo(() => new Set(items.map((i) => i.key)), [items]);

  useEffect(() => {
    let live = true;
    void window.vault.getRelated(item.key).then((result) => {
      if (live && result.ok) setRelated(result.value);
    });
    return () => {
      live = false;
    };
  }, [item.key, item.updated]);

  /*
    `item.updated`, never `item`.

    This component re-renders on every keystroke — it holds the comment box and
    the inline editors — and `git log` is the most expensive call in the app.
    `updated` is the ISO stamp the core rewrites on every save, so it means
    exactly "this item has been committed since we last looked"; typing in the
    comment box does not touch it. Same trick as the global view's dependency on
    lastCommit.hash, for the same reason.
  */
  useEffect(() => {
    if (!showHistory) return;
    let live = true;
    setHistory(null);
    void window.vault.getHistory({ key: item.key, limit: 10 }).then((result) => {
      if (live && result.ok) setHistory(result.value.entries);
    });
    return () => {
      live = false;
    };
  }, [item.key, item.updated, showHistory]);

  // Keyed on the item alone, not on `updated`: another item's description is a
  // different document, so the field closes, but a write landing while you type
  // must not take the textarea out from under you.
  useEffect(() => {
    setEditingDescription(false);
    setSourceDescription(false);
    // The note describes a drop onto *this* item, so it must not follow the
    // panel to the next one.
    setDropNote(null);
  }, [item.key]);

  const patch = (fields: Record<string, unknown>): void => {
    void mutate(() => window.vault.updateItem(item.key, fields));
  };

  const reveal = (kind: "item" | "attachment", value: string): void => {
    void window.vault.revealPath({ kind, value });
  };

  // Routed through `mutate` even though nothing here touches the snapshot,
  // so a failed open surfaces on the same error banner every other refusal
  // in this panel uses, instead of the click just doing nothing.
  const openTarget = (
    kind: "attachment" | "file" | "folder" | "external",
    value: string,
  ): void => {
    void mutate(() => window.vault.openTarget({ kind, value }));
  };

  // Only legal destinations, plus the current one, so a rejected write is
  // impossible rather than merely reported.
  const statusOptions = [item.status, ...legalTransitions(item.status)] as Status[];

  /**
   * What to say about a pasted OneDrive link, if anything.
   *
   * A warning and never a refusal. The hostname sniff is a heuristic — a
   * tenant can sit on a vanity domain, and `contoso.sharepoint.com` without
   * the `-my` is a document library rather than OneDrive — so a wrong silent
   * rule would block links that are perfectly good. The link is stored as
   * `url` either way; this only decides whether to say the guess disagrees.
   */
  const oneDriveWarning = useMemo(() => {
    if (linkDraft.type !== "onedrive") return null;
    const target = linkDraft.target.trim();
    if (!target) return null;

    switch (classifyLinkTarget(target)) {
      case "onedrive":
        return null;
      case "sharepoint":
        return "That is a SharePoint library rather than OneDrive. The same rule applies — it stays where it is — so this is fine to add.";
      case "path":
        return "That is a filesystem path, not a link. Paste the web link from OneDrive's Share menu, or use the file type to point at the synced copy.";
      default:
        return "That host does not look like OneDrive. Adding it is fine — it is stored as an ordinary url link either way.";
    }
  }, [linkDraft.type, linkDraft.target]);

  /**
   * Three kinds of drag land here, and before this only the first worked.
   *
   * Files from Explorer arrive as `dataTransfer.files` and are copied in —
   * except when they live in a OneDrive or SharePoint folder, where main links
   * them in place instead. That is a different outcome from the one the
   * gesture implies, so it is stated rather than assumed: `dropNote` says what
   * happened and why.
   *
   * A folder carries a path that is not a file; main routes it to a `folder`
   * link, which used to throw and fail the whole drop.
   *
   * A document dragged out of the OneDrive web UI carries no file at all —
   * just a URL — and used to do nothing whatsoever.
   */
  const onDrop = (event: React.DragEvent): void => {
    event.preventDefault();
    setDropping(false);
    setDropNote(null);

    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      const paths = window.vault.pathsForFiles(files);
      void attachPaths(item.key, paths, true).then(({ error, linkedInstead }) => {
        if (error || !linkedInstead.length) return;
        const names = linkedInstead.map((p) => p.split(/[\\/]/).pop() ?? p);
        setDropNote(
          `${names.join(", ")} ${names.length === 1 ? "is" : "are"} in a synced folder, so ` +
            `${names.length === 1 ? "it was" : "they were"} linked in place rather than copied — ` +
            `one version, still owned by OneDrive.`,
        );
      });
      return;
    }

    const urls = parseUriList(event.dataTransfer.getData("text/uri-list"));
    if (!urls.length) return;
    void (async () => {
      for (const url of urls) {
        // Stored as `type: url`, whatever the host: a separate link type would
        // be an enum value older builds cannot parse. See SCHEMA.md.
        const error = await mutate(() =>
          window.vault.addLink(item.key, { type: "url", target: url }),
        );
        if (error) return;
      }
      const fromOneDrive = urls.filter((u) => classifyLinkTarget(u) !== "url");
      if (fromOneDrive.length) {
        setDropNote(
          `Linked ${fromOneDrive.length === 1 ? "the document" : `${fromOneDrive.length} documents`} ` +
            `where ${fromOneDrive.length === 1 ? "it lives" : "they live"} — nothing was copied into the vault.`,
        );
      }
    })();
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
            <CadencePill cadence={item.cadence} ticked={ticked} />
          </dd>

          {/*
            Only for recurring items, and the panel is where undo has to live:
            ticking removes the row from the agenda, so the ✓ that did it is no
            longer on screen to press again.
          */}
          {item.cadence !== "none" && (
            <>
              <dt>Done</dt>
              <dd>
                <button
                  type="button"
                  className={`tick-wide${ticked ? " tick-done" : ""}`}
                  aria-pressed={ticked}
                  onClick={() =>
                    void mutate(() => window.vault.tickItem(item.key, undefined, ticked))
                  }
                >
                  {ticked ? "✓ done this period — undo" : `✓ log as done`}
                </button>
                <span className="field-note">
                  {item.completions.length === 0
                    ? "never ticked"
                    : `${item.completions.length} recorded, last ${item.completions[item.completions.length - 1]}`}
                </span>
              </dd>
            </>
          )}

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

          {/*
            Who asked for this. Named for the field on disk rather than "requested
            by", because it sits beside Assignee — Jira's word too — and this
            panel is a view over the file, where the key is `reporter` and the CLI
            flag is `--reporter`.

            The menu is what the vault has already been told, not a roster: a name
            it has never seen is typed straight in, and is on the menu from then
            on. See knownReporters for how spellings of one person are folded.
          */}
          <dt>Reporter</dt>
          <dd>
            <EditableText
              value={item.reporter ?? ""}
              placeholder="none"
              suggestions={reporters}
              onCommit={(reporter) => patch({ reporter: reporter || null })}
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
          <h3>
            Description
            {/* The read view renders markdown, so it cannot be a button you
                click to edit — hence the affordance up here, beside the ones
                Links and Attachments already carry. */}
            {/* Gone while the textarea is open: a mousedown on it would blur
                the field, commit, and then the click would re-open it — the
                same trap EditableDate's clear button documents. Blur and
                Ctrl+Enter both commit, so it has nothing left to do there. */}
            {item.description && !editingDescription && (
              <button className="add-btn" onClick={() => setEditingDescription(true)}>
                edit
              </button>
            )}
            {/* The rich editor is the default, but the file is still the
                document: this is how you see and fix exactly what is in it. */}
            {item.description && (
              <button
                className="add-btn"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSourceDescription((v) => !v)}
                title="Edit the raw markdown"
              >
                {sourceDescription ? "rich" : "source"}
              </button>
            )}
          </h3>
          <EditableMarkdown
            value={item.description}
            placeholder="Click to add a description…"
            editing={editingDescription}
            setEditing={setEditingDescription}
            source={sourceDescription}
            onCommit={(description) => patch({ description })}
            onOpenLink={(href) => openTarget("external", href)}
          />
        </div>

        {/*
          The second disjunct is defensive and should be dead — the core
          forbids a subtask being a parent — but a hand-edited file that broke
          the rule would otherwise have its children silently disappear from
          the panel, and hiding data is the worse failure.
        */}
        {(CHILD_TYPES[item.type].length > 0 || related.children.length > 0) && (
          <div className="detail-section">
            <h3>
              Children
              <NewChildControl types={CHILD_TYPES[item.type]} onPick={(type) => onNewChild(item, type)} />
            </h3>
            <div className="rows">
              {related.children.map((child) => (
                <button type="button" className="row" key={child.key} onClick={() => onSelect(child.key)}>
                  <span className="cell-key">{child.key}</span>
                  <span className="row-summary">{child.summary}</span>
                  <RelatedStatus status={child.status} inWindow={inWindow.has(child.key)} />
                </button>
              ))}
            </div>
            {related.children.length === 0 && (
              <div className="field-note">No children.</div>
            )}
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
                    // "onedrive" is a mode of this form, not a link type. It
                    // stores `url`, because `LinkSchema.type` is a zod enum and
                    // an older build reading a value it does not know fails to
                    // parse the whole item — it would vanish from every view
                    // rather than degrade. See SCHEMA.md.
                    type: linkDraft.type === "onedrive" ? "url" : linkDraft.type,
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
                {["url", "onedrive", "item", "file", "folder", "outlook", "note"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <input
                placeholder={
                  linkDraft.type === "item"
                    ? "ACME-42"
                    : linkDraft.type === "onedrive"
                      ? "paste the OneDrive share link"
                      : "target"
                }
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
              {oneDriveWarning && <div className="field-note">{oneDriveWarning}</div>}
            </form>
          )}

          {item.links.map((link, index) => (
            <div className="link-row" key={`${link.type}-${link.target}-${index}`}>
              <span className="link-type">{linkTypeLabel(link)}</span>
              <span className="link-target">
                {link.type === "item" ? (
                  <button className="link-btn" onClick={() => onSelect(link.target)}>
                    {link.label ?? link.target}
                  </button>
                ) : link.type === "url" ? (
                  <a className="link-btn" href={link.target} target="_blank" rel="noreferrer">
                    {link.label ?? link.target}
                  </a>
                ) : link.type === "file" || link.type === "folder" ? (
                  <>
                    <button
                      className="link-btn"
                      onClick={() => openTarget(link.type as "file" | "folder", link.target)}
                    >
                      {link.label ?? link.target}
                    </button>
                    {link.label && <div className="mono-path">{link.target}</div>}
                  </>
                ) : (
                  <>
                    {link.label && <div>{link.label}</div>}
                    <div className="mono-path">{link.target}</div>
                  </>
                )}
              </span>
              {/*
                Only `item` links have a status to carry — a url or a folder is
                not work in progress. The lookup can miss in two different ways
                and RelatedStatus tells them apart.
              */}
              {link.type === "item" && (
                <RelatedStatus
                  status={related.linked[link.target]}
                  inWindow={inWindow.has(link.target)}
                />
              )}
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

          {dropNote && (
            <div className="field-note drop-note">
              {dropNote}
              <button className="add-btn" onClick={() => setDropNote(null)}>
                dismiss
              </button>
            </div>
          )}

          {item.attachments.map((attachment) => (
            <div className="link-row" key={attachment.path}>
              <span className="link-type">file</span>
              <span className="link-target">
                <button
                  className="link-btn"
                  onClick={() => openTarget("attachment", attachment.path)}
                >
                  {attachment.title ?? attachment.path.split("/").pop()}
                </button>
                <button
                  className="mono-path"
                  title="Show in folder"
                  onClick={() => reveal("attachment", attachment.path)}
                >
                  {attachment.path}
                  {attachment.bytes !== undefined && ` · ${formatBytes(attachment.bytes)}`}
                </button>
              </span>
            </div>
          ))}
          {item.attachments.length === 0 && (
            <div className="field-note">
              None. Drop files anywhere on this panel to copy them in — folders and
              OneDrive documents are linked where they are instead.
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
                  <RelatedStatus status={source.status} inWindow={inWindow.has(source.key)} />
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
              <div className="comment-body prose">
                <Markdown source={entry.body} onOpenLink={(href) => openTarget("external", href)} />
              </div>
            </div>
          ))}

          <form
            className="comment-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!comment.trim()) return;
              void mutate(() => window.vault.addComment(item.key, comment)).then((err) => {
                if (!err) {
                  setComment("");
                  setCommentGeneration((n) => n + 1);
                }
              });
            }}
          >
            <RichEditor key={commentGeneration} value={comment} onChange={setComment} />
            <button className="btn" type="submit" disabled={!comment.trim()}>
              Comment
            </button>
          </form>
        </div>

        {/*
          Last, after Comments, and deliberately so. It is the only section on
          this panel you cannot edit and the only one whose height has no bound,
          so a read-only log sitting between two write surfaces would break the
          rhythm of the whole panel.
        */}
        <div className="detail-section">
          <h3>
            History
            {/*
              In the heading, the way Links and Attachments carry theirs, and
              labelled with the action rather than the state — the same shape as
              the `+ add` / `cancel` toggle above.

              It has to stay visible while the log is open. The first cut put a
              "Show history" button inside the hidden branch only, which made it
              a one-way door: opening it once turned the section on for every
              item with nothing on screen to turn it off again.
            */}
            <button className="add-btn" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "hide" : "show"}
            </button>
          </h3>
          {/*
            Lazy, and only fetched while open. The panel already fires
            getRelated on open and `git log` is the most expensive call in the
            app, so opening a detail panel has to stay instant.
          */}
          {!showHistory ? null : history === null ? (
            <div className="field-note">Reading the git log…</div>
          ) : history.length === 0 ? (
            <div className="field-note">
              Nothing recorded for this item. Either this vault is not a git repository, or
              nothing has been committed yet.
            </div>
          ) : (
            <>
              <HistoryList entries={history} liveKeys={inWindow} showDays={false} />
              {/*
                --follow is a heuristic: a project rename rewrites the key inside
                the file as well as the filename, which scores as low as 57%
                similarity, so git can lose the thread exactly where it matters.
              */}
              <div className="field-note">
                History from before a key change may be listed under the old key.
              </div>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

/**
 * A related item's status, in the colour every other view says it in.
 *
 * One component for all three sections, so Children, Links and "Linked from"
 * cannot end up disagreeing about what a missing or an out-of-window target
 * looks like.
 *
 * Three states, and they are three because collapsing any two of them lies.
 * `undefined` is the map not having answered yet: `getRelated` is a round trip
 * and this panel renders before it lands, so reading "no status" as "deleted"
 * would flash `missing` on every open. `null` is the answer arriving and the
 * target being gone — `addLink` validates the target exists and `doctor` checks
 * for dangling item links anyway, because deleting the other end still happens,
 * and a link that has lost its item should say so rather than leave a
 * pill-shaped hole. Anything else is a status.
 *
 * `inWindow` is the other question, and it has a different source on purpose:
 * the status comes from main, which holds the whole vault, while this comes
 * from the `items` prop, which is what this window admits exists. Without the
 * note a real status would imply a row you can click through to, and clicking
 * one whose project is hidden closes the panel instead. Same split the parent
 * field makes with `offProject`, for the same reason — name the key you could
 * not place rather than go blank.
 */
function RelatedStatus({
  status,
  inWindow,
}: {
  status: Status | null | undefined;
  inWindow: boolean;
}): React.JSX.Element | null {
  if (status === undefined) return null;
  if (status === null) return <span className="field-note">missing</span>;
  return (
    <>
      <StatusPill status={status} />
      {!inWindow && <span className="field-note">not shown here</span>}
    </>
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

/**
 * The button (or menu, when there is a real choice) that opens the create
 * form already pointed at this item as parent.
 *
 * A native `<select>`, the same pattern ParentField uses just above: it
 * renders its list above the page and inherits keyboard handling, dismissal
 * and scroll behaviour for free, which a popover positioned inside this
 * panel's own scroll would have to reimplement.
 */
function NewChildControl({
  types,
  onPick,
}: {
  types: readonly ItemType[];
  onPick: (type: ItemType) => void;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
    try {
      // Same bargain ParentField and EditableDate make: the click that opened
      // this is the user activation showPicker needs, and if it has lapsed the
      // select is still a focused select — the list is one more click away.
      ref.current?.showPicker();
    } catch {
      /* the keyboard and a second click both still work */
    }
  }, [open]);

  if (types.length === 0) return null;

  // One legal type is not a choice, and a menu of one is a wasted click. The
  // button names the type instead — the same instinct as ParentField rendering
  // "epics sit at the top" rather than an empty menu.
  if (types.length === 1) {
    return (
      <button className="add-btn" onClick={() => onPick(types[0])}>
        + new {types[0]}
      </button>
    );
  }

  if (!open) {
    return (
      <button className="add-btn" onClick={() => setOpen(true)}>
        + new ▾
      </button>
    );
  }

  return (
    <select
      ref={ref}
      className="inline-select"
      // Always empty: this picks an action, not a value, and it unmounts the
      // moment one is picked — so there is no state to reset. The placeholder
      // is what the closed select would otherwise have nothing to display.
      value=""
      onChange={(e) => {
        setOpen(false);
        onPick(e.target.value as ItemType);
      }}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        // Closes this before App's handler sees the key, which is what stops
        // the same Escape from closing the whole panel. ParentField:908.
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
        }
      }}
    >
      <option value="" disabled>
        new child…
      </option>
      {types.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
}

/**
 * What to call a link in its type chip.
 *
 * OneDrive and SharePoint links are stored as `url` — deliberately, so an
 * older build can still parse the item — which leaves the row calling a
 * OneDrive document "url". Deriving the label from the target is the whole
 * benefit a separate link type would have bought, without the enum value that
 * makes the item unreadable elsewhere.
 */
function linkTypeLabel(link: { type: string; target: string }): string {
  if (link.type !== "url") return link.type;
  const kind = classifyLinkTarget(link.target);
  return kind === "onedrive" || kind === "sharepoint" ? kind : link.type;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
