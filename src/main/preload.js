'use strict';
// The renderer has no Node access. This is the entire surface it can reach —
// it can never touch the filesystem, the bot token or the engine directly.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatterlayer', {
  getState: () => ipcRenderer.invoke('chatterlayer:getState'),
  updateConfig: (patch) => ipcRenderer.invoke('chatterlayer:updateConfig', patch),
  setToken: (token) => ipcRenderer.invoke('chatterlayer:setToken', token),

  signIn: (token) => ipcRenderer.invoke('chatterlayer:signIn', token),
  start: (opts) => ipcRenderer.invoke('chatterlayer:start', opts),
  stop: () => ipcRenderer.invoke('chatterlayer:stop'),
  setSelected: (userIds) => ipcRenderer.invoke('chatterlayer:setSelected', userIds),
  setColor: (userId, color) => ipcRenderer.invoke('chatterlayer:setColor', { userId, color }),
  setAlias: (userId, alias) => ipcRenderer.invoke('chatterlayer:setAlias', { userId, alias }),
  clearCaptions: () => ipcRenderer.invoke('chatterlayer:clearCaptions'),

  modelCatalog: () => ipcRenderer.invoke('chatterlayer:modelCatalog'),
  installModel: (key) => ipcRenderer.invoke('chatterlayer:installModel', key),
  removeModel: (key) => ipcRenderer.invoke('chatterlayer:removeModel', key),
  onModelProgress: (cb) => ipcRenderer.on('chatterlayer:modelProgress', (_e, p) => cb(p)),

  copy: (text) => ipcRenderer.invoke('chatterlayer:copy', text),
  openExternal: (url) => ipcRenderer.invoke('chatterlayer:openExternal', url),
  revealConfig: () => ipcRenderer.invoke('chatterlayer:revealConfig'),

  onEvent: (cb) => ipcRenderer.on('chatterlayer:event', (_e, msg) => cb(msg)),
  onMembers: (cb) => ipcRenderer.on('chatterlayer:members', (_e, members) => cb(members)),
  onCaption: (cb) => ipcRenderer.on('chatterlayer:caption', (_e, caption) => cb(caption)),
});
