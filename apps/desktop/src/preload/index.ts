import { contextBridge, ipcRenderer } from "electron";

import { CHANNELS, type VaultApi, type VaultSnapshot } from "../shared/api.js";

/**
 * The whole surface the renderer gets. No fs, no child_process, no ipcRenderer —
 * just these functions. Sandboxed, so this file is CJS by necessity: a sandboxed
 * preload cannot be an ES module.
 */
const api: VaultApi = {
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.getSnapshot),
  chooseVault: () => ipcRenderer.invoke(CHANNELS.chooseVault),
  openVault: (root) => ipcRenderer.invoke(CHANNELS.openVault, root),
  initVault: (root) => ipcRenderer.invoke(CHANNELS.initVault, root),
  reload: () => ipcRenderer.invoke(CHANNELS.reload),
  listItems: (filter) => ipcRenderer.invoke(CHANNELS.listItems, filter),
  getAgenda: (scope) => ipcRenderer.invoke(CHANNELS.getAgenda, scope),
  getRelated: (key) => ipcRenderer.invoke(CHANNELS.getRelated, key),
  revealPath: (target) => ipcRenderer.invoke(CHANNELS.revealPath, target),
  getSuggestedVault: () => ipcRenderer.invoke(CHANNELS.getSuggestedVault),

  onChanged: (listener: (snapshot: VaultSnapshot) => void) => {
    const wrapped = (_event: unknown, snapshot: VaultSnapshot): void => listener(snapshot);
    ipcRenderer.on(CHANNELS.changed, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.changed, wrapped);
  },
};

contextBridge.exposeInMainWorld("vault", api);
