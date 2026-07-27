import { useEffect, useRef, useState } from "react";
import { isLosslessDescription } from "todo-vault/description";

import { Markdown } from "./Markdown";
import { RichEditor } from "./RichEditor";

/**
 * Inline editing primitives.
 *
 * Each commits on blur or Enter and reverts on Escape, and each takes the value
 * fresh from props every render — the snapshot is the source of truth, so a
 * change written by something else while a field is open wins rather than being
 * overwritten by stale local state.
 */

export function EditableText({
  value,
  placeholder,
  multiline,
  autoEdit,
  onAutoEditConsumed,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  multiline?: boolean;
  /** Open straight into editing — the `e` shortcut asks for this. */
  autoEdit?: boolean;
  /**
   * Called once the request has been honoured, so the caller can drop the flag.
   *
   * A consume-once flag rather than a counter, because the request arrives in
   * the same click as the panel opening: a counter compared against its value at
   * mount cannot tell "opened with intent to edit" from "opened normally, after
   * three earlier edits". Clearing it here also means pressing `e` again after
   * escaping out of the field re-opens it.
   */
  onAutoEditConsumed?: () => void;
  onCommit: (next: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(Boolean(autoEdit));
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!autoEdit) return;
    setEditing(true);
    onAutoEditConsumed?.();
  }, [autoEdit, onAutoEditConsumed]);

  useEffect(() => {
    if (editing) {
      setDraft(value);
      ref.current?.focus();
      if (ref.current instanceof HTMLInputElement) ref.current.select();
    }
  }, [editing, value]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value.trim()) onCommit(trimmed);
  };

  if (!editing) {
    return (
      <button
        className={`inline-edit ${value ? "" : "inline-empty"}`}
        onClick={() => setEditing(true)}
        title="Click to edit"
      >
        {value || placeholder || "—"}
      </button>
    );
  }

  const shared = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        setDraft(value);
        setEditing(false);
      }
      // Enter commits a single line; in a textarea it needs a modifier so
      // newlines stay possible.
      if (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
      }
    },
  };

  return multiline ? (
    <textarea
      {...shared}
      ref={ref as React.Ref<HTMLTextAreaElement>}
      className="inline-input inline-textarea"
      rows={6}
    />
  ) : (
    <input {...shared} ref={ref as React.Ref<HTMLInputElement>} className="inline-input" />
  );
}

/**
 * The same bargain as EditableText — committed on blur, reverted on Escape — but
 * rendering markdown when read and editing it as formatting rather than syntax.
 *
 * It cannot simply be EditableText with a renderer bolted on, because that
 * component's read mode is a `<button>`: block elements may not nest inside one,
 * and a link inside one is unclickable. So the read view is a plain container,
 * and the click-to-edit affordance moves to the section heading, which is where
 * Links and Attachments already keep theirs.
 *
 * Which editor you get is not a preference, it is a fact about the text.
 * `isLosslessDescription` asks whether this exact content survives a parse and a
 * write byte for byte. When it does, the rich editor can only write back what
 * someone actually changed. When it does not — `_em_`, `+` bullets, a run of
 * blank lines — editing it richly would restyle a file its author wrote
 * deliberately, and with `--git` on that lands as a commit nobody typed. So
 * those fall back to the raw box, saying why. Lossless or plain text, never
 * lossy.
 *
 * `editing` is the caller's state so the heading button can open the field
 * without reaching in here.
 */
