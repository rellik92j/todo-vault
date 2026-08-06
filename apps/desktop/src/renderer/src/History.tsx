import { useEffect, useState } from "react";
import type { FieldChange, FileChange, GitStatus, HistoryEntry } from "todo-vault";
import {
  bodySummary,
  changeLine,
  displayValue,
  entryLine,
  fallbackNote,
  fieldLabel,
  groupByDay,
  kindBadge,
  timeOfDay,
  truncate,
} from "./history-format";

/** One page. The core caps `limit` at 100 and the vault will reach thousands. */
const PAGE = 25;

/** At most this many files per commit, and fields per file, before "+N more". */
const MAX_FILES = 5;
const MAX_FIELDS = 4;

/**
 * What the empty states say when git is not recording.
 *
 * Wording lifted from the banner in App.tsx so the two can never disagree about
 * the same three conditions. None of them offers to set git up: turning history
 * on is a separate, already-designed entry, and a read-only log is the wrong
 * place to grow a write-side git action.
 */
function notRecording(git: GitStatus): string | null {
  if (!git.gitAvailable) return "Git is not installed, so nothing is being recorded.";
  if (!git.isRepo) {
    return "This vault folder is not a git repository, so no history is being kept. Deletes still go to .trash and stay recoverable.";
  }
  if (git.ignored) {
    return "The repository this vault sits in ignores it, so nothing here is being committed.";
  }
  if (!git.lastCommit) return "No commits yet.";
  return null;
}

/** Entries under one field row, capped until the file row's expander is open. */
function FieldEntries({ change, open }: { change: FieldChange; open: boolean }): React.JSX.Element | null {
  if (!change.items || change.items.length === 0) return null;
  const shown = open ? change.items : change.items.slice(0, 4);
  const hidden = change.items.length - shown.length;
  return (
    <div className="history-entries">
      {shown.map((item, i) => {
        const text = entryLine(item);
        return (
          <div className="history-entry-change" key={i} title={text}>
            {truncate(text, 80)}
          </div>
        );
      })}
      {hidden > 0 && <div className="history-more">+{hidden} more</div>}
    </div>
  );
}

