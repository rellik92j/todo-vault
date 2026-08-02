import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MaybeSnapshot, Result, VaultApi, VaultSnapshot } from "@shared/api";

/**
 * The renderer's whole data layer: one snapshot, replaced wholesale.
 *
 * No query cache, because there is no network and nothing to invalidate — main
 * pushes a fresh snapshot whenever disk changes, and every call returns the
 * whole thing. A cache here would only be a second copy to keep in sync.
 */

/** An offer to undo the last destructive action, shown as a toast. */
export interface UndoOffer {
  message: string;
  /** The trashed filename to hand back to restoreItem. */
  files: string[];
}

export interface VaultState {
  snapshot: VaultSnapshot | null;
  loading: boolean;
  /** Set when a call came back `ok: false`. Cleared on the next success. */
  error: string | null;
  busy: boolean;
  undo: UndoOffer | null;
  dismissError: () => void;
  dismissUndo: () => void;
  chooseVault: () => Promise<void>;
  openVault: (root: string) => Promise<void>;
  reload: () => Promise<void>;

  /**
   * Run a mutation and adopt the snapshot it returns.
   *
   * Resolves to the error message on failure rather than throwing, so callers
   * can react — the delete flow turns "has children" into a confirmation instead
   * of an error toast.
   */
  mutate: (
    call: () => Promise<Result<VaultSnapshot | MaybeSnapshot>>,
    options?: { undo?: UndoOffer },
  ) => Promise<string | null>;

  /**
   * Create and delete return more than a snapshot — the new key, and what went
   * to the trash — so they get their own helpers rather than bending `mutate`
   * into a generic that every other call site would have to unwrap.
   */
  createItem: (input: Record<string, unknown>) => Promise<string | null>;
  /**
   * Create a project. Returns only a snapshot, so it could have gone through
   * `mutate` — except that `mutate` surfaces a failure as the banner over the
   * main pane, and "Project ACME already exists" belongs in the dialog that is
   * still open, beside the field that caused it. So it keeps its error too.
   */
  createProject: (input: Parameters<VaultApi["createProject"]>[0]) => Promise<string | null>;
  deleteItem: (
    key: string,
    cascade: boolean,
  ) => Promise<{ error: string | null; files: string[] }>;
  /**
   * The backlog's bulk edit. Its own helper rather than a `mutate` call: a
   * successful write here still needs to report which keys were skipped and
   * why, which `mutate`'s plain-snapshot contract has nowhere to carry.
   */
  updateItems: (
    keys: string[],
    patch: Record<string, unknown>,
  ) => Promise<{
    error: string | null;
    updated: number;
    skipped: Array<{ key: string; reason: string }>;
  }>;
  restore: (files: string[]) => Promise<void>;
  /** Selects the item created by the last successful createItem, if any. */
  lastCreated: string | null;
}

export function useVault(): VaultState {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<UndoOffer | null>(null);
  const [lastCreated, setLastCreated] = useState<string | null>(null);

  /** Guards against a late reply from an abandoned call clobbering newer state. */
  const generation = useRef(0);

  const run = useCallback(
    async (call: () => Promise<Result<MaybeSnapshot>>, { silent = false } = {}) => {
      const mine = ++generation.current;
      if (!silent) setLoading(true);
      try {
        const result = await call();
        if (mine !== generation.current) return;
        if (result.ok) {
          setError(null);
          // Null means "no vault chosen" or "dialog cancelled". Only the former
          // should clear the view, and that only happens before one is open.
          if (result.value !== null || snapshot === null) setSnapshot(result.value);
        } else {
          setError(result.message);
        }
      } catch (err) {
        if (mine === generation.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [snapshot],
  );

  useEffect(() => {
    void run(() => window.vault.getSnapshot());
    // Deliberately once, on mount: this is the initial load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Disk changes arrive as pushes rather than polling.
  useEffect(() => {
    return window.vault.onChanged((incoming) => {
      generation.current += 1;
      setSnapshot(incoming);
      setLoading(false);
    });
  }, []);

  const mutate = useCallback<VaultState["mutate"]>(async (call, options) => {
    setBusy(true);
    try {
      const result = await call();
      if (!result.ok) {
        // Surfaced *and* returned. Most callers pass the result to `void`, so a
        // failure that is only returned goes unseen — which is how a rejected
        // reorder looked like a card that simply refused to move. Callers that
        // treat a refusal as a question (delete, with its cascade prompt) use
        // the dedicated helpers instead.
        setError(result.message);
        return result.message;
      }
      generation.current += 1;
      setError(null);
      if (result.value) setSnapshot(result.value);
      if (options?.undo) setUndo(options.undo);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const createItem = useCallback(async (input: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await window.vault.createItem(input as never);
      if (!result.ok) return result.message;
      generation.current += 1;
      setError(null);
      setSnapshot(result.value.snapshot);
      setLastCreated(result.value.key);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const createProject = useCallback<VaultState["createProject"]>(async (input) => {
    setBusy(true);
    try {
      const result = await window.vault.createProject(input);
      if (!result.ok) return result.message;
      generation.current += 1;
      setError(null);
      setSnapshot(result.value);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      setBusy(false);
    }
  }, []);

  const deleteItem = useCallback(async (key: string, cascade: boolean) => {
    setBusy(true);
    try {
      const result = await window.vault.deleteItem(key, cascade);
      if (!result.ok) return { error: result.message, files: [] };
      generation.current += 1;
      setError(null);
      setSnapshot(result.value.snapshot);

      const files = result.value.trashed.map((t) => t.trashedTo.split("/").pop() as string);
      const dangling = [...new Set(result.value.trashed.flatMap((t) => t.danglingBacklinks))];
      setUndo({
        message:
          `Trashed ${result.value.trashed.map((t) => t.key).join(", ")}.` +
          (dangling.length ? ` Still linked from ${dangling.join(", ")}.` : ""),
        files,
      });
      return { error: null, files };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), files: [] };
    } finally {
      setBusy(false);
    }
  }, []);

  const updateItems = useCallback(async (keys: string[], patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      const result = await window.vault.updateItems(keys, patch as never);
      if (!result.ok) return { error: result.message, updated: 0, skipped: [] };
      generation.current += 1;
      setError(null);
      setSnapshot(result.value.snapshot);
      return { error: null, updated: result.value.updated, skipped: result.value.skipped };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message, updated: 0, skipped: [] };
    } finally {
      setBusy(false);
    }
  }, []);

  const restore = useCallback(async (files: string[]) => {
    setBusy(true);
    try {
      // Deepest-first on the way out, so parents come back before their children.
      for (const file of [...files].reverse()) {
        const result = await window.vault.restoreItem(file);
        if (!result.ok) {
          setError(result.message);
          break;
        }
        generation.current += 1;
        setSnapshot(result.value);
      }
      setUndo(null);
    } finally {
      setBusy(false);
    }
  }, []);

  return useMemo<VaultState>(
    () => ({
      snapshot,
      loading,
      busy,
      error,
      undo,
      dismissError: () => setError(null),
      dismissUndo: () => setUndo(null),
      chooseVault: () => run(() => window.vault.chooseVault()),
      openVault: (root: string) => run(() => window.vault.openVault(root)),
      reload: () => run(() => window.vault.reload(), { silent: true }),
      mutate,
      createItem,
      createProject,
      deleteItem,
      updateItems,
      restore,
      lastCreated,
    }),
    [
      snapshot,
      loading,
      busy,
      error,
      undo,
      lastCreated,
      run,
      mutate,
      createItem,
      createProject,
      deleteItem,
      updateItems,
      restore,
    ],
  );
}
