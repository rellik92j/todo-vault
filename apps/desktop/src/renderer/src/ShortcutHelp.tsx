import { useEffect } from "react";
import { SHORTCUTS, type Shortcut } from "./shortcuts";

/**
 * The whole surface is generated from SHORTCUTS — see shortcuts.ts for why —
 * so a new or rebound shortcut needs one line changed there and nothing here.
 */
export function ShortcutHelp({ onClose }: { onClose: () => void }): React.JSX.Element {
  // Same effect shape as CreateDialog's Escape handling, cleanup included.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Keyboard shortcuts</h2>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="shortcuts-grid">
            {groupedShortcuts().map(({ group, shortcuts }) => (
              <section className="shortcuts-group" key={group}>
                <h3>{group}</h3>
                <div className="shortcuts-list">
                  {shortcuts.map((shortcut) => (
                    <div className="shortcut" key={shortcut.label}>
                      <span className="shortcut-label">{shortcut.label}</span>
                      <KeyCaps keys={shortcut.keys} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>

        <footer className="modal-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

// Groups by first appearance rather than sorting, so the registry's own
// declaration order — Navigation, Views, Items, Vault — is the order the
// help screen shows them in, with no second list of group names to keep
// in step with shortcuts.ts.
function groupedShortcuts(): { group: Shortcut["group"]; shortcuts: Shortcut[] }[] {
  const order: Shortcut["group"][] = [];
  const byGroup = new Map<Shortcut["group"], Shortcut[]>();
  for (const shortcut of SHORTCUTS) {
    if (!byGroup.has(shortcut.group)) {
      order.push(shortcut.group);
      byGroup.set(shortcut.group, []);
    }
    byGroup.get(shortcut.group)?.push(shortcut);
  }
  return order.map((group) => ({ group, shortcuts: byGroup.get(group) ?? [] }));
}

/** Recognized modifiers — anything else pairs with a plain key, not a chord. */
const MODIFIERS = new Set(["Ctrl", "Alt", "Shift", "Cmd", "Meta"]);

/**
 * `keys` overloads one array shape for two different meanings: a chord like
 * Ctrl+K (press together) and alternate bindings like j / ↓ (either works).
 * Rendering them the same way would tell the user that Ctrl alone searches
 * everything, so the connector is chosen from whether the first cap is a
 * modifier — the one signal already present in the data.
 */
function KeyCaps({ keys }: { keys: string[] }): React.JSX.Element {
  const chord = keys.length > 1 && MODIFIERS.has(keys[0]);
  return (
    <span className="keycaps">
      {keys.map((key, index) => (
        <span className="keycaps" key={key}>
          {index > 0 && <span className="keycap-join">{chord ? "+" : "or"}</span>}
          <kbd className="pill">{key}</kbd>
        </span>
      ))}
    </span>
  );
}
