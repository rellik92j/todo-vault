import { useEffect, useRef, useState } from "react";
import { ITEM_TYPES, PRIORITIES, type ItemType, type Priority } from "todo-vault/constants";
import type { Item } from "todo-vault";
import type { ProjectSummary } from "@shared/api";

/**
 * New item form, shaped to CreateItemInput so the vault's own validation is the
 * only validation. Parent choices are filtered to what the hierarchy allows —
 * epics take no parent, subtasks hang off a story/task/bug, everything else off
 * an epic — so an invalid combination cannot be submitted.
 */
export function CreateDialog({
  projects,
  items,
  defaultProject,
  onClose,
  onCreate,
}: {
  projects: ProjectSummary[];
  items: Item[];
  defaultProject: string | null;
  onClose: () => void;
  /** Resolves to an error message, or null once the item exists. */
  onCreate: (input: Record<string, unknown>) => Promise<string | null>;
}): React.JSX.Element {
  const [project, setProject] = useState(defaultProject ?? projects[0]?.key ?? "");
  const [type, setType] = useState<ItemType>("task");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Priority>("medium");
  const [parent, setParent] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const summaryRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => summaryRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Mirrors Vault.assertParentValid, so the form cannot offer a rejected pairing.
  const parentChoices = items.filter((candidate) => {
    if (candidate.project !== project) return false;
    if (type === "epic") return false;
    if (type === "subtask") return ["story", "task", "bug"].includes(candidate.type);
    return candidate.type === "epic";
  });

  // Changing type can invalidate the chosen parent.
  useEffect(() => {
    if (parent && !parentChoices.some((c) => c.key === parent)) setParent("");
  }, [type, project, parent, parentChoices]);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!summary.trim() || !project) return;
    setSaving(true);
    setError(null);

    const message = await onCreate({
      project,
      type,
      summary: summary.trim(),
      description: description.trim(),
      priority,
      parent: parent || undefined,
      dueDate: dueDate || undefined,
      category: category.trim() || undefined,
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
          <h2>New item</h2>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <label>
            <span>Summary</span>
            <input
              ref={summaryRef}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What needs doing?"
              required
            />
          </label>

          <div className="modal-row">
            <label>
              <span>Project</span>
              <select value={project} onChange={(e) => setProject(e.target.value)}>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.key} — {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Type</span>
              <select value={type} onChange={(e) => setType(e.target.value as ItemType)}>
                {ITEM_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Priority</span>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="modal-row">
            <label>
              <span>Parent</span>
              <select
                value={parent}
                onChange={(e) => setParent(e.target.value)}
                disabled={type === "epic" || parentChoices.length === 0}
              >
                <option value="">
                  {type === "epic"
                    ? "epics sit at the top"
                    : type === "subtask"
                      ? "required — pick one"
                      : "none"}
                </option>
                {parentChoices.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.key} — {candidate.summary}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <span>Due</span>
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>

            <label>
              <span>Category</span>
              <input
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="optional"
              />
            </label>
          </div>

          <label>
            <span>Description</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              placeholder="Markdown. This becomes the body of the file."
            />
          </label>

          {error && <div className="modal-error">{error}</div>}
        </div>

        <footer className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !summary.trim() || (type === "subtask" && !parent)}
          >
            {saving ? "Creating…" : "Create"}
          </button>
        </footer>
      </form>
    </div>
  );
}
