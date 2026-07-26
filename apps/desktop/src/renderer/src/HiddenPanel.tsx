import type { ProjectSummary } from "@shared/api";

/**
 * What has been hidden, and the way back.
 *
 * The counterpart to TrashPanel, and for the same reason: hiding is only safe
 * to offer if there is somewhere that lists what is hidden. A project that
 * vanished from the sidebar with no inventory anywhere is indistinguishable
 * from one that was deleted.
 *
 * Unlike TrashPanel this needs no IPC read of its own — hidden projects are
 * already in the snapshot, because listProjects() is deliberately unfiltered
 * and the sidebar does the dropping.
 */
export function HiddenPanel({
  projects,
  onClose,
  onUnhide,
  busy,
}: {
  projects: ProjectSummary[];
  onClose: () => void;
  onUnhide: (key: string) => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Hidden projects</h2>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {projects.length === 0 && (
            <div className="field-note">
              Nothing hidden. Hiding a project drops it from the sidebar and takes its items out
              of every view here — it deletes nothing, and the CLI and MCP server still list it.
            </div>
          )}

          {projects.length > 0 && (
            <div className="rows">
              {projects.map((p) => (
                <div className="row" key={p.key}>
                  <span className="cell-key">{p.key}</span>
                  <span className="row-summary">{p.name}</span>
                  <span className="section-range">
                    {p.totalItems} item{p.totalItems === 1 ? "" : "s"}
                  </span>
                  {/*
                    A project can only be hidden with nothing open in it, so this
                    should never show. It does when something outside the app —
                    an external Claude, or an edit in a text editor — reopened an
                    item afterwards. That is the one state where "hidden" is
                    lying to you, so the row says so rather than looking normal.
                  */}
                  {p.openItems > 0 && (
                    <span className="pill" title="Reopened from outside the app since it was hidden">
                      {p.openItems} open again
                    </span>
                  )}
                  <button className="btn" disabled={busy} onClick={() => onUnhide(p.key)}>
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="field-note" style={{ marginTop: 14 }}>
            Unhiding always brings a project back as <code>active</code>. If it was{" "}
            <code>on_hold</code> or <code>complete</code> before it was hidden, that value is not
            recoverable — hiding is stored in the same field.
          </p>
        </div>
      </div>
    </div>
  );
}
