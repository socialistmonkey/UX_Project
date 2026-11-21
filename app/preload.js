const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  openDialog: (kind) => ipcRenderer.invoke('open-dialog', kind),
  readFile: (p) => ipcRenderer.invoke('read-file', p),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  pickDir: (t) => ipcRenderer.invoke('pick-dir', t),
  listDir: (d) => ipcRenderer.invoke('list-dir', d),
  writeInDir: (o) => ipcRenderer.invoke('write-in-dir', o),
  saveText: (o) => ipcRenderer.invoke('save-text', o),
  reveal: (p) => ipcRenderer.send('reveal', p),
  recipesList: () => ipcRenderer.invoke('recipes-list'),
  recipesAdd: (o) => ipcRenderer.invoke('recipes-add', o),
  recipesDelete: (f) => ipcRenderer.invoke('recipes-delete', f),
  recipesOpen: () => ipcRenderer.send('recipes-open'),
  onRecipesChanged: (cb) => ipcRenderer.on('recipes-changed', () => cb()),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch (e) { return ''; } },
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenPath: (cb) => ipcRenderer.on('open-path', (_e, p) => cb(p)),
  platform: process.platform,
  ...(process.env.IMAGEBENDER_SMOKE ? { smokeShot: (f) => ipcRenderer.invoke('smoke-shot', f) } : {}),
});
