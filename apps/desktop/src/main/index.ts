import path from "node:path";
import { promises as fs } from "node:fs";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

import { formatZodError, type HistoryQuery, type Status } from "todo-vault";
import {
  CHANNELS,
  type AgendaScope,
  type ClaudeStatus,
  type MaybeSnapshot,
  type Result,
  type ThemePreference,
  type VaultSnapshot,
} from "../shared/api.js";
import { VaultService } from "./vault-service.js";
import { readSettings, rememberVault } from "./settings.js";
import { clearApiKey, secretStatus, setApiKey } from "./secrets.js";
import { CLAUDE_MODEL, draftItem } from "./claude.js";
import { attachZoomShortcuts, restoreZoom } from "./zoom.js";
import { applySavedTheme, applyTheme, backgroundColor, currentTheme } from "./theme.js";
import { discoverSyncedRoots } from "./synced-roots.js";
import { isInAppNavigation } from "./navigation.js";

const service = new VaultService();
let mainWindow: BrowserWindow | undefined;

// Link targets reach this handler from hand-edited frontmatter and the MCP
// server, not just this UI, so an unchecked scheme is a local-code-execution
// vector (file:, javascript:, ms-msdt:, search-ms:), not just a UX nicety.
const ALLOWED_EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// A `file`/`folder` link can point anywhere, written by the MCP server or a
// hand-edited frontmatter file just as easily as by this app. shell.openPath
// runs these rather than opening them, so refuse them instead of executing
// whatever a vault happens to contain.
const EXECUTABLE_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".js", ".jar", ".lnk", ".url", ".reg",
]);

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
      // formatZodError, not err.message: the core's write paths validate with
      // zod's .parse(), and a ZodError's default message is the whole issue
      // array as JSON. Picking a start date after a due date put a wall of
      // `[{"code":"custom","path":["dueDate"]...` in the UI banner, burying the
      // one sentence the schema had already written for a human. This falls
      // through to err.message for everything that is not a zod error.
      const message = formatZodError(err);
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
    // Resolved rather than hardcoded: a fixed near-black here would flash on
    // every launch in light mode, which is the exact thing applySavedTheme()
    // running before this call went to trouble to avoid.
    backgroundColor: backgroundColor(),
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

  // Zoom is handled here rather than in the renderer so it also works with a
  // text field focused, and the saved level is reapplied on every load because
  // Chromium does not keep one worth trusting for file:// or localhost.
  const contents = mainWindow.webContents;
  attachZoomShortcuts(contents);
  contents.on("did-finish-load", () => {
    void restoreZoom(contents);
  });

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

  // External links open in the real browser, never inside the app shell —
  // and only for a scheme on the allowlist above.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      return { action: "deny" };
    }
    if (ALLOWED_EXTERNAL_SCHEMES.has(scheme)) {
      void shell.openExternal(url);
    } else {
      console.error(`[main] refused to open external link with scheme ${scheme}`);
    }
    return { action: "deny" };
  });

  // And the window itself never navigates away. The handler above covers new
  // windows; without this one, a URL dropped on any region the renderer does
  // not handle replaces the app — taking the preload's whole vault API with it.
  // See navigation.ts.
  contents.on("will-navigate", (event, url) => {
    if (isInAppNavigation(url, contents.getURL())) return;
    event.preventDefault();
    console.error(`[main] refused to navigate the app window to ${url}`);
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
  handle(CHANNELS.getAgenda, (scope: AgendaScope) => service.getAgenda(scope));
  handle(CHANNELS.getRelated, (key: string) => service.getRelated(key));
  handle(CHANNELS.getHistory, (query: HistoryQuery) => service.getHistory(query ?? {}));
  handle(CHANNELS.getSuggestedVault, () => suggestedVault());

  handle<[], ThemePreference>(CHANNELS.getTheme, () => currentTheme());

  handle<[ThemePreference], ThemePreference>(CHANNELS.setTheme, async (preference) => {
    const applied = await applyTheme(preference);
    // So a later reload does not flash the scheme just left. The window is
    // reached from here rather than from theme.ts, which owns no window.
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(backgroundColor());
    }
    return applied;
  });

  // --------------------------------------------------------------- mutations
  // Each returns a fresh snapshot so the renderer replaces rather than merges.

  handle(CHANNELS.createItem, async (input: unknown) => {
    const item = await service.createItem(input);
    return { snapshot: await service.snapshot(), key: item.key };
  });

  handle(CHANNELS.updateItem, async (key: string, patch: unknown) => {
    await service.updateItem(key, patch);
    return service.snapshot();
  });

  handle(CHANNELS.updateItems, async (keys: string[], patch: unknown) => {
    const { updated, skipped } = await service.updateItems(keys, patch);
    return { snapshot: await service.snapshot(), updated: updated.length, skipped };
  });

  handle(CHANNELS.transitionItem, async (key: string, status: Status) => {
    await service.transition(key, status);
    return service.snapshot();
  });

  handle(CHANNELS.tickItem, async (key: string, on: string | undefined, undo: boolean) => {
    await service.tick(key, on, undo === true);
    return service.snapshot();
  });

  handle(
    CHANNELS.moveItem,
    async (key: string, position: { after?: string; before?: string }) => {
      await service.moveItem(key, position);
      return service.snapshot();
    },
  );

  handle(CHANNELS.addComment, async (key: string, body: string) => {
    await service.addComment(key, body);
    return service.snapshot();
  });

  handle(
    CHANNELS.addLink,
    async (key: string, link: { type: string; target: string; label?: string }) => {
      await service.addLink(key, link);
      return service.snapshot();
    },
  );

  handle(CHANNELS.removeLink, async (key: string, target: string) => {
    await service.removeLink(key, target);
    return service.snapshot();
  });

  handle(CHANNELS.attachViaDialog, async (key: string, copy: boolean) => {
    const result = await dialog.showOpenDialog({
      title: copy ? "Attach a copy" : "Link a file, leaving it where it is",
      properties: ["openFile", "multiSelections"],
      buttonLabel: copy ? "Copy in" : "Link",
    });
    if (result.canceled || !result.filePaths.length) return null;
    await service.attachPaths(key, result.filePaths, copy);
    return service.snapshot();
  });

  handle(CHANNELS.attachPaths, async (key: string, paths: string[], copy: boolean) => {
    // `downgradeSynced` is on here and off in the dialog handler above: see
    // VaultService.attachPaths for why a drop and a picker differ.
    const { linkedInstead } = await service.attachPaths(key, paths, copy, true);
    return { snapshot: await service.snapshot(), linkedInstead };
  });

  handle(CHANNELS.deleteItem, async (key: string, cascade: boolean) => {
    const trashed = await service.deleteItem(key, cascade);
    return { snapshot: await service.snapshot(), trashed };
  });

  handle(CHANNELS.restoreItem, async (file: string) => {
    await service.restoreItem(file);
    return service.snapshot();
  });

  handle(CHANNELS.listTrash, () => service.listTrash());

  handle(
    CHANNELS.createProject,
    async (input: { key: string; name: string; description?: string }) => {
      await service.createProject(input);
      return service.snapshot();
    },
  );

  handle(CHANNELS.updateProject, async (key: string, patch: unknown) => {
    await service.updateProject(key, patch);
    return service.snapshot();
  });

  handle(
    CHANNELS.moveProject,
    async (key: string, position: { after?: string; before?: string }) => {
      await service.moveProject(key, position);
      return service.snapshot();
    },
  );

  handle(CHANNELS.hideProject, async (key: string) => {
    await service.hideProject(key);
    return service.snapshot();
  });

  handle(CHANNELS.unhideProject, async (key: string) => {
    await service.unhideProject(key);
    return service.snapshot();
  });

  // --------------------------------------------------------- optional Claude
  // Every one of these answers even when nothing is configured, so the renderer
  // can explain the state rather than the feature simply not being there.

  handle(CHANNELS.claudeStatus, () => claudeStatus());

  handle(CHANNELS.setClaudeKey, async (key: string) => {
    await setApiKey(key);
    return claudeStatus();
  });

  handle(CHANNELS.clearClaudeKey, async () => {
    await clearApiKey();
    return claudeStatus();
  });

  handle(CHANNELS.draftItem, async (prompt: string, defaultProject: string | null) => {
    if (!service.isOpen) throw new Error("Open a vault before drafting.");
    const snapshot = await service.snapshot();

    // The categories and labels already in the vault are passed in so a draft
    // reuses the user's own vocabulary instead of inventing a parallel one.
    return draftItem(prompt, {
      projects: snapshot.projects.map((p) => ({ key: p.key, name: p.name })),
      categories: [
        ...new Set(snapshot.items.map((i) => i.category).filter((c): c is string => Boolean(c))),
      ].sort(),
      labels: [...new Set(snapshot.items.flatMap((i) => i.labels))].sort(),
      defaultProject,
    });
  });

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

  handle(
    CHANNELS.openTarget,
    async (target: { kind: "attachment" | "file" | "folder" | "external"; value: string }) => {
      if (target.kind === "external") {
        let scheme: string;
        try {
          scheme = new URL(target.value).protocol;
        } catch {
          throw new Error(`${target.value} is not a valid URL`);
        }
        if (!ALLOWED_EXTERNAL_SCHEMES.has(scheme)) {
          throw new Error(`Refusing to open a ${scheme} link`);
        }
        await shell.openExternal(target.value);
        return null;
      }

      let resolved: string;
      if (target.kind === "attachment") {
        if (!service.root) throw new Error("No vault is open");
        resolved = service.resolveAttachment(target.value);
        // Same guard as revealPath: nothing arriving over IPC should escape the vault.
        const relative = path.relative(service.root, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`${target.value} is outside the vault`);
        }
      } else {
        // `file`/`folder` links are by definition outside the vault, so the
        // containment guard above cannot apply here — the extension refusal
        // list is the substitute for it.
        resolved = path.resolve(target.value);
        const ext = path.extname(resolved).toLowerCase();
        if (EXECUTABLE_EXTENSIONS.has(ext)) {
          throw new Error(
            `Refusing to open ${path.basename(resolved)} — a ${ext} file would run rather than open`,
          );
        }
      }

      try {
        await fs.stat(resolved);
      } catch {
        throw new Error(`${path.basename(resolved)} is not on disk`);
      }

      // shell.openPath returns an error string instead of throwing, so a
      // missing file or a share that refuses the open would otherwise produce
      // a click that silently does nothing.
      const openError = await shell.openPath(resolved);
      if (openError) throw new Error(openError);
      return null;
    },
  );
}

/**
 * The Claude layer's state, reported without ever naming the key.
 *
 * Built here rather than in secrets.ts so the storage layer stays ignorant of
 * which model it is holding a key for.
 */
async function claudeStatus(): Promise<ClaudeStatus> {
  const status = await secretStatus();
  return {
    storageAvailable: status.available,
    hasKey: status.hasKey,
    reason: status.reason,
    model: CLAUDE_MODEL,
  };
}

app.whenReady().then(async () => {
  registerHandlers();

  // Before any vault opens, so the first one already knows which folders it
  // must not copy out of. Discovery reads the environment and shells out to
  // `reg` once; failure is silent and simply means no folder is treated as
  // synced, which is how the app behaved before this existed.
  try {
    service.useSyncedRoots(await discoverSyncedRoots());
  } catch (err) {
    console.error("[main] could not discover synced folders:", err);
  }

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

  // Before the window exists, not after it loads. See theme.ts: a palette
  // applied once the renderer has painted is a flash of the wrong scheme on
  // every launch, and it also decides the backgroundColor createWindow() reads.
  await applySavedTheme();

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
