import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MaybeSnapshot, Result, VaultSnapshot } from "@shared/api";

/**
 * The renderer's whole data layer: one snapshot, replaced wholesale.
 *
 * No query cache, because there is no network and nothing to invalidate — main
 * pushes a fresh snapshot whenever disk changes, and every call returns the
 * whole thing. A cache here would only be a second copy to keep in sync.
 */
export interface VaultState {
  snapshot: VaultSnapshot | null;
  loading: boolean;
  /** Set when a call came back `ok: false`. Cleared on the next success. */
  error: string | null;
  dismissError: () => void;
  chooseVault: () => Promise<void>;
  openVault: (root: string) => Promise<void>;
  reload: () => Promise<void>;
}

export function useVault(): VaultState {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  return useMemo<VaultState>(
    () => ({
      snapshot,
      loading,
      error,
      dismissError: () => setError(null),
      chooseVault: () => run(() => window.vault.chooseVault()),
      openVault: (root: string) => run(() => window.vault.openVault(root)),
      reload: () => run(() => window.vault.reload(), { silent: true }),
    }),
    [snapshot, loading, error, run],
  );
}
