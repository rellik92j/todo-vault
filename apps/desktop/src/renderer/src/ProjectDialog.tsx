import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary, VaultApi } from "@shared/api";

/** The IPC contract's own shape, so this form cannot drift from what main accepts. */
type NewProject = Parameters<VaultApi["createProject"]>[0];

/**
 * New project form.
 *
 * Validation stays in the vault — `ProjectSchema` rejects a malformed key with a
 * sentence already written for a human, and that sentence is what the error box
 * shows. Two things are handled here instead, both of which the renderer already
 * knows the answer to: the key is uppercased as it is typed, since making
 * someone hold shift to satisfy a regex is friction rather than validation; and
 * a key that is already in the sidebar blocks submission, because the list
 * proving it is right there and a round trip to be told so is a wasted one.
 */
export function ProjectDialog({
  projects,
  onClose,
  onCreate,
}: {
  projects: ProjectSummary[];
  onClose: () => void;
  /** Resolves to an error message, or null once the project exists. */
  onCreate: (input: NewProject) => Promise<string | null>;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  /** Once the key has been typed into, the name stops driving it. */
  const [keyEdited, setKeyEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [lead, setLead] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => nameRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const suggested = useMemo(() => keyFrom(name), [name]);
  const finalKey = keyEdited ? key : suggested;
  const taken = finalKey !== "" && projects.some((p) => p.key === finalKey);
  const ready = Boolean(name.trim()) && finalKey !== "" && !taken;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError(null);

    const message = await onCreate({
      key: finalKey,
      name: name.trim(),
      // Empty optional fields are omitted from the file entirely rather than
      // written as an empty string — see SCHEMA.md.
      description: description.trim() || undefined,
      category: category.trim() || undefined,
      lead: lead.trim() || undefined,
    });

    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <header className="modal-head">
          <h2>New project</h2>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="modal-row">
            <label style={{ flex: 2 }}>
              <span>Name</span>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme rollout"
                required
              />
            </label>

            <label>
              <span>Key</span>
              <input
                value={finalKey}
                maxLength={10}
                // Clearing the field hands the key back to the name, so a typo
                // does not strand you with a box you now have to fill yourself.
                onChange={(e) => {
                  const next = e.target.value.toUpperCase();
                  setKeyEdited(next.length > 0);
                  setKey(next);
                }}
                placeholder="ACME"
                style={{ fontFamily: "var(--mono)" }}
                required
              />
            </label>
          </div>

          <p className="field-note">
            {taken ? (
              <strong>{finalKey} already exists — pick another key.</strong>
            ) : (
              <>
                2–10 uppercase letters or digits, starting with a letter. Every item in the
                project is keyed from it — <code>{finalKey || "ACME"}-1</code> — and changing it
                later re-keys them all, so it is CLI-only on purpose.
              </>
            )}
          </p>

          <div className="modal-row">
            <label>
              <span>Category</span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="optional"
              />
            </label>

            <label>
              <span>Lead</span>
              <input
                value={lead}
                onChange={(e) => setLead(e.target.value)}
                placeholder="optional"
              />
            </label>
          </div>

          <label>
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="Markdown. This becomes the body of the file."
            />
          </label>

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving || !ready}>
            {saving ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * A starting key from the name: its first word, which is exactly what ACME and
 * OPS are to "Acme rollout" and "Ops". Anything under two characters is no
 * suggestion at all — the schema would reject it — so the field stays empty and
 * asks rather than proposing something that cannot be saved.
 */
function keyFrom(name: string): string {
  const word = name.toUpperCase().match(/[A-Z][A-Z0-9]*/)?.[0] ?? "";
  return word.length >= 2 ? word.slice(0, 10) : "";
}
