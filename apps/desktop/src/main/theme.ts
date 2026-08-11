import { nativeTheme } from "electron";

import type { ThemePreference } from "../shared/api.js";
import { readSettings, rememberTheme } from "./settings.js";

/**
 * The theme, driven through Electron rather than through a `data-theme`
 * attribute on the document.
 *
 * `nativeTheme.themeSource` changes what `prefers-color-scheme` reports in
 * every renderer, so the `@media (prefers-color-scheme: light)` block that has
 * been in index.css since the first Electron commit simply *becomes* the thing
 * this drives. The stylesheet needed no edit at all.
 *
 * That is not only economy. Keeping a "follow the OS" option means keeping the
 * media query whatever else is added, so an attribute would leave the palette
 * with two independent ways of being chosen — precisely the seam a future token
 * gets added to only one side of. It also reaches what CSS cannot: `color-scheme`
 * follows `themeSource`, so Chromium's own controls flip with the page (the date
 * picker's popup and its indicator icon, scrollbars, focus rings), and on Windows
 * the window frame follows `shouldUseDarkColors` for free.
 */

/*
 * What Chromium paints before the renderer's first frame.
 *
 * These are copies of `--bg` in each block of renderer/src/index.css. Main
 * cannot read the stylesheet, so the duplication is unavoidable and this comment
 * is the mitigation: if `--bg` moves in either block, move it here too. The
 * whole point of a pre-paint colour is to be indistinguishable from the first
 * painted frame, so a discrepancy here shows up as a flash on every launch.
 */
export const DARK_BG = "#0f1115";
export const LIGHT_BG = "#f7f8fa";

/**
 * settings.json is a plain file a person can edit, so a value arriving from it
 * — or over IPC — is checked rather than trusted. An unrecognised one falls
 * back to `system` instead of assigning nonsense to `themeSource`.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** The preference in force. Read from Electron, which main set at boot. */
export function currentTheme(): ThemePreference {
  return nativeTheme.themeSource;
}

/** The pre-paint colour for whichever scheme is resolved right now. */
export function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG;
}

/**
 * Apply the saved preference. Called inside `whenReady` and **before** the
 * window is created.
 *
 * The timing is the whole point, and it is where zoom and theme part company.
 * `restoreZoom` runs on `did-finish-load`, after the renderer has painted, which
 * is fine because a page resizing a tick late is invisible. A theme applied a
 * tick late is a flash of the wrong palette on every launch — the single most
 * common way this feature ships broken.
 */
export async function applySavedTheme(): Promise<ThemePreference> {
  const { theme } = await readSettings();
  const preference = isThemePreference(theme) ? theme : "system";
  nativeTheme.themeSource = preference;
  return preference;
}

/** Apply and persist a new preference, returning what was applied. */
export async function applyTheme(preference: ThemePreference): Promise<ThemePreference> {
  if (!isThemePreference(preference)) throw new Error(`${String(preference)} is not a theme`);
  nativeTheme.themeSource = preference;
  await rememberTheme(preference);
  return preference;
}
