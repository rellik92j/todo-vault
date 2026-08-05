import { contextBridge, ipcRenderer, webUtils } from "electron";

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
  getHistory: (query) => ipcRenderer.invoke(CHANNELS.getHistory, query),
  revealPath: (target) => ipcRenderer.invoke(CHANNELS.revealPath, target),
  openTarget: (target) => ipcRenderer.invoke(CHANNELS.openTarget, target),
  getSuggestedVault: () => ipcRenderer.invoke(CHANNELS.getSuggestedVault),

  createItem: (input) => ipcRenderer.invoke(CHANNELS.createItem, input),
  updateItem: (key, patch) => ipcRenderer.invoke(CHANNELS.updateItem, key, patch),
  updateItems: (keys, patch) => ipcRenderer.invoke(CHANNELS.updateItems, keys, patch),
  transitionItem: (key, status) => ipcRenderer.invoke(CHANNELS.transitionItem, key, status),
  tickItem: (key, on, undo) => ipcRenderer.invoke(CHANNELS.tickItem, key, on, undo),
  moveItem: (key, position) => ipcRenderer.invoke(CHANNELS.moveItem, key, position),
  addComment: (key, body) => ipcRenderer.invoke(CHANNELS.addComment, key, body),
  addLink: (key, link) => ipcRenderer.invoke(CHANNELS.addLink, key, link),
  removeLink: (key, target) => ipcRenderer.invoke(CHANNELS.removeLink, key, target),
  attachViaDialog: (key, copy) => ipcRenderer.invoke(CHANNELS.attachViaDialog, key, copy),
  attachPaths: (key, paths, copy) => ipcRenderer.invoke(CHANNELS.attachPaths, key, paths, copy),
  deleteItem: (key, cascade) => ipcRenderer.invoke(CHANNELS.deleteItem, key, cascade),
  restoreItem: (file) => ipcRenderer.invoke(CHANNELS.restoreItem, file),
  listTrash: () => ipcRenderer.invoke(CHANNELS.listTrash),
  createProject: (input) => ipcRenderer.invoke(CHANNELS.createProject, input),
  updateProject: (key, patch) => ipcRenderer.invoke(CHANNELS.updateProject, key, patch),
  moveProject: (key, position) => ipcRenderer.invoke(CHANNELS.moveProject, key, position),
  hideProject: (key) => ipcRenderer.invoke(CHANNELS.hideProject, key),
  unhideProject: (key) => ipcRenderer.invoke(CHANNELS.unhideProject, key),

  // The key goes one way only: there is deliberately no getClaudeKey here, so
  // nothing in the renderer can read back what was stored.
  claudeStatus: () => ipcRenderer.invoke(CHANNELS.claudeStatus),
  setClaudeKey: (key) => ipcRenderer.invoke(CHANNELS.setClaudeKey, key),
  clearClaudeKey: () => ipcRenderer.invoke(CHANNELS.clearClaudeKey),
  draftItem: (prompt, defaultProject) =>
    ipcRenderer.invoke(CHANNELS.draftItem, prompt, defaultProject),

  /**
   * Real filesystem paths for dropped files.
   *
   * `File.path` was removed from Electron, so this is the only way to learn where
   * a dropped file actually lives — and it has to happen in the preload, since
   * webUtils is not exposed to the renderer.
   */
  pathsForFiles: (files) => files.map((file) => webUtils.getPathForFile(file)),

  onChanged: (listener: (snapshot: VaultSnapshot) => void) => {
    const wrapped = (_event: unknown, snapshot: VaultSnapshot): void => listener(snapshot);
    ipcRenderer.on(CHANNELS.changed, wrapped);
    return () => ipcRenderer.removeListener(CHANNELS.changed, wrapped);
  },
};

contextBridge.exposeInMainWorld("vault", api);
