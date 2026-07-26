import { useEffect, useMemo, useRef, useState } from "react";
import type { Item } from "todo-vault";
import type { ProjectSummary } from "@shared/api";
import { StatusPill } from "./pieces";

/**
 * Ctrl-K: search the whole vault.
 *
 * Deliberately unfiltered. The toolbar's box narrows whatever the current view
 * is showing, which is the right tool when you are working inside a project and
 * the wrong one when you half-remember an item and do not know where it lives.
 * This one ignores every filter, which is the only reason to have both.
 *
 * Matching is plain case-insensitive substring, not fuzzy. Over a few hundred
 * items a substring pass is instant, and it is predictable — a fuzzy ranker that
 * surprises you is worse than one that occasionally makes you type another word.
 * Multiple words are ANDed, so a second word always narrows.
 */
export function CommandPalette({
  items,
  projects,
  onClose,
  onSelectItem,
  onSelectProject,
}: {
  /** The whole snapshot — deliberately unfiltered. */
  items: Item[];
  projects: ProjectSummary[];
  onClose: () => void;
  /** Opens the item detail panel. The palette closes itself after calling this. */
  onSelectItem: (key: string) => void;
  /** Sets the sidebar project filter. Null means "all projects". */
  onSelectProject: (key: string | null) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const terms = useMemo(
    () => query.toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );

  const projectRows = useMemo(
    () =>
      projects.filter((p) => {
        const haystack = `${p.key} ${p.name}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      }),
    [projects, terms],
  );

  const { itemRows, total } = useMemo(() => {
    // No query: the most recently touched work, so the palette is a jumper as
    // well as a searcher. `updated` is an ISO string, so it sorts as text.
    if (!terms.length) {
      const recent = [...items]
        .sort((a, b) => b.updated.localeCompare(a.updated))
        .slice(0, 8)
        .map((item) => ({ item, snippet: null as string | null }));
      return { itemRows: recent, total: recent.length };
    }

    const hits = items
      .map((item) => ({ item, hit: score(item, terms) }))
      .filter((row): row is { item: Item; hit: Hit } => row.hit !== null)
      .sort(
        (a, b) =>
          a.hit.rank - b.hit.rank ||
          Number(a.item.status === "done") - Number(b.item.status === "done") ||
          a.hit.at - b.hit.at ||
          b.item.updated.localeCompare(a.item.updated),
      );

    return {
      itemRows: hits.slice(0, LIMIT).map(({ item, hit }) => ({
        item,
        // A snippet only earns its place when the match is somewhere you cannot
        // already see it. If the summary matched, the summary is the evidence.
        snippet: hit.rank >= DESCRIPTION_RANK ? snippet(item.description, terms[0]) : null,
      })),
      total: hits.length,
    };
  }, [items, terms]);

  type Row =
    | { kind: "project"; id: string; project: ProjectSummary }
    | { kind: "item"; id: string; item: Item; snippet: string | null };

  const rows = useMemo<Row[]>(
    () => [
      ...projectRows.map((project) => ({
        kind: "project" as const,
        id: `p:${project.key}`,
        project,
      })),
      ...itemRows.map(({ item, snippet: text }) => ({
        kind: "item" as const,
        id: `i:${item.key}`,
        item,
        snippet: text,
      })),
    ],
    [projectRows, itemRows],
  );

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor, rows]);

  const activate = (row: Row): void => {
    if (row.kind === "project") onSelectProject(row.project.key);
    else onSelectItem(row.item.key);
    onClose();
  };

  /**
   * Handled on the input rather than on window: the input holds focus the whole
   * time the palette is up, and App's own window handler already stands down
   * while a text field has focus, so there is exactly one listener per key.
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    const step = (delta: number): void => {
      event.preventDefault();
      if (rows.length) setCursor((at) => (at + delta + rows.length) % rows.length);
    };

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      step(1);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[cursor];
      if (row) activate(row);
    }
  };

  const firstItemAt = projectRows.length;

  return (
    <div className="palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          type="text"
          placeholder="Search every item and project…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && (
            <div className="palette-empty">Nothing matches “{query}”.</div>
          )}

          {projectRows.length > 0 && <div className="palette-group">Projects</div>}

          {rows.map((row, index) => {
            const active = index === cursor;

            // The heading sits between the two blocks, so it renders with the
            // first item row rather than as a separate pass over the list.
            const heading =
              row.kind === "item" && index === firstItemAt ? (
                <div className="palette-group" key="items-heading">
                  {terms.length ? "Items" : "Recent"}
                  {total > rows.length - firstItemAt && (
                    <span className="palette-count">
                      showing {rows.length - firstItemAt} of {total}
                    </span>
                  )}
                </div>
              ) : null;

            return (
              <div key={row.id}>
                {heading}
                <button
                  type="button"
                  className="palette-row"
                  aria-selected={active}
                  onMouseMove={() => setCursor(index)}
                  onClick={() => activate(row)}
                >
                  {row.kind === "project" ? (
                    <>
                      <span className="cell-key">{row.project.key}</span>
                      <span className="palette-summary">
                        <span className="palette-title">
                          <Highlight text={row.project.name} terms={terms} />
                        </span>
                      </span>
                      <span className="palette-meta">{row.project.openItems} open</span>
                    </>
                  ) : (
                    <>
                      <span className="cell-key">
                        <Highlight text={row.item.key} terms={terms} />
                      </span>
                      <span className="palette-summary">
                        {/*
                          The title needs its own element: .palette-summary is a
                          column, and Highlight returns a fragment, so its text
                          nodes and <mark>s would each become a flex item and
                          stack one per line.
                        */}
                        <span className="palette-title">
                          <Highlight text={row.item.summary} terms={terms} />
                        </span>
                        {row.snippet && (
                          <span className="palette-snippet">
                            <Highlight text={row.snippet} terms={terms} />
                          </span>
                        )}
                      </span>
                      <span className="palette-meta">{row.item.project}</span>
                      <StatusPill status={row.item.status} />
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>
            <kbd className="pill">↑</kbd> <kbd className="pill">↓</kbd> to move
          </span>
          <span>
            <kbd className="pill">Enter</kbd> to open
          </span>
          <span>
            <kbd className="pill">Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

const LIMIT = 50;
/** Ranks at or above this one matched only in the description. */
const DESCRIPTION_RANK = 4;

interface Hit {
  /** Lower is better; see score(). */
  rank: number;
  /** Where the first term landed, so an earlier match wins a tie. */
  at: number;
}

/**
 * Where an item matched, which is what orders the results.
 *
 * Every term has to appear somewhere, so a second word always narrows. The rank
 * then comes from where the *first* term landed, on the assumption that people
 * lead with the most identifying word — a key, or the first word of the title.
 */
function score(item: Item, terms: string[]): Hit | null {
  const key = item.key.toLowerCase();
  const summary = item.summary.toLowerCase();
  const description = item.description.toLowerCase();
  const extras = `${item.category ?? ""} ${item.labels.join(" ")} ${item.project}`.toLowerCase();

  const haystack = `${key} ${summary} ${extras} ${description}`;
  if (!terms.every((term) => haystack.includes(term))) return null;

  const first = terms[0];
  if (key === first) return { rank: 0, at: 0 };
  if (key.startsWith(first)) return { rank: 1, at: 0 };

  const inSummary = summary.indexOf(first);
  if (inSummary !== -1) return { rank: 2, at: inSummary };

  const inExtras = extras.indexOf(first);
  if (inExtras !== -1) return { rank: 3, at: inExtras };

  const inDescription = description.indexOf(first);
  if (inDescription !== -1) return { rank: DESCRIPTION_RANK, at: inDescription };

  // Matched the joined haystack but no single field: the term straddles a field
  // boundary. Real, if rare, and worth showing last rather than dropping.
  return { rank: 5, at: 0 };
}

/** A window of description around the match, so the row shows why it matched. */
function snippet(description: string, term: string): string | null {
  const at = description.toLowerCase().indexOf(term);
  if (at === -1) return null;
  const start = Math.max(0, at - 30);
  const end = Math.min(description.length, at + term.length + 60);
  const body = description.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < description.length ? "…" : ""}`;
}

function Highlight({ text, terms }: { text: string; terms: string[] }): React.JSX.Element {
  if (!terms.length) return <>{text}</>;

  // Longest first, so "review" wins over "re" and the marks do not nest.
  const pattern = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return (
    <>
      {parts.map((part, index) =>
        terms.includes(part.toLowerCase()) ? <mark key={index}>{part}</mark> : part,
      )}
    </>
  );
}
