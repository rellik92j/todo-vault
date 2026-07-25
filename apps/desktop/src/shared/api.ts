import type { AgendaSection, GitStatus, Item, ItemFilter, Project } from "todo-vault";

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
  keys: string[];
}

export type AgendaScope = "today" | "week" | "month";

/** Null when no vault has been chosen yet — the renderer shows the picker. */
export type MaybeSnapshot = VaultSnapshot | null;

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
  /** Children and backlinks for the detail panel. */
  getRelated(key: string): Promise<Result<{ children: Item[]; backlinks: Item[] }>>;

  /** Reveal an item's markdown, or an attachment, in the OS file manager. */
  revealPath(target: { kind: "item" | "attachment" | "vault"; value?: string }): Promise<Result<null>>;

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
  revealPath: "vault:reveal-path",
  getSuggestedVault: "vault:suggested",
  /** main -> renderer push */
  changed: "vault:changed",
} as const;