function FileRow({
  file,
  live,
  onSelect,
}: {
  file: FileChange;
  live: boolean;
  onSelect?: (key: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const badge = kindBadge(file.kind);
  const note = fallbackNote(file);
  const shown = file.fields.slice(0, MAX_FIELDS);
  const hidden = file.fields.length - shown.length;
  const bodyDiff = file.body;
  const summary = bodyDiff ? bodySummary(file) : null;

  const label = (
    <>
      <span className="history-key">{file.key ?? file.path}</span>
      {badge && <span className="pill">{badge}</span>}
      {file.title && <span className="history-title">{truncate(file.title)}</span>}
    </>
  );

  return (
    <div className="history-file">
      {/*
        A button only while the key still resolves to something. RelatedStatus
        does the same thing for dangling item links: a log necessarily names
        things that have since been deleted, and a row that looks clickable and
        then does nothing is worse than one that plainly is not.
      */}
      {live && file.key && onSelect ? (
        <button type="button" className="row history-row" onClick={() => onSelect(file.key!)}>
          {label}
        </button>
      ) : (
        <span className="row history-row history-row-dead">{label}</span>
      )}

      <div className="history-fields">
        {shown.map((change) => (
          <div key={change.field}>
            <div className="history-field" title={changeLine(change)}>
              <span className="history-field-name">{fieldLabel(change.field)}</span>
              <span className="history-before">{displayValue(change.before)}</span>
              <span className="history-arrow">→</span>
              <span className="history-after">{displayValue(change.after)}</span>
            </div>
            <FieldEntries change={change} open={open} />
          </div>
        ))}
        {hidden > 0 && <div className="history-more">+{hidden} more</div>}
        {summary && (
          <button
            type="button"
            className="history-note history-expand"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="history-expand-arrow">{open ? "▾" : "▸"}</span> {summary}
          </button>
        )}
        {bodyDiff && open && (
          <div className="history-diff">
            {bodyDiff.truncated
              ? "Too large to show line-by-line."
              : bodyDiff.lines.map((line, i) => (
                  <div
                    className={`history-diff-line ${line.op === "add" ? "history-diff-add" : "history-diff-remove"}`}
                    key={i}
                  >
                    {line.op === "add" ? "+" : "−"} {line.text}
                  </div>
                ))}
          </div>
        )}
        {note && <div className="history-field history-note">{note}</div>}
      </div>
    </div>
  );
}

/**
 * The commit list itself, exported so ItemDetail draws the same rows.
 *
 * Shared for the reason shortcuts.ts gives about its own registry: two
 * renderings of one thing drift, and the whole value of this feature is that the
 * rendering is trustworthy.
 */
export function HistoryList({
  entries,
  liveKeys,
  onSelect,
  showDays = true,
}: {
  entries: HistoryEntry[];
  /** Keys that still exist, so a row knows whether it can be opened. */
  liveKeys: Set<string>;
  onSelect?: (key: string) => void;
  showDays?: boolean;
}): React.JSX.Element {
  return (
    <div className="history">
      {groupByDay(entries).map((day) => (
        <section key={day.day}>
          {showDays && (
            <header className="section-head">
              <h2 className="section-title">{day.day}</h2>
              <span className="section-range">
                {day.entries.length} commit{day.entries.length === 1 ? "" : "s"}
              </span>
            </header>
          )}
          {day.entries.map((entry) => {
            const files = entry.files.slice(0, MAX_FILES);
            const hidden = entry.files.length - files.length;
            return (
              <div className="history-entry" key={entry.hash}>
                <header className="history-head">
                  <span className="history-time">{timeOfDay(entry.at)}</span>
                  <span className="history-subject">{truncate(entry.subject, 90)}</span>
                  <span className="history-hash" title={`${entry.hash} — ${entry.author}`}>
                    {entry.shortHash}
                  </span>
                </header>
                {files.map((file) => (
                  <FileRow
                    key={`${file.path}-${file.fromPath ?? ""}`}
                    file={file}
                    live={!!file.key && liveKeys.has(file.key)}
                    onSelect={onSelect}
                  />
                ))}
                {/* `Reseed: 3 projects, 15 items` is really in this log. */}
                {hidden > 0 && <div className="history-more">+{hidden} more files</div>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

export function History({
  git,
  project,
  liveKeys,
  onSelect,
}: {
  git: GitStatus;
  /** The toolbar's project filter, or null for the whole vault. */
  project: string | null;
  liveKeys: Set<string>;
  onSelect: (key: string) => void;
}): React.JSX.Element {
  /*
    Pages accumulate rather than one growing `limit`: the core caps a request at
    100 commits and this vault will reach thousands.

    `pageCount` is explicit state rather than `pages.length`, which is the same
    number one render later. Deriving it would make the effect that fills page N
    the effect that asks for page N+1, and the view would walk the whole log on
    its own.
  */
  const [pageCount, setPageCount] = useState(1);
  const [pages, setPages] = useState<HistoryEntry[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /*
    Keyed on the last commit hash, not on the snapshot.

    Agenda keys its fetch on `items`, and copying that here would re-read the
    whole log every time the snapshot changed for a reason git had nothing to do
    with — a reload, a failed write, a watcher blip on an unrelated file.
    GitStatus rides on every snapshot already, and `lastCommit.hash` changes if
    and only if a commit landed. So this refreshes through the existing
    onChanged subscription for free, with no second channel, and never
    otherwise.
  */
  const head = git.lastCommit?.hash;

  // A new commit shifts every offset below it, so accumulated pages are void.
  useEffect(() => {
    setPageCount(1);
    setPages([]);
    setHasMore(false);
  }, [head, project]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void window.vault
      .getHistory({
        project: project ?? undefined,
        offset: (pageCount - 1) * PAGE,
        limit: PAGE,
      })
      .then((result) => {
        // The cleanup below fires whenever these deps change, so a response for
        // a filter or a page that has since been replaced is dropped rather
        // than landing in the wrong slot.
        if (!live) return;
        setLoading(false);
        if (!result.ok) {
          setError(result.message);
          return;
        }
        setError(null);
        setHasMore(result.value.hasMore);
        setPages((current) => {
          const next = current.slice(0, pageCount);
          next[pageCount - 1] = result.value.entries;
          return next;
        });
      });
    return () => {
      live = false;
    };
  }, [head, project, pageCount]);

  const stopped = notRecording(git);
  if (stopped) return <div className="empty">{stopped}</div>;
  if (error) return <div className="empty">{error}</div>;

  const entries = pages.flat();
  if (!entries.length) {
    return <div className="empty">{loading ? "Reading the git log…" : "Nothing recorded here."}</div>;
  }

  return (
    <>
      <HistoryList entries={entries} liveKeys={liveKeys} onSelect={onSelect} />
      {hasMore && (
        <div className="history-load">
          <button
            type="button"
            className="btn"
            disabled={loading}
            onClick={() => setPageCount((n) => n + 1)}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </>
  );
}
