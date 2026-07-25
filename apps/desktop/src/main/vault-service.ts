import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import chokidar, { type FSWatcher } from "chokidar";
import { Vault, type Item } from "todo-vault";

import type { AgendaScope, AgendaView, ProjectSummary, VaultSnapshot } from "../shared/api.js";

/**
 * Owns the single Vault instance, the file watcher, and snapshot production.
 *
 * Everything here runs in the main process. The renderer only ever sees the
 * plain-object snapshots this produces.
 */
export class VaultService extends EventEmitter {
  private vault: Vault | undefined;
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;

  get root(): string | undefined {
    return this.vault?.root;
  }

  get isOpen(): boolean {
    return this.vault !== undefined;
  }

  /** Auto-commit is always on. Deletes go to .trash regardless, but history is free. */
  private static options = { git: true } as const;

  async open(root: string): Promise<VaultSnapshot> {
    const vault = await Vault.open(root, VaultService.options);
    await this.attach(vault);
    return this.snapshot();
  }

  async init(root: string): Promise<VaultSnapshot> {
    const vault = await Vault.init(root, VaultService.options);
    await this.attach(vault);
    return this.snapshot();
  }

  private async attach(vault: Vault): Promise<void> {
    await this.stopWatching();
    this.vault = vault;
    this.startWatching(vault.root);
  }

  /** Manual refresh. `snapshot()` re-reads from disk itself. */
  async reload(): Promise<VaultSnapshot> {
    return this.snapshot();
  }

  private requireVault(): Vault {
    if (!this.vault) throw new Error("No vault is open");
    return this.vault;
  }

  // ------------------------------------------------------------- watching

  /**
   * Watch items/ and projects/ so an edit from outside the app — an external
   * Claude, or Notepad — shows up without a manual refresh.
   *
   * Debounced because a single logical change can produce several events: the
   * atomic write in the core creates a temp file and renames it, which fires
   * add plus unlink plus change in quick succession.
   */
  private startWatching(root: string): void {
    this.watcher = chokidar.watch(
      [path.join(root, "items"), path.join(root, "projects")],
      {
        ignoreInitial: true,
        // Temp files from writeFileAtomic are transient and never worth a reload.
        ignored: (candidate) => candidate.includes(".tmp-"),
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      },
    );

    const onChange = (): void => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => {
        void this.emitSnapshot();
      }, 150);
    };

    this.watcher.on("add", onChange);
    this.watcher.on("change", onChange);
    this.watcher.on("unlink", onChange);
    this.watcher.on("error", (err) => {
      console.error("[vault-service] watcher error:", err);
    });
  }

  private async emitSnapshot(): Promise<void> {
    if (!this.vault) return;
    try {
      await this.vault.load();
      this.emit("changed", await this.snapshot());
    } catch (err) {
      console.error("[vault-service] reload after a file change failed:", err);
    }
  }

  async stopWatching(): Promise<void> {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
  }

  // ------------------------------------------------------------ snapshots

  async snapshot(): Promise<VaultSnapshot> {
    const vault = this.requireVault();
    const { errors } = await vault.load();

    const projects: ProjectSummary[] = vault.listProjects().map((project) => ({
      ...project,
      openItems: vault.listItems({ project: project.key, open: true, limit: 500 }).total,
      totalItems: vault.listItems({ project: project.key, limit: 500 }).total,
    }));

    const { items } = vault.listItems({ limit: 500 });
    const trash = await vault.listTrash();

    return {
      root: vault.root,
      projects,
      items,
      errors,
      git: await vault.gitStatus(),
      trashCount: trash.length,
      loadedAt: new Date().toISOString(),
    };
  }

  listItems(filter: Record<string, unknown>): { total: number; items: Item[] } {
    return this.requireVault().listItems(filter);
  }

  /**
   * Agenda sections as item keys rather than items, so the payload does not
   * repeat what the snapshot already carries.
   */
  getAgenda(scope: AgendaScope): AgendaView[] {
    return this.requireVault()
      .agenda(scope)
      .map((section) => ({
        kind: section.kind,
        scope: section.scope,
        from: section.from,
        to: section.to,
        keys: section.items.map((i) => i.key),
      }));
  }

  getRelated(key: string): { children: Item[]; backlinks: Item[] } {
    const vault = this.requireVault();
    return { children: vault.children(key), backlinks: vault.backlinks(key) };
  }

  itemPath(key: string): string {
    return this.requireVault().itemPath(key);
  }

  resolveAttachment(stored: string): string {
    return this.requireVault().resolveAttachment(stored);
  }

  /**
   * Is this directory a vault? Used to decide between opening and offering to
   * initialise, so a first run on an empty folder is not a dead end.
   */
  static async looksLikeVault(root: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(root, "items"));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  static async isEmptyish(root: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(root);
      return entries.filter((e) => !e.startsWith(".")).length === 0;
    } catch {
      return false;
    }
  }
}
