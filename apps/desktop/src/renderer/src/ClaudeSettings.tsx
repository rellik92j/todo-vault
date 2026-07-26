import { useEffect, useState } from "react";
import type { ClaudeStatus } from "@shared/api";

/**
 * The API key's only entry point, and deliberately not its exit.
 *
 * The key is typed here, sent to main once, and encrypted at rest with
 * Electron's safeStorage. There is no getter on the IPC surface, so this panel
 * cannot read a stored key back even to mask it — it can only report that one
 * exists. That is the point: nothing in the renderer, and nothing in the
 * renderer bundle, ever holds the key.
 */
export function ClaudeSettings({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [entering, setEntering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void window.vault.claudeStatus().then((result) => {
      if (!live) return;
      if (result.ok) setStatus(result.value);
      else setError(result.message);
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Both mutations answer with a fresh status, so nothing has to re-fetch. */
  const run = async (call: () => Promise<{ ok: true; value: ClaudeStatus } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    const result = await call();
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setStatus(result.value);
    setDraftKey("");
    setEntering(false);
  };

  const showInput = status?.storageAvailable && (!status.hasKey || entering);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Claude drafting</h2>
          <div className="spacer" />
          <button className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <p className="field-note">
            An optional layer. With a key, the new-item dialog can turn a sentence into a
            filled-in draft that you review before anything is written. Without one,
            everything else works exactly as it does now.
          </p>

          {!status && !error && <p className="field-note">Checking…</p>}

          {status && (
            <>
              <div className="claude-state">
                <span
                  className="dot"
                  style={{
                    background: status.hasKey ? "var(--done)" : "var(--todo)",
                  }}
                />
                {!status.storageAvailable
                  ? "Unavailable on this machine"
                  : status.hasKey
                    ? "A key is stored"
                    : "No key stored — drafting is off"}
                <span className="spacer" />
                <span className="pill" title="The model this calls">
                  {status.model}
                </span>
              </div>

              {/*
                No key input in this state. Main refuses to write the key
                unencrypted rather than falling back to plaintext, so offering
                the field would only lead to a rejection the user cannot fix.
              */}
              {!status.storageAvailable && (
                <div className="banner banner-warn">
                  <span style={{ flex: 1 }}>
                    {status.reason ??
                      "Encrypted storage is not available, so there is nowhere safe to keep a key."}
                  </span>
                </div>
              )}

              {showInput && (
                <label>
                  <span>Anthropic API key</span>
                  <input
                    type="password"
                    value={draftKey}
                    autoFocus
                    placeholder="sk-ant-…"
                    onChange={(e) => setDraftKey(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && draftKey.trim()) {
                        e.preventDefault();
                        void run(() => window.vault.setClaudeKey(draftKey.trim()));
                      }
                    }}
                  />
                </label>
              )}

              {status.storageAvailable && (
                <p className="field-note">
                  Stored encrypted by the operating system, in the app&rsquo;s own data folder —
                  never in the vault, and never sent anywhere except Anthropic.
                </p>
              )}
            </>
          )}

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          {status?.hasKey && !entering && (
            <>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void run(() => window.vault.clearClaudeKey())}
              >
                Remove
              </button>
              <button className="btn" disabled={busy} onClick={() => setEntering(true)}>
                Replace
              </button>
            </>
          )}
          {entering && (
            <button
              className="btn"
              disabled={busy}
              onClick={() => {
                setEntering(false);
                setDraftKey("");
              }}
            >
              Cancel
            </button>
          )}
          {showInput && (
            <button
              className="btn btn-primary"
              disabled={busy || !draftKey.trim()}
              onClick={() => void run(() => window.vault.setClaudeKey(draftKey.trim()))}
            >
              {busy ? "Saving…" : "Save key"}
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
