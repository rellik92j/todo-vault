import type {
  AgendaSection,
  BulkUpdateInput,
  CreateItemInput,
  DeleteResult,
  GitStatus,
  HistoryPage,
  HistoryQuery,
  Item,
  ItemFilter,
  Project,
  Status,
  TrashEntry,
  UpdateItemInput,
  UpdateProjectInput,
} from "todo-vault";

/**
 * The contract between the main process and the renderer.
 *
 * The renderer never touches the vault: `Vault` imports node:fs and
 * node:child_process, so it lives in main and everything crosses this boundary.
 * Keeping the shape in one file shared by both sides means a channel cannot
 * drift out of sync with its handler without the typecheck noticing.
 */

/**
 * Every call returns one of these rather than throwing.
 *
 * Structured clone strips the VaultError class and its `name` on the way across
 * IPC, so an Error would arrive as a shapeless object. The core's messages are
 * already written for a human — "Cannot move an item from todo to in_review.
 * From todo you can go to: ..." — so they are worth carrying deliberately.
 */
export type Result<T> = { ok: true; value: T } | { ok: false; message: string };

export interface ProjectSummary extends Project {
  openItems: number;
  totalItems: number;
  /**
   * Whether this project is hidden from the sidebar.
   *
   * Derived in main from `status === "archived"`, so the renderer never learns
   * the encoding and never has to remember which of the four status values is
   * load-bearing. The raw `status` still comes across on the Project fields —
   * this is the interpretation of it, not a replacement for it.
   */
  hidden: boolean;
}

/**
 * The whole vault, sent after every read and every mutation.
 *
 * Reconciling per-item deltas would be a bug farm for no gain at this size —
 * `load()` already rebuilds the entire index on any change.
 */
export interface VaultSnapshot {
  root: string;
  projects: ProjectSummary[];
  items: Item[];
  /** Files that failed to parse. Surfaced in the UI; otherwise items vanish silently. */
  errors: string[];
  git: GitStatus;
  trashCount: number;
  loadedAt: string;
}

/** Agenda sections carry keys, not items, so the payload does not duplicate the snapshot. */
export interface AgendaView {
  kind: AgendaSection["kind"];
  scope: AgendaSection["scope"];
  from?: string;
  to?: string;
  /**
   * Display subdivisions of a long `due` window, straight from the core.
   *
   * Passed through untouched rather than derived here for the reason stated in
   * `Agenda.tsx` about the window itself: which dates count as "this week"
   * depends on today's date, so the core owns it and the renderer draws it.
   */
  bands?: AgendaSection["bands"];
  keys: string[];
}

/**
 * Re-exported rather than restated. This used to be its own hand-written union
 * and drifting from the core's was a matter of time — adding a scope there and
 * forgetting here would have typechecked cleanly right up to the `<select>`.
 */
export type AgendaScope = AgendaSection["scope"];

/** Null when no vault has been chosen yet — the renderer shows the picker. */
export type MaybeSnapshot = VaultSnapshot | null;

/**
 * Whether the optional Claude layer can be used, and why not when it cannot.
 *
 * Deliberately says nothing about the key itself beyond whether one exists. The
 * key lives in main, encrypted by safeStorage, and never crosses this boundary
 * in either direction except on the way in — there is no getter.
 */
export interface ClaudeStatus {
  /** safeStorage can actually encrypt on this machine. False means no key can be stored. */
  storageAvailable: boolean;
  hasKey: boolean;
  /** Written for a human, shown in the UI when the layer is unavailable. */
  reason?: string;
  /** Surfaced so the UI can name what it is about to call. */
  model: string;
}

/**
 * A proposed item, rendered for confirmation and never written directly.
 *
 * `input` has already been validated against the core's CreateItemInput in main,
 * so anything that reaches the renderer is something the vault would accept. The
 * confirmation step is about intent, not validity.
 */
export interface ItemDraft {
  input: CreateItemInput;
  /** What Claude assumed or could not determine. Shown above the form. */
  notes: string;
}

export interface VaultApi {
  /** Current snapshot, or null if no vault is configured yet. */
  getSnapshot(): Promise<Result<MaybeSnapshot>>;
  /** Native folder picker. Null when the dialog was cancelled. */
  chooseVault(): Promise<Result<MaybeSnapshot>>;
  /** Open a specific path, for the "use the example vault" shortcut. */
  openVault(root: string): Promise<Result<MaybeSnapshot>>;
  /** Create a vault in an empty folder, so a first run is not a dead end. */
  initVault(root: string): Promise<Result<MaybeSnapshot>>;
  /** Re-read from disk. The watcher does this automatically; this is the manual nudge. */
  reload(): Promise<Result<MaybeSnapshot>>;

