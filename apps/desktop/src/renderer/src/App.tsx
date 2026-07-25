import { useCallback, useEffect, useMemo, useState } from "react";
import type { Item, Status } from "todo-vault";
import type { AgendaScope, ProjectSummary } from "@shared/api";

import { useVault } from "./useVault";
import { BacklogTable } from "./BacklogTable";
import { Board } from "./Board";
import { Agenda } from "./Agenda";
import { ItemDetail } from "./ItemDetail";
import { Welcome } from "./Welcome";
import { CreateDialog } from "./CreateDialog";
import { TrashPanel } from "./TrashPanel";
import { BOARD_ORDER, STATUS_LABELS } from "./pieces";

type View = "backlog" | "board" | "agenda";

export function App(): React.JSX.Element {
  const vault = useVault();
  const [view, setView] = useState<View>("backlog");
  const [project, setProject] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | "all">("all");
  const [cadence, setCadence] = useState<string>("all");
  const [openOnly, setOpenOnly] = useState(true);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<AgendaScope>("week");
  const [creating, setCreating] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [dragProject, setDragProject] = useState<string | null>(null);

  const snapshot = vault.snapshot;

  // Select whatever was just created, so the detail panel opens on it.
  useEffect(() => {
    if (vault.lastCreated) setSelected(vault.lastCreated);
  }, [vault.lastCreated]);

  // A selection that no longer exists — deleted, or re-keyed by a project
  // rename — must not leave a stale panel open.
  useEffect(() => {
    if (selected && snapshot && !snapshot.items.some((i) => i.key === selected)) {
      setSelected(null);
    }
  }, [snapshot, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const typing =
        event.target instanceof HTMLElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName);

      if (event.key === "Escape") {
        if (creating || showTrash) return; // those close themselves
        setSelected(null);
      }
      if (!typing && event.key === "n" && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        setCreating(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, showTrash]);

  const filtered = useMemo<Item[]>(() => {
    if (!snapshot) return [];
    const needle = text.trim().toLowerCase();
    return snapshot.items.filter((item) => {
      if (project && item.project !== project) return false;
      if (status !== "all" && item.status !== status) return false;
      if (cadence !== "all" && item.cadence !== cadence) return false;
      if (openOnly && item.status === "done") return false;
      if (needle) {
        const haystack = `${item.key} ${item.summary} ${item.description} ${item.category ?? ""} ${item.labels.join(" ")}`;
        if (!haystack.toLowerCase().includes(needle)) return false;
      }
      return true;
    });
  }, [snapshot, project, status, cadence, openOnly, text]);

  const selectedItem = snapshot?.items.find((i) => i.key === selected) ?? null;

  /**
   * Delete, turning the core's refusal into a question.
   *
   * `deleteItem` fails when the item has children and the message lists them.
   * That is a decision for the user, not an error, so it becomes a confirm and a
   * retry with cascade.
   */
  const handleDelete = useCallback(
    async (item: Item) => {
      const first = await vault.deleteItem(item.key, false);
      if (!first.error) return;

      if (/beneath it/.test(first.error)) {
        if (window.confirm(`${first.error}\n\nTrash all of them together?`)) {
          await vault.deleteItem(item.key, true);
        }
        return;
      }
      window.alert(first.error);
    },
    [vault],
  );

  const onProjectDrop = (target: ProjectSummary): void => {
    if (!dragProject || dragProject === target.key) return;
    const order = snapshot?.projects.map((p) => p.key) ?? [];
    const from = order.indexOf(dragProject);
    const to = order.indexOf(target.key);
    setDragProject(null);
    if (from === -1 || to === -1) return;
    void vault.mutate(() =>
      window.vault.moveProject(
        dragProject,
        from < to ? { after: target.key } : { before: target.key },
      ),
    );
  };

  if (!snapshot) {
    return (
      <Welcome
        loading={vault.loading}
        error={vault.error}
        onChoose={vault.chooseVault}
        onOpen={vault.openVault}
      />
    );
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-head">
          <span className="sidebar-title">Projects</span>
          <span className="project-count">{snapshot.items.length} items</span>
        </div>

        <div className="sidebar-scroll">
          <button
            className="project"
            aria-current={project === null}
            onClick={() => setProject(null)}
          >
            <span className="project-name">All projects</span>
            <span className="project-count">
              {snapshot.items.filter((i) => i.status !== "done").length}
            </span>
          </button>

          {/* Drag to reorder. listProjects already returns manual order. */}
          {snapshot.projects.map((p) => (
            <button
              className={`project ${dragProject === p.key ? "project-dragging" : ""}`}
              key={p.key}
              aria-current={project === p.key}
              onClick={() => setProject(p.key)}
              draggable
              onDragStart={() => setDragProject(p.key)}
              onDragEnd={() => setDragProject(null)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onProjectDrop(p)}
              title={`${p.name} — ${p.totalItems} items, ${p.openItems} open${p.rank !== undefined ? `, rank ${p.rank}` : ""}\nDrag to reorder`}
            >
              <span className="project-key">{p.key}</span>
              <span className="project-name">{p.name}</span>
              <span className="project-count">{p.openItems}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot">
          <div className="status-line" title={snapshot.root}>
            <span className="mono-path">{shortenPath(snapshot.root)}</span>
          </div>
          <div className="status-line">
            <span
              className="dot"
              style={{ background: snapshot.git.healthy ? "var(--done)" : "var(--high)" }}
            />
            <span title={gitTitle(snapshot.git)}>
              {snapshot.git.healthy ? "history on" : "history off"}
            </span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <button className="btn" onClick={() => void window.vault.revealPath({ kind: "vault" })}>
              Folder
            </button>
            <button className="btn" onClick={() => setShowTrash(true)}>
              Trash{snapshot.trashCount > 0 ? ` (${snapshot.trashCount})` : ""}
            </button>
            <button className="btn" onClick={vault.chooseVault}>
              Switch
            </button>
          </div>
        </div>
      </nav>

      <main className="main">
        <div className="toolbar">
          <div className="tabs" role="tablist">
            {(["backlog", "board", "agenda"] as const).map((candidate) => (
              <button
                key={candidate}
                role="tab"
                className="tab"
                aria-selected={view === candidate}
                onClick={() => setView(candidate)}
              >
                {candidate[0].toUpperCase() + candidate.slice(1)}
              </button>
            ))}
          </div>

          {view === "agenda" ? (
            <select value={scope} onChange={(e) => setScope(e.target.value as AgendaScope)}>
              <option value="today">Today</option>
              <option value="week">This week</option>
              <option value="month">This month</option>
            </select>
          ) : (
            <>
              <select value={status} onChange={(e) => setStatus(e.target.value as Status | "all")}>
                <option value="all">Any status</option>
                {BOARD_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
                <option value="all">Any cadence</option>
                <option value="none">One-off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
              <label className="status-line" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={openOnly}
                  onChange={(e) => setOpenOnly(e.target.checked)}
                />
                Hide done
              </label>
            </>
          )}

          <div className="spacer" />

          <input
            type="search"
            placeholder="Filter by text…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="btn btn-primary"
            onClick={() => setCreating(true)}
            title="New item (n)"
          >
            + New
          </button>
        </div>

        {vault.error && (
          <div className="banner banner-warn">
            <span style={{ flex: 1 }}>{vault.error}</span>
            <button className="banner-close" onClick={vault.dismissError} aria-label="Dismiss">
              ✕
            </button>
          </div>
        )}

        {/* Without this, a file with broken YAML just vanishes from every view. */}
        {snapshot.errors.length > 0 && (
          <div className="banner banner-warn">
            <span style={{ flex: 1 }}>
              <strong>
                {snapshot.errors.length} file{snapshot.errors.length === 1 ? "" : "s"} failed to
                parse
              </strong>{" "}
              and {snapshot.errors.length === 1 ? "is" : "are"} not shown anywhere:{" "}
              {snapshot.errors.map((e, i) => (
                <span key={i}>
                  {i > 0 && "; "}
                  <code>{e}</code>
                </span>
              ))}
            </span>
          </div>
        )}

        {!snapshot.git.healthy && (
          <div className="banner banner-info">
            <span style={{ flex: 1 }}>
              Writes are not being committed, so there is no undo history.{" "}
              {snapshot.git.ignored
                ? "The repository this vault sits in ignores it."
                : snapshot.git.isRepo
                  ? snapshot.git.lastError
                  : "The vault folder is not a git repository."}{" "}
              Deletes still go to <code>.trash</code> and stay recoverable.
            </span>
          </div>
        )}

        <div className="content">
          {view === "backlog" && (
            <BacklogTable items={filtered} selected={selected} onSelect={setSelected} />
          )}
          {view === "board" && (
            <Board
              items={filtered}
              projectOrder={snapshot.projects.map((p) => p.key)}
              selected={selected}
              onSelect={setSelected}
              onTransition={(key, next) =>
                void vault.mutate(() => window.vault.transitionItem(key, next))
              }
              onReorder={(key, position) =>
                void vault.mutate(() => window.vault.moveItem(key, position))
              }
            />
          )}
          {view === "agenda" && (
            <Agenda
              scope={scope}
              items={snapshot.items}
              selected={selected}
              onSelect={setSelected}
            />
          )}
        </div>
      </main>

      {selectedItem && (
        <ItemDetail
          item={selectedItem}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
          onDelete={handleDelete}
          mutate={vault.mutate}
        />
      )}

      {creating && (
        <CreateDialog
          projects={snapshot.projects}
          items={snapshot.items}
          defaultProject={project}
          onClose={() => setCreating(false)}
          onCreate={vault.createItem}
        />
      )}

      {showTrash && (
        <TrashPanel
          onClose={() => setShowTrash(false)}
          onRestore={(file) => vault.restore([file])}
        />
      )}

      {vault.undo && (
        <div className="toast">
          <span style={{ flex: 1 }}>{vault.undo.message}</span>
          <button
            className="btn"
            onClick={() => void vault.restore(vault.undo?.files ?? [])}
            disabled={vault.busy}
          >
            Undo
          </button>
          <button className="banner-close" onClick={vault.dismissUndo} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

function shortenPath(full: string): string {
  const parts = full.split(/[\\/]/);
  return parts.length <= 3 ? full : `…${parts.slice(-2).join("/")}`;
}

function gitTitle(git: { healthy: boolean; repoRoot?: string; lastError?: string }): string {
  if (git.healthy) return `Every write is committed to ${git.repoRoot}`;
  return git.lastError ?? "Auto-commit is not active for this vault";
}
