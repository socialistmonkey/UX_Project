const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;
const smokeArg = process.argv.find((a) => a.startsWith('--smoke='));
let pendingOpen = [];

app.setAboutPanelOptions({ applicationName: 'Image Bender', applicationVersion: app.getVersion(), copyright: 'Copyright © 2026 Luka Biniashvili', website: 'https://binicreative.art' });

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1020, minHeight: 640,
    backgroundColor: '#000000',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 12 },
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'src/ui/index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', async () => {
    for (const p of pendingOpen.splice(0)) win.webContents.send('open-path', p);
    if (smokeArg) runSmoke(smokeArg.slice(8));
  });
  win.on('closed', () => { win = null; });
}

const send = (cmd) => win && win.webContents.send('menu', cmd);

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: 'File', submenu: [
      { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Open as Raw Pixels…', accelerator: 'Shift+CmdOrCtrl+O', click: () => send('open-raw') },
      { label: 'Save File…', accelerator: 'CmdOrCtrl+S', click: () => send('export-file') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('close-tab') },
      ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { type: 'separator' },
      { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      { label: 'Go to Offset…', accelerator: 'CmdOrCtrl+G', click: () => send('goto') },
    ] },
    { label: 'View', submenu: [
      { label: 'Visual Mode', accelerator: 'CmdOrCtrl+1', click: () => send('mode-visual') },
      { label: 'Hex Mode', accelerator: 'CmdOrCtrl+2', click: () => send('mode-hex') },
      { type: 'separator' },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom-in') },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom-out') },
      { label: 'Fit to Window', accelerator: 'CmdOrCtrl+0', click: () => send('zoom-fit') },
      { type: 'separator' },
      { role: 'toggleDevTools' },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: () => send('shortcuts') },
      { label: 'Welcome Tour', click: () => send('tour') },
      { type: 'separator' },
      { label: 'Open Recipes Folder', click: () => { shell.openPath(recipesDir()); } },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('open-dialog', async (_e, kind) => {
  const filters = kind === 'json' ? [{ name: 'Recipe files', extensions: ['json'] }]
    : kind === 'any' ? [{ name: 'All files', extensions: ['*'] }]
    : [{ name: 'Images', extensions: ['bmp', 'tif', 'tiff', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ppm', 'pgm', 'pnm', 'ico'] }, { name: 'All files', extensions: ['*'] }];
  const r = await dialog.showOpenDialog(win, {
    properties: kind === 'any' ? ['openFile'] : ['openFile', 'multiSelections'], filters,
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), data: fs.readFileSync(p) }));
});

ipcMain.handle('read-file', async (_e, p) => ({ path: p, name: path.basename(p), data: fs.readFileSync(p) }));

// Picks "name-bent.ext", "name-bent-2.ext" ... so nothing is overwritten by accident
function freeName(dir, name) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let candidate = name, n = 1;
  while (fs.existsSync(path.join(dir, candidate))) { n++; candidate = `${base}-${n}${ext}`; }
  return candidate;
}

ipcMain.handle('save-file', async (_e, { name, data, dir }) => {
  const folder = dir && fs.existsSync(dir) ? dir : app.getPath('downloads');
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(folder, freeName(folder, name)) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('pick-dir', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, { title: title || 'Choose a folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
});
const IMG_EXT = new Set(['.bmp', '.tif', '.tiff', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ppm', '.pgm', '.pnm', '.ico']);
ipcMain.handle('list-dir', async (_e, dir) => fs.readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isFile() && !d.name.startsWith('.') && IMG_EXT.has(path.extname(d.name).toLowerCase()))
  .map((d) => ({ name: d.name, path: path.join(dir, d.name) }))
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })));
ipcMain.handle('write-in-dir', async (_e, { dir, name, data }) => {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, freeName(dir, name));
  fs.writeFileSync(out, Buffer.from(data));
  return out;
});
ipcMain.handle('save-text', async (_e, { name, text }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text);
  return r.filePath;
});

ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));

// ---- recipes: macro files dropped in one folder show up in the app ----
function recipesDir() {
  const dir = path.join(app.getPath('userData'), 'recipes');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    const bundled = path.join(__dirname, 'recipes');
    try { for (const f of fs.readdirSync(bundled)) fs.copyFileSync(path.join(bundled, f), path.join(dir, f)); } catch (e) { /* no bundled recipes */ }
  }
  return dir;
}
ipcMain.handle('recipes-list', async () => {
  const dir = recipesDir(), out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (j.format === 'image-bender-macro' && Array.isArray(j.steps) && j.steps.length) out.push({ file: f, name: j.name || f.replace(/\.json$/i, ''), note: j.note || '', steps: j.steps });
    } catch (e) { /* ignore files that are not recipes */ }
  }
  return out;
});
ipcMain.handle('recipes-add', async (_e, { name, text }) => {
  const dir = recipesDir(), out = path.join(dir, freeName(dir, name));
  fs.writeFileSync(out, text);
  return out;
});
ipcMain.handle('recipes-delete', async (_e, file) => { const p = path.join(recipesDir(), path.basename(file)); if (fs.existsSync(p)) fs.unlinkSync(p); return true; });
ipcMain.on('recipes-open', () => { shell.openPath(recipesDir()); });
let recipeTimer = null;
function watchRecipes() {
  try { fs.watch(recipesDir(), () => { clearTimeout(recipeTimer); recipeTimer = setTimeout(() => win && win.webContents.send('recipes-changed'), 250); }); } catch (e) { /* folder watching is optional */ }
}

app.on('open-file', (e, p) => { e.preventDefault(); if (win && win.webContents && !win.webContents.isLoading()) win.webContents.send('open-path', p); else pendingOpen.push(p); });

app.whenReady().then(() => {
  buildMenu();
  watchRecipes();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ---- developer smoke test: `electron . --smoke=test/smoke.js` runs a script inside the window, saves screenshots, exits
ipcMain.handle('smoke-shot', async (_e, file) => {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  return true;
});
async function runSmoke(script) {
  try {
    const code = fs.readFileSync(script, 'utf8');
    const result = await win.webContents.executeJavaScript(`(async () => { ${code} })()`);
    console.log('SMOKE RESULT ' + JSON.stringify(result));
    app.exit(0);
  } catch (e) { console.log('SMOKE ERROR ' + (e && e.stack || e)); app.exit(1); }
}
