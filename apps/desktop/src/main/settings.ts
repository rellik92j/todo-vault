import { promises as fs } from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Which vault was last open, remembered between launches.
 *
 * Lives in userData rather than beside the vault, because it is about this
 * machine's app state and has no business inside a folder that syncs or gets
 * committed.
 */
interface Settings {
  vaultRoot?: string;
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
