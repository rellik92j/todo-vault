import type { Input, WebContents } from "electron";

import { readSettings, rememberZoom } from "./settings.js";

/**
 * Zoom, owned by the app rather than left to Electron's default menu.
 *
 * The default menu (still there, just hidden by `autoHideMenuBar`) binds its
 * zoomIn role to `CommandOrControl+Plus`, and on a US layout "Plus" is only
 * produced with Shift held. So Ctrl+- zoomed out and the obvious Ctrl+= did
 * nothing at all — one direction of a pair, which reads as a broken app rather
 * than an undiscovered chord. Handling the keys here fixes that, adds a reset,
 * keeps the level across launches, and makes zoom work while a text field has
 * focus, which a renderer-side handler could not do without fighting typing.
 */

/** One press. Matches Chromium's own step: each level is a factor of 1.2^0.5. */
const STEP = 0.5;

// Roughly 58% to 207%. The floor is where the UI stops being readable and the
// ceiling is where the 900px minimum window width starts clipping the board;
// past either end the keypress should do nothing rather than ruin the layout.
const MIN_LEVEL = -3;
const MAX_LEVEL = 4;

type ZoomAction = "in" | "out" | "reset";

function clamp(level: number): number {
  return Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, level));
}

/**
 * Which zoom action a keypress asks for, if any.
 *
 * Both `code` and `key` are consulted on purpose. `code` is the physical key
 * and so survives Shift (Ctrl+Shift+= is still the Equal key) and tells the
 * numpad apart; `key` is the character actually produced and so catches the
 * layouts — AZERTY, German — where minus and plus are not where a US keyboard
 * put them.
 */
function zoomAction(input: Input): ZoomAction | undefined {
  const accelerator = process.platform === "darwin" ? input.meta : input.control;
  // Alt is excluded so AltGr combinations, which arrive as Ctrl+Alt on Windows
  // and type real characters on several European layouts, are left alone.
  if (!accelerator || input.alt) return undefined;

  switch (input.code) {
    case "Equal":
    case "NumpadAdd":
      return "in";
    case "Minus":
    case "NumpadSubtract":
      return "out";
    case "Digit0":
    case "Numpad0":
      return "reset";
  }

  switch (input.key) {
    case "+":
    case "=":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return "reset";
    default:
      return undefined;
  }
}

/**
 * Persist the level, but not once per repeat.
 *
 * Holding Ctrl+= fires auto-repeat several times a second, and settings.json is
 * a read-modify-write; letting every step through would interleave writes over
 * the file that also remembers which vault is open.
 */
let pendingWrite: NodeJS.Timeout | undefined;
function saveSoon(level: number): void {
  if (pendingWrite) clearTimeout(pendingWrite);
  pendingWrite = setTimeout(() => {
    pendingWrite = undefined;
    void rememberZoom(level);
  }, 300);
}

/** Bind the zoom keys to a window's contents. */
export function attachZoomShortcuts(contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const action = zoomAction(input);
    if (!action) return;

    // preventDefault stops the default menu's own zoom accelerators as well as
    // the page keydown, so Ctrl+- is applied once here rather than twice.
    event.preventDefault();

    const level =
      action === "reset"
        ? 0
        : clamp(contents.getZoomLevel() + (action === "in" ? STEP : -STEP));
    contents.setZoomLevel(level);
    saveSoon(level);
  });
}

/**
 * Reapply the saved level after a load.
 *
 * Chromium keys its zoom to the page's host, and the renderer is served from
 * file:// in production and localhost in dev — neither carries a level worth
 * trusting, so it is set explicitly on every load instead.
 */
export async function restoreZoom(contents: WebContents): Promise<void> {
  const { zoomLevel } = await readSettings();
  if (typeof zoomLevel !== "number" || !Number.isFinite(zoomLevel)) return;
  if (contents.isDestroyed()) return;
  contents.setZoomLevel(clamp(zoomLevel));
}
