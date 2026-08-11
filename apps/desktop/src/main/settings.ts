import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";

import type { ThemePreference } from "../shared/api.js";

/**
 * Per-machine app state, remembered between launches: which vault was last
 * open, how far the window is zoomed, and which palette it renders in.
 *
 * Lives in userData rather than beside the vault, because it is about this
 * machine's app state and has no business inside a folder that syncs or gets
 * committed. Zoom especially — it is a property of this screen and these eyes,
 * not of the vault. Theme is the same claim about the same eyes, which is why
 * it went here rather than into any file the vault carries.
 */
interface Settings {
  vaultRoot?: string;
  /** Chromium zoom level, where 0 is 100% and each 0.5 is a factor of 1.2^0.5. */
  zoomLevel?: number;
  /** Absent means "system", which is how the app behaved before this existed. */
  theme?: ThemePreference;
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export async function readSettings(): Promise<Settings> {
  try {
    return JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  const target = settingsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export async function rememberVault(root: string): Promise<void> {
  const settings = await readSettings();
  await writeSettings({ ...settings, vaultRoot: root });
}

export async function rememberZoom(zoomLevel: number): Promise<void> {
  const settings = await readSettings();
  await writeSettings({ ...settings, zoomLevel });
}

export async function rememberTheme(theme: ThemePreference): Promise<void> {
  const settings = await readSettings();
  await writeSettings({ ...settings, theme });
}
