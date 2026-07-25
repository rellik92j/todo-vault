import type { VaultApi } from "./api.js";

declare global {
  interface Window {
    /** Exposed by the preload via contextBridge. The renderer's only way in. */
    vault: VaultApi;
  }
}
