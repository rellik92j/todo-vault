import path from "node:path";
import { promises as fs } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { CHANNELS, type MaybeSnapshot, type Result, type VaultSnapshot } from "../shared/api.js";
import { VaultService } from "./vault-service.js";
import { readSettings, rememberVault } from "./settings.js";

const service = new VaultService();
let mainWindow: BrowserWindow | undefined;

/**
 * Wrap a handler so nothing ever rejects across IPC.
 *
 * Electron's structured clone drops the Error class, so a thrown VaultError
 * would reach the renderer as a shapeless object with its message buried. The
 * core writes its messages for humans, so they get carried across intact and
 * shown verbatim.
 */
function handle<A extends unknown[], T>(
  channel: string,
  fn: (...args: A) => Promise<T> | T,
): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      return { ok: true, value: await fn(...(args as A)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[main] ${channel} failed:`, message);
      return { ok: false, message };
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#111318",
    title: "Vault",
    autoHideMenuBar: true,
    webPreferences: {
      // CJS, which a sandboxed preload has to be. The app is not "type": "module",
      // so electron-vite emits .js in CommonJS and Electron loads it as such.
      preload: path.join(__dirname, "../preload/index.js"),
      // The renderer gets no Node. Everything goes through the preload bridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  mainWindow.webContents.on("did-fail-load", (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
  });

  /**
   * Renderer console output, forwarded to the terminal.
   *
   * Electron 35 changed this event from positional arguments to a single details
   * object, so both shapes are handled — with only the old one, a production
   * problem logs nothing at all, which is exactly when you need it.
   */
  mainWindow.webContents.on(
    "console-message",
    (...args: unknown[]) => {
      const modern = args[1] as { level?: string; message?: string; lineNumber?: number } | undefined;
      if (modern && typeof modern === "object" && "message" in modern) {
        if (modern.level === "error" || modern.level === "warning") {
          console.error(`[renderer] ${modern.level}: ${modern.message}`);
        }
        return;
      }
      const [, level, message] = args as [unknown, number, string];
      if (typeof level === "number" && level >= 2) console.error(`[renderer] ${message}`);
    },
  );

  // External links open in the real browser, never inside the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  // Show once the load settles either way. Relying on ready-to-show alone means
  // a renderer that fails to boot produces no window at all and no explanation.
  const load = process.env.ELECTRON_RENDERER_URL
    ? mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    : mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  load
    .catch((err: unknown) => {
      console.error("[main] renderer load rejected:", err);
    })
    .finally(() => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        mainWindow.show();
      }
    });
}

/**
 * The example vault in the repo, offered as a starting point on first run so the
 * app has something real in it immediately.
 */
async function suggestedVault(): Promise<string | null> {
  const candidates = [
    path.resolve(app.getAppPath(), "../../vault"),
    path.resolve(app.getAppPath(), "../../../vault"),
    path.resolve(process.cwd(), "vault"),
  ];
  for (const candidate of candidates) {
    if (await VaultService.looksLikeVault(candidate)) return candidate;
  }
  return null;
}

function registerHandlers(): void {
  handle<[], MaybeSnapshot>(CHANNELS.getSnapshot, async () =>
    service.isOpen ? await service.snapshot() : null,
  );

  handle<[], MaybeSnapshot>(CHANNELS.chooseVault, async () => {
    const result = await dialog.showOpenDialog({
      title: "Choose a vault folder",
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Open vault",
    });
    if (result.canceled || !result.filePaths[0]) return null;

    const root = result.filePaths[0];
    if (await VaultService.looksLikeVault(root)) {
      const snapshot = await service.open(root);
      await rememberVault(root);
      return snapshot;
    }

    // Not a vault. Offer to make one rather than dead-ending on an error.
    const empty = await VaultService.isEmptyish(root);
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Not a vault yet",
      message: `${path.basename(root)} has no items/ folder, so it is not a vault.`,
      detail: empty
        ? "Create a new, empty vault here?"
        : "This folder already has other files in it. A vault can still be created alongside them.",
      buttons: ["Create a vault here", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return null;

    const snapshot = await service.init(root);
    await rememberVault(root);
    return snapshot;
  });

  handle<[string], MaybeSnapshot>(CHANNELS.openVault, async (root) => {
    const snapshot = await service.open(root);
    await rememberVault(root);
    return snapshot;
  });

  handle<[string], MaybeSnapshot>(CHANNELS.initVault, async (root) => {
    const snapshot = await service.init(root);
    await rememberVault(root);
    return snapshot;
  });

  handle<[], MaybeSnapshot>(CHANNELS.reload, async () =>
    service.isOpen ? await service.reload() : null,
  );

  handle(CHANNELS.listItems, (filter: Record<string, unknown>) => service.listItems(filter ?? {}));
  handle(CHANNELS.getAgenda, (scope: "today" | "week" | "month") => service.getAgenda(scope));
  handle(CHANNELS.getRelated, (key: string) => service.getRelated(key));
  handle(CHANNELS.getSuggestedVault, () => suggestedVault());

  handle(
    CHANNELS.revealPath,
    async (target: { kind: "item" | "attachment" | "vault"; value?: string }) => {
      if (!service.root) throw new Error("No vault is open");

      if (target.kind === "vault") {
        await shell.openPath(service.root);
        return null;
      }
      if (!target.value) throw new Error("Nothing to reveal");

      const resolved =
        target.kind === "item"
          ? service.itemPath(target.value)
          : service.resolveAttachment(target.value);

      // Never reveal something outside the vault on a value that arrived over IPC.
      const relative = path.relative(service.root, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`${target.value} is outside the vault`);
      }
      try {
        await fs.stat(resolved);
      } catch {
        throw new Error(`${path.basename(resolved)} is not on disk`);
      }

      shell.showItemInFolder(resolved);
      return null;
    },
  );
}

app.whenReady().then(async () => {
  registerHandlers();

  // Reopen whatever was open last, if it is still a vault.
  const { vaultRoot } = await readSettings();
  if (vaultRoot && (await VaultService.looksLikeVault(vaultRoot))) {
    try {
      await service.open(vaultRoot);
    } catch (err) {
      console.error("[main] could not reopen the last vault:", err);
    }
  }

  service.on("changed", (snapshot: VaultSnapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(CHANNELS.changed, snapshot);
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void service.stopWatching();
});
