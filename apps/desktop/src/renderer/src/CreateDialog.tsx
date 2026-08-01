import { useEffect, useRef, useState } from "react";
import {
  CADENCES,
  ITEM_TYPES,
  PRIORITIES,
  type Cadence,
  type ItemType,
  type Priority,
} from "todo-vault/constants";
import type { Item } from "todo-vault";
import type { ClaudeStatus, ProjectSummary } from "@shared/api";

import { isLosslessDescription } from "todo-vault/description";

import { RichEditor } from "./RichEditor";
import { Suggest } from "./Editable";
import { legalParents } from "./pieces";

/**
 * New item form, shaped to CreateItemInput so the vault's own validation is the
 * only validation. Parent choices are filtered to what the hierarchy allows —
 * epics take no parent, subtasks hang off a story/task/bug, everything else off
 * an epic — so an invalid combination cannot be submitted.
 */
export function CreateDialog({
  projects,
  items,
  reporters,
  defaultProject,
  onClose,
  onCreate,
}: {
  projects: ProjectSummary[];
  items: Item[];
  /** Every name the vault has used, for the Reporter menu. Derived in App. */
  reporters: string[];
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
  const [labels, setLabels] = useState("");
  const [cadence, setCadence] = useState<Cadence>("none");
  const [reporter, setReporter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [source, setSource] = useState(false);
  // Bumped when a draft replaces the description, to remount the editor. See
  // where it is used for why the editor cannot simply watch the value.
  const [draftGeneration, setDraftGeneration] = useState(0);

  // The optional Claude layer. Null until the status call answers; the section
  // renders as unavailable rather than absent, so the feature is discoverable
  // even when it is switched off.
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [notes, setNotes] = useState("");

  const summaryRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => summaryRef.current?.focus(), []);

  // Same rule the detail panel keeps: the rich editor is offered only for text
  // it can write back unchanged. A Claude draft is the one thing here that can
  // arrive using formatting outside the grammar's single spelling of it.
  const rich = !source && isLosslessDescription(description);

  useEffect(() => {
    let live = true;
    void window.vault.claudeStatus().then((result) => {
      if (live && result.ok) setClaude(result.value);
    });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Fill the form from a draft. Deliberately does not submit: the draft is a
   * proposal, and the confirmation step — the user reading it and pressing
   * Create — is the whole reason this is safe to offer.
   */
  const draft = async (): Promise<void> => {
    if (!prompt.trim()) return;
    setDrafting(true);
    setError(null);

    const result = await window.vault.draftItem(prompt.trim(), project || null);
    setDrafting(false);

    if (!result.ok) {
      setError(result.message);
      return;
    }

    const { input, notes: caveat } = result.value;
    setProject(input.project);
    setType(input.type);
    setSummary(input.summary);
    setDescription(input.description ?? "");
    setDraftGeneration((n) => n + 1);
    if (input.priority) setPriority(input.priority);
    setDueDate(input.dueDate ?? "");
    setCategory(input.category ?? "");
    setLabels((input.labels ?? []).join(", "));
    setCadence(input.cadence ?? "none");
    // Applied only when the draft names someone, unlike the fields above which
    // are cleared when it does not. The schema does ask Claude for a reporter
    // now, but most notes name nobody and come back empty — and an empty answer
    // must not wipe a name typed before pressing Draft, since that person still
    // asked for the work. Overwriting it when the note *does* name someone is
    // the point: a name only Claude saw would otherwise reach the description
    // body, where the reporter filter can never find it.
    if (input.reporter) setReporter(input.reporter);
    setNotes(caveat);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The same list the detail panel's parent picker offers — see legalParents.
  const parentChoices = legalParents(items, project, type);

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
      // Comma-separated in, array out — same shape as EditableList uses in the
      // detail panel, so the two ways of setting labels agree.
      labels: labels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      cadence,
      reporter: reporter.trim() || undefined,
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
          {claude && (claude.storageAvailable && claude.hasKey ? (
            <div className="draft-box">
              <textarea
                className="draft-input"
                value={prompt}
                rows={2}
                placeholder="Describe it in a sentence and let Claude fill the form — e.g. “chase legal for the signed DPA, high priority, by Friday”"
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void draft();
                  }
                }}
              />
              <button
                type="button"
                className="btn"
                disabled={drafting || !prompt.trim()}
                onClick={() => void draft()}
                title="Ctrl-Enter"
              >
                {drafting ? "Drafting…" : "Draft"}
              </button>
            </div>
          ) : (
            <p className="field-note">
              Drafting is off.{" "}
              {claude.storageAvailable
                ? "Add an API key under Claude in the sidebar to turn it on."
                : "Encrypted key storage is unavailable on this machine."}
            </p>
          ))}

          {notes && (
            <div className="draft-note">
              <strong>Claude noted:</strong> {notes}
            </div>
          )}

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

          <div className="modal-row">
            <label>
              <span>Labels</span>
              <input
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
                placeholder="comma-separated"
              />
            </label>

            <label>
              <span>Cadence</span>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {c === "none" ? "one-off" : c}
                  </option>
                ))}
              </select>
            </label>

            {/*
              Who asked for this. Assignee is deliberately not here beside it: who
              wants the work is known while you are logging it, and who will do it
              usually is not yet — so it stays a detail-panel field.

              A suggesting text field rather than a select, because the menu is a
              record of what has been typed, not a roster to pick from. A name it
              has never seen is typed straight in and is on the menu from then on.

              A div rather than a <label>, for the reason the description field
              below documents: a click anywhere inside a label is forwarded to the
              control it names, so picking a name from the menu would re-focus the
              input and reopen the menu you just chose from.
            */}
            <div className="modal-field">
              <span>Reporter</span>
              <Suggest
                value={reporter}
                suggestions={reporters}
                placeholder="who asked for it"
                onChange={setReporter}
                onCommit={setReporter}
              />
            </div>
          </div>

          {/*
            A div, not a <label> like every other field here. Clicking a label
            activates its first labelable descendant, and that is the source
            toggle — so with the rich editor inside one, every click into the
            prose pressed the button and flipped the field to raw markdown. The
            editing surface is a contenteditable, not a form control, so there
            is nothing for a label to point at anyway.
          */}
          <div className="modal-field">
            <span>
              Description
              {/* The preview toggle this replaces answered "what will my
                  markdown look like", which is no longer a question you have to
                  ask. What is left is the reverse: seeing the markdown itself. */}
              <button
                type="button"
                className="add-btn"
                onClick={() => setSource((v) => !v)}
                title="Edit the raw markdown"
              >
                {source ? "rich" : "source"}
              </button>
            </span>
            {rich ? (
              // Remounted when a draft arrives: the editor takes its content
              // once, at mount, so that typing is never yanked out from under
              // you — which means a value replaced from outside needs a new one.
              <RichEditor
                key={draftGeneration}
                value={description}
                onChange={setDescription}
              />
            ) : (
              <>
                {!source && (
                  <div className="field-note">
                    Editing as markdown: this uses formatting the rich editor would
                    rewrite.
                  </div>
                )}
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={5}
                  placeholder="Markdown. This becomes the body of the file."
                />
              </>
            )}
          </div>

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
