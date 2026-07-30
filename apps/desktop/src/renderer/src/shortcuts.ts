/**
 * The registry of every keyboard shortcut in the app.
 *
 * It exists so the help overlay cannot drift out of sync with the handler —
 * the classic failure of a hand-written shortcut cheatsheet, where a key gets
 * rebound in the handler and the doc comment three files away quietly goes
 * stale. One list, read by both sides, cannot lie to the user about what the
 * app does.
 */

export interface Shortcut {
  /** Key caps as displayed, e.g. ["Ctrl", "K"] or ["?"]. */
  keys: string[];
  label: string;
  group: "Navigation" | "Views" | "Display" | "Items" | "Vault";
  /**
   * True when the shortcut still fires while a text field has focus.
   * Almost nothing should — a bare `n` must type an "n" into the summary box,
   * not open the create dialog.
   */
  whileTyping?: boolean;
}

// Declaration order doubles as display order: the help overlay groups by
// `group` but never sorts, so this array is also the order it renders in.
export const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Ctrl", "K"], label: "Search everything", group: "Navigation", whileTyping: true },
  { keys: ["/"], label: "Focus the filter box", group: "Navigation" },
  { keys: ["j", "↓"], label: "Next item", group: "Navigation" },
  { keys: ["k", "↑"], label: "Previous item", group: "Navigation" },
  { keys: ["h", "←"], label: "Collapse the subtree (backlog)", group: "Navigation" },
  { keys: ["l", "→"], label: "Expand the subtree (backlog)", group: "Navigation" },
  { keys: ["Enter"], label: "Open the highlighted item", group: "Navigation" },
  { keys: ["Esc"], label: "Close panel or overlay", group: "Navigation", whileTyping: true },

  { keys: ["1"], label: "Backlog", group: "Views" },
  { keys: ["2"], label: "Board", group: "Views" },
  { keys: ["3"], label: "Agenda", group: "Views" },

  { keys: ["g"], label: "Group the board by project", group: "Display" },

  // The three below are the one group the App.tsx handler never sees: the main
  // process claims them in zoom.ts, before the key reaches the page, which is
  // what lets them work mid-sentence in a text field. They are listed here
  // anyway — an undiscoverable shortcut is the thing this registry exists to
  // prevent, and where it is handled is not the user's problem.
  { keys: ["Ctrl", "+"], label: "Bigger text", group: "Display", whileTyping: true },
  { keys: ["Ctrl", "−"], label: "Smaller text", group: "Display", whileTyping: true },
  { keys: ["Ctrl", "0"], label: "Back to normal size", group: "Display", whileTyping: true },

  { keys: ["n"], label: "New item", group: "Items" },
  { keys: ["x"], label: "Delete the selected item", group: "Items" },
  { keys: ["e"], label: "Edit the selected item's summary", group: "Items" },

  { keys: ["t"], label: "Trash", group: "Vault" },
  { keys: ["r"], label: "Reload from disk", group: "Vault" },
  { keys: ["?"], label: "This help", group: "Vault" },
];

/**
 * Whether the event's target is a text-entry surface.
 *
 * A bare-letter shortcut firing mid-word is the single most annoying bug a
 * keyboard-driven app can have, so this check has exactly one copy for the
 * handler and the help overlay to share. The inline check it replaces only
 * tested INPUT/TEXTAREA/SELECT and missed contenteditable regions entirely.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
