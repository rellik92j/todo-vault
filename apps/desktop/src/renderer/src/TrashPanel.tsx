import { useEffect, useState } from "react";
import type { TrashEntry } from "todo-vault";

/**
 * What is recoverable.
 *
 * Worth a screen of its own because the whole point of trashing rather than
 * unlinking is that recovery does not depend on git being set up — and that is
 * only true if there is somewhere to see what is in there.
 */
export function TrashPanel({
  onClose,
  onRestore,
}: {
  onClose: () => void;
  onRestore: (file: string) => Promise<void>;
}): React.JSX.Element {
  const [entries, setEntries] = useState<TrashEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (): void => {
    void window.vault.listTrash().then((result) => {
      if (result.ok) {
        setEntries(result.value);
        setError(null);
      } else {
        setError(result.message);
      }
    });
  };

  useEffect(load, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Trash</h2>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          {error && <div className="modal-error">{error}</div>}
          {!entries && <div className="field-note">Reading .trash…</div>}

          {entries && entries.length === 0 && (
            <div className="field-note">
              Nothing in the trash. Deleted items land here rather than being unlinked, so they
              can be brought back without relying on git.
            </div>
          )}

          {entries && entries.length > 0 && (
            <div className="rows">
              {entries.map((entry) => (
                <div className="row" key={entry.file}>
                  <span className="cell-key">{entry.key}</span>
                  <span className="row-summary">{entry.summary ?? "(unreadable)"}</span>
                  {entry.hasAttachments && <span className="pill">+ files</span>}
                  <span className="section-range">{entry.trashedAt.slice(0, 10)}</span>
                  <button
                    className="btn"
                    onClick={() =>
                      void onRestore(entry.file).then(load)
                    }
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}

          <p className="field-note" style={{ marginTop: 14 }}>
            An item whose parent is also in the trash needs the parent restored first, and a key
            that has since been reissued will refuse rather than overwrite.
          </p>
        </div>
      </div>
    </div>
  );
}