  listItems(filter: Partial<ItemFilter>): Promise<Result<{ total: number; items: Item[] }>>;
  getAgenda(scope: AgendaScope): Promise<Result<AgendaView[]>>;
  /**
   * Children, backlinks, and the statuses behind this item's `item` links, for
   * the detail panel.
   *
   * `links` records a key, not an item, so a status has to be resolved from
   * somewhere and the renderer is the wrong place: it holds `visibleItems`,
   * which drops hidden projects, so a link pointing into one would resolve to
   * nothing and the absent pill would read as "no status" rather than "not
   * shown here". Main holds the whole vault, so it resolves them here — which
   * is what `backlinks` already does, unfiltered, for the same panel.
   *
   * `null` means the target is gone. `addLink` validates that it exists and
   * `doctor` checks for dangling item links anyway, because deleting the other
   * end still happens.
   */
  getRelated(key: string): Promise<
    Result<{
      children: Item[];
      backlinks: Item[];
      linked: Record<string, Status | null>;
    }>
  >;

  /**
   * A page of vault commits with their changes read back into vault terms.
   *
   * Pass `key` for one item's history, `project` to scope the global view, or
   * neither for the whole vault. `hasMore` on the result drives "Load more".
   */
  getHistory(query: HistoryQuery): Promise<Result<HistoryPage>>;

  /** Reveal an item's markdown, or an attachment, in the OS file manager. */
  revealPath(target: { kind: "item" | "attachment" | "vault"; value?: string }): Promise<Result<null>>;

  /**
   * Open a `file`/`folder` link, an attachment, or an external URL with the OS
   * default handler. Distinct from revealPath: this opens the target itself
   * rather than showing its containing folder, so it refuses executable
   * extensions and checks the external scheme allowlist rather than reusing
   * revealPath's vault-containment guard, which a `file` link is by definition
   * outside of.
   */
  openTarget(target: {
    kind: "attachment" | "file" | "folder" | "external";
    value: string;
  }): Promise<Result<null>>;

  // ------------------------------------------------------------- mutations
  // Each returns a fresh snapshot, so the renderer never reconciles a delta.

  createItem(input: CreateItemInput): Promise<Result<{ snapshot: VaultSnapshot; key: string }>>;
  updateItem(key: string, patch: UpdateItemInput): Promise<Result<VaultSnapshot>>;
  /**
   * Apply one patch to many items as a single commit — the backlog table's
   * multi-select. `updated`/`skipped` mirror BulkUpdateResult so the bar can
   * report "10 updated, 2 skipped" without reconciling item-by-item; the
   * snapshot is still the whole vault, same as every other mutation here.
   */
  updateItems(
    keys: string[],
    patch: BulkUpdateInput,
  ): Promise<
    Result<{
      snapshot: VaultSnapshot;
      updated: number;
      skipped: Array<{ key: string; reason: string }>;
    }>
  >;
  transitionItem(key: string, status: Status): Promise<Result<VaultSnapshot>>;
  /**
   * Log a recurring item as done for one period, leaving its status alone.
   * `on` defaults to today; `undo` removes that date instead of adding it.
   */
  tickItem(key: string, on?: string, undo?: boolean): Promise<Result<VaultSnapshot>>;
  /** Manual reorder. Positions are list positions — see Vault.moveItem. */
  moveItem(
    key: string,
    position: { after?: string; before?: string },
  ): Promise<Result<VaultSnapshot>>;

  addComment(key: string, body: string): Promise<Result<VaultSnapshot>>;
  addLink(
    key: string,
    link: { type: string; target: string; label?: string },
  ): Promise<Result<VaultSnapshot>>;
  removeLink(key: string, target: string): Promise<Result<VaultSnapshot>>;

  /**
   * Opens a native file picker in main, then attaches what was chosen.
   *
   * "Copy in" here is an explicit choice, so a file inside a OneDrive folder
   * is refused rather than downgraded — the core's message reaches the error
   * toast and names the "Link" button as the way through.
   */
  attachViaDialog(key: string, copy: boolean): Promise<Result<MaybeSnapshot>>;
  /**
   * For paths dropped onto the window, whose real values the renderer resolved.
   *
   * Unlike the picker, a drop has no dialog behind it, so main routes each path
   * by what it is: directories become `folder` links, and files inside a synced
   * folder are linked in place rather than copied. `linkedInstead` names those,
   * so the panel can say what happened instead of silently doing something
   * other than what the gesture implied.
   */
  attachPaths(
    key: string,
    paths: string[],
    copy: boolean,
  ): Promise<Result<{ snapshot: VaultSnapshot; linkedInstead: string[] }>>;

