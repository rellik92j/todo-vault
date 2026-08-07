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
  suggestions,
  autoEdit,
  onAutoEditConsumed,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  multiline?: boolean;
  /**
   * Offered as a dropdown while editing, without constraining what may be typed
   * — a name the list has never seen is precisely how it joins the list. Ignored
   * when `multiline` is set, because a textarea has no picker to open.
   */
  suggestions?: string[];
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
  const offering = !multiline && Boolean(suggestions?.length);

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

  // Its own control rather than the input below, because the menu has to own the
  // keys the input would otherwise handle — Enter picks a highlighted name here,
  // and only commits the typed text when nothing is highlighted.
  if (offering) {
    return (
      <Suggest
        value={draft}
        suggestions={suggestions ?? []}
        className="inline-input"
        autoFocus
        selectOnFocus
        onChange={setDraft}
        // Takes the value rather than reading `draft`, because picking a name
        // sets state and commits in the same tick, where `draft` is still the old one.
        onCommit={(next) => {
          setEditing(false);
          const trimmed = next.trim();
          if (trimmed !== value.trim()) onCommit(trimmed);
        }}
        onCancel={() => {
          setDraft(value);
          setEditing(false);
        }}
      />
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
 * A text field offering values it has seen before, without limiting you to them.
 *
 * Deliberately not a `<datalist>`. That was the first implementation and it read
 * correctly right up until you opened a field that already held a value:
 * Chromium filters the native popup against the input's own contents, so a field
 * reading "Dan Okafor" offered a menu of exactly one name — itself — and every
 * other name was unreachable without emptying the field first. Switching between
 * people you have already named is the entire point of the thing, so the menu has
 * to be one we control. It also means the list is visible in the DOM, which the
 * native popup never was: what a test can read is what is actually on screen.
 *
 * The rule it keeps is: opening shows everything, typing narrows. `touched` is
 * what tells those apart, because the value alone cannot — "Dan Okafor" as the
 * committed value and "Dan Okafor" as what you have typed looking for it are the
 * same string and want opposite menus.
 */
export function Suggest({
  value,
  suggestions,
  placeholder,
  className,
  autoFocus,
  selectOnFocus,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  suggestions: string[];
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  /** Select what is there on focus, so the first keystroke replaces it. */
  selectOnFocus?: boolean;
  onChange: (next: string) => void;
  /** Enter, a pick, or a blur. Carries the value, so a pick need not wait a render. */
  onCommit: (next: string) => void;
  /** Escape, once the menu is out of the way. */
  onCancel?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const [active, setActive] = useState(-1);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);

  const needle = value.trim().toLowerCase();
  const visible =
    touched && needle ? suggestions.filter((s) => s.toLowerCase().includes(needle)) : suggestions;

  const close = (): void => {
    setOpen(false);
    setActive(-1);
  };

  const openMenu = (): void => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setAnchor({ left: box.left, top: box.bottom + 2, width: box.width });
    setTouched(false);
    setActive(-1);
    setOpen(true);
  };

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    if (selectOnFocus) ref.current?.select();
  }, [autoFocus, selectOnFocus]);

  // Anchored to the viewport, because both places this lives — the detail panel
  // and the modal — scroll their own bodies, and a menu positioned inside one
  // would be clipped by it. The price is that it has to leave when anything
  // moves underneath it.
  useEffect(() => {
    if (!open) return;
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  const pick = (name: string): void => {
    close();
    onChange(name);
    onCommit(name);
  };

  return (
    <span className="suggest">
      <input
        ref={ref}
        className={className}
        value={value}
        placeholder={placeholder}
        onFocus={() => {
          openMenu();
          if (selectOnFocus) ref.current?.select();
        }}
        onChange={(e) => {
          setTouched(true);
          setActive(-1);
          setOpen(true);
          onChange(e.target.value);
        }}
        onBlur={() => {
          close();
          onCommit(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) return openMenu();
            return setActive((i) => Math.min(i + 1, visible.length - 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            return setActive((i) => Math.max(i - 1, -1));
          }
          if (e.key === "Enter") {
            e.preventDefault();
            if (open && active >= 0 && visible[active]) return pick(visible[active]);
            close();
            return onCommit(value);
          }
          if (e.key === "Escape") {
            // Dismissing the menu is not abandoning the edit. Both layers above
            // would read it as that if it bubbled — the modal closes on Escape,
            // and App's handler blurs the focused field, which commits it.
            if (open) {
              e.preventDefault();
              e.stopPropagation();
              return close();
            }
            onCancel?.();
          }
        }}
      />
      {open && anchor && visible.length > 0 && (
        <div
          className="suggest-menu"
          role="listbox"
          style={{ left: anchor.left, top: anchor.top, width: anchor.width }}
        >
          {visible.map((name, index) => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={index === active}
              className="suggest-option"
              // Without this the input blurs before the click lands — and blur
              // commits, so the field would be gone by the time the click
              // arrived. The same trap EditableDate's clear button documents.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(name)}
            >
              {name}
              {name === value.trim() && <span className="suggest-current">current</span>}
            </button>
          ))}
        </div>
      )}
    </span>
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
      className="description prose"
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
