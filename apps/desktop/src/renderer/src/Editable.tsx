import { useEffect, useRef, useState } from "react";

import { Markdown } from "./Markdown";

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
 * The same bargain as EditableText — raw text in a textarea, committed on blur —
 * but reading back as rendered markdown instead of as one collapsed line.
 *
 * It cannot simply be EditableText with a renderer bolted on, because that
 * component's read mode is a `<button>`: block elements may not nest inside one,
 * and a link inside one is unclickable. So the read view is a plain container,
 * and the click-to-edit affordance moves to the section heading, which is where
 * Links and Attachments already keep theirs.
 *
 * Editing is still raw markdown, deliberately. The file on disk is the document;
 * a WYSIWYG layer would put a second representation between you and it.
 *
 * `editing` is the caller's state so the heading button can open the field
 * without reaching in here.
 */
export function EditableMarkdown({
  value,
  placeholder,
  editing,
  setEditing,
  onCommit,
  onOpenLink,
}: {
  value: string;
  placeholder?: string;
  editing: boolean;
  setEditing: (next: boolean) => void;
  onCommit: (next: string) => void;
  onOpenLink: (href: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    ref.current?.focus();
  }, [editing, value]);

  const commit = (): void => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed !== value.trim()) onCommit(trimmed);
  };

  if (editing) {
    return (
      <textarea
        ref={ref}
        className="inline-input inline-textarea"
        rows={8}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
          // A newline is the whole point of this field, so Enter alone types
          // one and committing takes a modifier.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
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
