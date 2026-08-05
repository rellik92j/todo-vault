import { promises as fs } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import chokidar, { type FSWatcher } from "chokidar";
import {
  syncedRootFor,
  Vault,
  type BulkUpdateResult,
  type DeleteResult,
  type HistoryPage,
  type HistoryQuery,
  type Item,
  type Project,
  type Status,
  type TrashEntry,
} from "todo-vault";

import type { AgendaScope, AgendaView, ProjectSummary, VaultSnapshot } from "../shared/api.js";

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    // A missing path is not a directory; addAttachment reports it properly.
    return false;
  }
}

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

  /**
   * Tail of the serialized work queue. Every write, every reload and every
   * snapshot joins it, so no two of them are ever in flight at once.
   *
   * The vault's in-memory index is shared mutable state, and the watcher fires
   * on this app's *own* writes: attaching four dropped files runs four writes
   * and four `git commit`s inside one call, which is long enough for the
   * debounced reload below to land in the middle of it. That reload re-reads
   * the item as it was two files ago and puts it back in the index, so the next
   * file in the batch is written on top of stale state and the ones between are
   * lost. Serializing is the fix: a reload waits for the batch to finish, by
   * which point it reads the finished article.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` once everything already queued has settled.
   *
   * The tail swallows rejections so one failed write does not poison every
   * operation after it — the caller still gets the rejection, via `run`.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get root(): string | undefined {
    return this.vault?.root;
  }

  get isOpen(): boolean {
    return this.vault !== undefined;
  }

  /**
   * OneDrive/SharePoint sync roots, discovered once at startup and handed to
   * every Vault this service opens. Empty until `useSyncedRoots` is called, so
   * a vault opened before discovery finishes simply behaves as it did before.
   */
  private syncedRoots: string[] = [];

  /** Auto-commit is always on. Deletes go to .trash regardless, but history is free. */
  private get options(): { git: true; syncedRoots: string[] } {
    return { git: true, syncedRoots: this.syncedRoots };
  }

  useSyncedRoots(roots: string[]): void {
    this.syncedRoots = roots;
  }

  /** Which sync root holds this path, if any — the drop handler asks before copying. */
  syncedRootFor(target: string): string | undefined {
    return syncedRootFor(target, this.syncedRoots);
  }

  async open(root: string): Promise<VaultSnapshot> {
    const vault = await Vault.open(root, this.options);
    await this.attach(vault);
    return this.snapshot();
  }

  async init(root: string): Promise<VaultSnapshot> {
    const vault = await Vault.init(root, this.options);
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
      // One queue slot for the whole thing, not one per step: `readSnapshot`
      // reloads for itself, and re-entering `serialize` here would deadlock.
      const snapshot = await this.serialize(async () => {
        await this.requireVault().load();
        return this.readSnapshot();
      });
      this.emit("changed", snapshot);
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

  /**
   * The queued entry point. Callers outside this class use this one, so a
   * snapshot can never be read out of the middle of a half-finished write.
   */
  async snapshot(): Promise<VaultSnapshot> {
    return this.serialize(() => this.readSnapshot());
  }

  /** The body of `snapshot`, for callers that already hold the queue slot. */
  private async readSnapshot(): Promise<VaultSnapshot> {
    const vault = this.requireVault();
    const { errors } = await vault.load();

    // listProjects() is unfiltered by design, so hidden projects arrive here
    // like any other. `hidden` is decoded once, here, and the renderer works
    // from that — nothing over the boundary needs to know that "archived" is
    // the value carrying it.
    const projects: ProjectSummary[] = vault.listProjects().map((project) => ({
      ...project,
      openItems: vault.listItems({ project: project.key, open: true, limit: 500 }).total,
      totalItems: vault.listItems({ project: project.key, limit: 500 }).total,
      hidden: project.status === "archived",
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
        bands: section.bands,
        keys: section.items.map((i) => i.key),
      }));
  }

  /**
   * Everything else in the vault that points at this item, or that it points at.
   *
   * The `linked` map is the part the renderer cannot work out for itself: an
   * `item` link is a key, and the only list the panel has is the one this
   * window admits exists. Resolving here means a link into a hidden project
   * still reports its real status, at the price of this panel showing
   * relationships across a boundary every other view honours — which is the
   * bargain `backlinks` already struck, since it does not filter them either.
   *
   * `hasItem` rather than a try around `getItem`, in both places: `children`
   * and `backlinks` return empty for a key that is gone rather than throwing,
   * and a panel still open on an item deleted a moment ago should keep getting
   * an answer rather than an error banner on its way out.
   */
  getRelated(key: string): {
    children: Item[];
    backlinks: Item[];
    linked: Record<string, Status | null>;
  } {
    const vault = this.requireVault();
    const linked: Record<string, Status | null> = {};
    const links = vault.hasItem(key) ? vault.getItem(key).links : [];
    for (const link of links) {
      if (link.type !== "item") continue;
      linked[link.target] = vault.hasItem(link.target)
        ? vault.getItem(link.target).status
        : null;
    }
    return { children: vault.children(key), backlinks: vault.backlinks(key), linked };
  }

  /**
   * A page of commits. The one read here that deliberately skips `serialize`.
   *
   * `git log` reads the object database, which auto-commit only ever appends
   * to, and touches neither the working tree nor the in-memory index — the two
   * things the queue exists to protect. Queuing it would make History wait
   * behind a batch of attachment writes for an answer none of them can change.
   * `listTrash` is queued for the opposite reason: it reads the working tree,
   * which a write is part-way through rewriting.
   */
  getHistory(query: HistoryQuery): Promise<HistoryPage> {
    return this.requireVault().history(query);
  }

  // ----------------------------------------------------------- mutations

  /**
   * Reload before every write, then hand the vault to the caller.
   *
   * The MCP server does the same thing for the same reason: an external Claude
   * may have changed a file since this process last read it, and writing back
   * stale state would clobber it. Last-write-wins is the accepted trade, but
   * only over state that was fresh a moment ago.
   */
  private async write<T>(fn: (vault: Vault) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      const vault = this.requireVault();
      await vault.load();
      return fn(vault);
    });
  }

  createItem(input: unknown): Promise<Item> {
    return this.write((v) => v.createItem(input));
  }

  updateItem(key: string, patch: unknown): Promise<Item> {
    return this.write((v) => v.updateItem(key, patch));
  }

  updateItems(keys: string[], patch: unknown): Promise<BulkUpdateResult> {
    return this.write((v) => v.updateItems(keys, patch));
  }

  transition(key: string, status: Status): Promise<Item> {
    return this.write((v) => v.transition(key, status));
  }

  tick(key: string, on: string | undefined, undo: boolean): Promise<Item> {
    return this.write((v) => (undo ? v.untickItem(key, on) : v.tickItem(key, on)));
  }

  moveItem(key: string, position: { after?: string; before?: string }): Promise<Item> {
    return this.write((v) => v.moveItem(key, position));
  }

  addComment(key: string, body: string): Promise<Item> {
    return this.write((v) => v.addComment(key, body));
  }

  addLink(key: string, link: { type: string; target: string; label?: string }): Promise<Item> {
    return this.write((v) => v.addLink(key, link));
  }

  removeLink(key: string, target: string): Promise<Item> {
    return this.write((v) => v.removeLink(key, target));
  }

  /**
   * Attach several paths at once, routing each one by what it actually is.
   *
   * `downgradeSynced` is the difference between a drop and the file picker.
   * A drop is a gesture with no dialog behind it, so a file living in OneDrive
   * is linked in place and the renderer says so — failing the whole drop over
   * something the user could not have known would be hostile. The picker had
   * an explicit "Copy in" button, so there the core's refusal is the right
   * answer and travels to the error toast unchanged.
   *
   * Directories are routed to `folder` links rather than thrown at
   * `addAttachment`, which only accepts files — before this, dropping a folder
   * failed the entire drop (gotcha 9).
   */
  async attachPaths(
    key: string,
    paths: string[],
    copy: boolean,
    downgradeSynced = false,
  ): Promise<{ item: Item; linkedInstead: string[] }> {
    return this.write(async (v) => {
      let item = v.getItem(key);
      const linkedInstead: string[] = [];

      for (const source of paths) {
        const abs = path.resolve(source);
        if (await isDirectory(abs)) {
          item = await v.addLink(key, { type: "folder", target: abs, label: path.basename(abs) });
          continue;
        }

        const synced = copy && downgradeSynced && this.syncedRootFor(abs) !== undefined;
        if (synced) linkedInstead.push(abs);
        item = await v.addAttachment(key, abs, { copy: copy && !synced });
      }

      return { item, linkedInstead };
    });
  }

  deleteItem(key: string, cascade: boolean): Promise<DeleteResult[]> {
    return this.write((v) => v.deleteItem(key, { cascade }));
  }

  restoreItem(file: string): Promise<Item> {
    return this.write((v) => v.restoreItem(file));
  }

  listTrash(): Promise<TrashEntry[]> {
    return this.write((v) => v.listTrash());
  }

  createProject(input: {
    key: string;
    name: string;
    description?: string;
    category?: string;
    lead?: string;
  }): Promise<Project> {
    return this.write((v) => v.createProject(input));
  }

  updateProject(key: string, patch: unknown): Promise<Project> {
    return this.write((v) => v.updateProject(key, patch));
  }

  moveProject(key: string, position: { after?: string; before?: string }): Promise<Project> {
    return this.write((v) => v.moveProject(key, position));
  }

  hideProject(key: string): Promise<Project> {
    return this.write((v) => v.hideProject(key));
  }

  unhideProject(key: string): Promise<Project> {
    return this.write((v) => v.unhideProject(key));
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
