import { useEffect, useRef, useState } from "react";

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

export function EditableDate({
  value,
  onCommit,
}: {
  value: string | undefined;
  onCommit: (next: string | null) => void;
}): React.JSX.Element {
  return (
    <span className="date-field">
      <input
        type="date"
        className="inline-input"
        value={value ?? ""}
        onChange={(e) => onCommit(e.target.value || null)}
      />
      {value && (
        <button className="clear-btn" onClick={() => onCommit(null)} title="Clear">
          ✕
        </button>
      )}
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