export function EditableMarkdown({
  value,
  placeholder,
  editing,
  setEditing,
  source,
  onCommit,
  onOpenLink,
}: {
  value: string;
  placeholder?: string;
  editing: boolean;
  setEditing: (next: boolean) => void;
  /** Edit the markdown by hand, whether or not it would round-trip. */
  source?: boolean;
  onCommit: (next: string) => void;
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const rich = !source && isLosslessDescription(value);

  useEffect(() => {
    if (!editing || rich) return;
    setDraft(value);
    ref.current?.focus();
  }, [editing, rich, value]);

  const commit = (next: string): void => {
    setEditing(false);
    const trimmed = next.trim();
    if (trimmed !== value.trim()) onCommit(trimmed);
  };

  if (editing && rich) {
    return (
      <RichEditor value={value} onCommit={commit} onCancel={() => setEditing(false)} />
    );
  }

  if (editing) {
    return (
      <>
        {!source && (
          <div className="field-note">
            Editing as markdown: this description uses formatting the rich editor
            would rewrite.
          </div>
        )}
        <textarea
          ref={ref}
          className="inline-input inline-textarea"
          rows={8}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
            // A newline is the whole point of this field, so Enter alone types
            // one and committing takes a modifier.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit(draft);
            }
          }}
        />
      </>
    );
  }

  if (!value) {
    return (
      <button className="inline-edit inline-empty" onClick={() => setEditing(true)}>
        {placeholder || "—"}
      </button>
    );
  }

  return (
    <div
      className="description"
      title="Click to edit"
      onClick={(e) => {
        // A link in the text is there to be followed; only a click on the prose
        // around it means "edit".
        if ((e.target as HTMLElement).closest("a, button, pre")) return;
        setEditing(true);
      }}
    >
      <Markdown source={value} onOpenLink={onOpenLink} />
    </div>
  );
}

export function EditableSelect<T extends string>({
  value,
  options,
  onCommit,
  labels,
}: {
  value: T;
  options: readonly T[];
  onCommit: (next: T) => void;
  labels?: Record<string, string>;
}): React.JSX.Element {
  return (
    <select
      className="inline-select"
      value={value}
      onChange={(e) => onCommit(e.target.value as T)}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {labels?.[option] ?? option}
        </option>
      ))}
    </select>
  );
}

/**
 * Click to reveal a real date picker; reads as plain text the rest of the time.
 *
 * This used to render a bare `<input type="date">`, so both date fields sat in
 * permanent edit mode while every other field in the panel was quiet text until
 * clicked — the one row that always looked like a form. It now follows
 * EditableText: a button until you click it, an input while you are in it.
 *
 * Entering edit mode opens the calendar immediately. The field only gets there
 * because the user clicked it, so making them click a second time to see a
 * calendar would be a step that buys nothing.
 */
export function EditableDate({
  value,
  placeholder,
  onCommit,
}: {
  value: string | undefined;
  placeholder?: string;
  onCommit: (next: string | null) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    ref.current?.focus();
    try {
      // Needs transient user activation, which the click that got us here
      // provides. If it has lapsed this throws, and typing the date still works
      // — so a failure here costs the convenience, not the feature.
      ref.current?.showPicker();
    } catch {
      /* keyboard entry is the fallback */
    }
  }, [editing]);

  const clear = value ? (
    <button
      type="button"
      className="clear-btn"
      // Without this, mousedown blurs the input and unmounts this button before
      // the click lands — the field would simply refuse to clear while open.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onCommit(null);
        setEditing(false);
      }}
      title="Clear"
    >
      ✕
    </button>
  ) : null;

  if (!editing) {
    return (
      <span className="date-field">
        <button
          type="button"
          className={`inline-edit ${value ? "" : "inline-empty"}`}
          onClick={() => setEditing(true)}
          title="Click to pick a date"
        >
          {value || placeholder || "—"}
        </button>
        {clear}
      </span>
    );
  }

  return (
    <span className="date-field">
      <input
        ref={ref}
        type="date"
        className="inline-input"
        value={value ?? ""}
        onChange={(e) => onCommit(e.target.value || null)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          // No draft state to revert: a date input commits whole valid dates
          // only, so Escape and Enter both just leave.
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
      {clear}
    </span>
  );
}

/** Comma-separated in, array out. Labels are a list, but typing one is not. */
export function EditableList({
  value,
  placeholder,
  onCommit,
}: {
  value: string[];
  placeholder?: string;
  onCommit: (next: string[]) => void;
}): React.JSX.Element {
  return (
    <EditableText
      value={value.join(", ")}
      placeholder={placeholder}
      onCommit={(next) =>
        onCommit(
          next
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        )
      }
    />
  );
}