  /**
   * Trash an item. Without `cascade` this fails when the item has children, and
   * the message lists them — the renderer turns that into a confirmation rather
   * than deciding on the user's behalf.
   */
  deleteItem(
    key: string,
    cascade: boolean,
  ): Promise<Result<{ snapshot: VaultSnapshot; trashed: DeleteResult[] }>>;
  restoreItem(file: string): Promise<Result<VaultSnapshot>>;
  listTrash(): Promise<Result<TrashEntry[]>>;

  createProject(input: {
    key: string;
    name: string;
    description?: string;
    category?: string;
    lead?: string;
  }): Promise<Result<VaultSnapshot>>;
  updateProject(key: string, patch: UpdateProjectInput): Promise<Result<VaultSnapshot>>;
  moveProject(
    key: string,
    position: { after?: string; before?: string },
  ): Promise<Result<VaultSnapshot>>;
  /**
   * Drop a project from the sidebar. Nothing is deleted and the CLI and MCP
   * server still list it — see Vault.hideProject.
   *
   * Fails while the project holds items that are not done or disregarded, and
   * the message names them. The sidebar disables the button before it gets that
   * far, so this is the backstop for the case where the last open item was
   * reopened from outside the app between render and click.
   */
  hideProject(key: string): Promise<Result<VaultSnapshot>>;
  unhideProject(key: string): Promise<Result<VaultSnapshot>>;

  // ------------------------------------------------------- optional Claude
  // Absent or unconfigured, every one of these still answers; the UI degrades
  // to the plain form rather than hiding it.

  claudeStatus(): Promise<Result<ClaudeStatus>>;
  /** One-way. There is no matching getter — the key never comes back out. */
  setClaudeKey(key: string): Promise<Result<ClaudeStatus>>;
  clearClaudeKey(): Promise<Result<ClaudeStatus>>;
  /**
   * Turn a sentence into a proposed item. Returns a draft for confirmation —
   * this never writes. `defaultProject` is the project the UI has in focus,
   * which Claude uses only when the prompt does not name one.
   */
  draftItem(prompt: string, defaultProject: string | null): Promise<Result<ItemDraft>>;

  /**
   * Real filesystem paths for dropped File objects. Electron removed
   * `File.path`, and `webUtils` is only reachable from the preload.
   */
  pathsForFiles(files: File[]): string[];

  /** Subscribe to disk changes. Returns an unsubscribe function. */
  onChanged(listener: (snapshot: VaultSnapshot) => void): () => void;

  /** Suggested starting point: the example vault shipped with the repo, if present. */
  getSuggestedVault(): Promise<Result<string | null>>;
}

/** Channel names, kept beside the interface so both sides agree. */
export const CHANNELS = {
  getSnapshot: "vault:get-snapshot",
  chooseVault: "vault:choose",
  openVault: "vault:open",
  initVault: "vault:init",
  reload: "vault:reload",
  listItems: "vault:list-items",
  getAgenda: "vault:get-agenda",
  getRelated: "vault:get-related",
  getHistory: "vault:get-history",
  revealPath: "vault:reveal-path",
  openTarget: "vault:open-target",
  getSuggestedVault: "vault:suggested",

  createItem: "vault:create-item",
  updateItem: "vault:update-item",
  updateItems: "vault:update-items",
  transitionItem: "vault:transition-item",
  tickItem: "vault:tick-item",
  moveItem: "vault:move-item",
  addComment: "vault:add-comment",
  addLink: "vault:add-link",
  removeLink: "vault:remove-link",
  attachViaDialog: "vault:attach-dialog",
  attachPaths: "vault:attach-paths",
  deleteItem: "vault:delete-item",
  restoreItem: "vault:restore-item",
  listTrash: "vault:list-trash",
  createProject: "vault:create-project",
  updateProject: "vault:update-project",
  moveProject: "vault:move-project",
  hideProject: "vault:hide-project",
  unhideProject: "vault:unhide-project",

  claudeStatus: "claude:status",
  setClaudeKey: "claude:set-key",
  clearClaudeKey: "claude:clear-key",
  draftItem: "claude:draft",

  /** main -> renderer push */
  changed: "vault:changed",
} as const;
