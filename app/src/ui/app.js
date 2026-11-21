/* App: tabs, history plumbing, file I/O, toasts, modals, the file map. */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const hex = DB.hex;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const App = {
  tabs: [], tab: null, rtab: 'tool', mode: 'visual', clip: null, clipText: '',
  nextId: 1,

  // ------------------------------------------------------------------ messages
  toast(msg, kind) {
    for (const old of $$('#toasts .toast')) if (old.textContent === msg) old.remove(); // no stacks of identical toasts
    const t = document.createElement('div');
    t.className = 'toast ' + (kind || '');
    t.textContent = msg;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 6500 : 3500);
  },
  status(msg) { $('#stMsg').innerHTML = msg; },

  // One input (input: true), or several (fields: [{id, label, value, options?}]). Resolves to the text, an object, true, or null.
  modal({ title, text, input, value, ok, cancel, type, fields }) {
    return new Promise((resolve) => {
      const m = $('#modal');
      const fh = fields ? fields.map((f) => `<label class="mf"><span>${esc(f.label)}</span>${f.options ? `<select data-f="${f.id}">${f.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(f.value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>` : `<input data-f="${f.id}" type="${f.type || 'text'}" value="${esc(f.value == null ? '' : f.value)}" spellcheck="false">`}</label>`).join('') : '';
      m.innerHTML = `<div class="box"><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${input ? `<input id="mIn" type="${type || 'text'}" value="${esc(value || '')}" spellcheck="false">` : ''}${fh}
        <div class="btnrow"><button id="mNo">${esc(cancel || 'Cancel')}</button><button id="mOk" class="primary">${esc(ok || 'OK')}</button></div></div>`;
      m.classList.add('open');
      const result = () => { if (fields) { const o = {}; $$('[data-f]', m).forEach((el) => (o[el.dataset.f] = el.value)); return o; } return input ? $('#mIn').value : true; };
      const done = (v) => { m.classList.remove('open'); m.innerHTML = ''; document.removeEventListener('keydown', key, true); resolve(v); };
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); done(null); }
        if (e.key === 'Enter') { e.preventDefault(); done(result()); }
        e.stopPropagation();
      };
      document.addEventListener('keydown', key, true);
      $('#mNo').onclick = () => done(null);
      $('#mOk').onclick = () => done(result());
      const el = $('#mIn') || $('[data-f]', m) || $('#mOk');
      el.focus(); if (el.select) el.select();
    });
  },

  // ------------------------------------------------------------------ opening
  async openFiles(list) {
    for (const f of list) await App.openBytes(new Uint8Array(f.data), f.name, f.path);
  },
  async openDialog() { App.openFiles(await api.openDialog()); },

  // Open bytes as a Doc. Formats the editor can't touch directly (WebP, AVIF ...) are converted to BMP first.
  async docFromBytes(bytes, name) {
    try { return { doc: await DB.open(bytes, name), converted: false }; }
    catch (e) {
      if (!(e instanceof DB.Unsupported)) throw e;
      if (DB.sniff(bytes) === 'webp' || DB.sniff(bytes) === null) {
        const px = await App.decodeToPixels(bytes);
        if (px) return { doc: await DB.open(DB.buildBMP(px.data, px.w, px.h), name.replace(/\.[^.]+$/, '') + '.bmp'), converted: true };
      }
      throw e;
    }
  },

  async openBytes(bytes, name, path) {
    try {
      const { doc, converted } = await App.docFromBytes(bytes, name);
      if (converted) { App.toast(`${name.split('.').pop().toUpperCase()} can't be edited safely directly, so it was converted to BMP.`, 'good'); path = undefined; }
      const tab = { id: App.nextId++, doc, name: doc.name, path, sel: null, hexSel: null, hexCur: null, hexTop: 0, zoom: null, tool: null, pending: null, undoMark: 0 };
      App.tabs.push(tab);
      await App.activate(tab);
    } catch (e) {
      if (e instanceof DB.Unsupported && DB.sniff(bytes) === null) { await App.offerRaw(bytes, name, path); return; }
      console.error(e);
      App.toast(e instanceof DB.Unsupported ? e.message : 'Could not open ' + name + ': ' + e.message, 'bad');
    }
  },

  // ------------------------------------------------------------------ raw pixels (any file)
  async openRawDialog() { const f = (await api.openDialog('any'))[0]; if (f) await App.openRaw(new Uint8Array(f.data), f.name, f.path); },
  async offerRaw(bytes, name, path) {
    const ok = await App.modal({ title: 'Not a picture Image Bender knows', text: `“${esc(name)}” isn't a supported image. You can still open it as raw pixels: every byte becomes a colour, and you can corrupt it like any picture.`, ok: 'Open as raw pixels…' });
    if (ok) await App.openRaw(bytes, name, path);
  },
  async openRaw(bytes, name, path) {
    const v = await App.modal({ title: 'Open as raw pixels', text: 'Pick how to read the bytes. The wrong width is half the fun: change it later with the Wrong width tool.', fields: [
      { id: 'w', label: 'Width (pixels)', type: 'number', value: String(Math.max(8, Math.round(Math.sqrt(bytes.length / 3)))) },
      { id: 'f', label: 'Pixel format', value: 'rgb', options: Object.entries(DB.RAW_FORMATS).map(([k, x]) => [k, x.label]) },
      { id: 'l', label: 'Lock the first … bytes', type: 'number', value: '0' }], ok: 'Open' });
    if (!v) return;
    try {
      const doc = DB.openRaw(bytes, name, { width: +v.w, format: v.f, lock: +v.l });
      const tab = { id: App.nextId++, doc, name: doc.name, path, sel: null, hexSel: null, hexCur: null, hexTop: 0, zoom: null, tool: null, pending: null, undoMark: 0 };
      App.tabs.push(tab); await App.activate(tab);
    } catch (e) { App.toast(e.message, 'bad'); }
  },

  // Another image to mix in: its picture (any size) and its raw bytes
  async loadSource(file) {
    const bytes = new Uint8Array(file.data);
    const px = await App.decodeToPixels(bytes);
    let raw = bytes;
    try { const o = await DB.open(bytes, file.name); raw = o.view().slice(); if (!px) throw new Error('no picture'); } catch (e) { /* keep file bytes */ }
    if (!px && !raw.length) { App.toast('Could not read that image.', 'bad'); return null; }
    const src = DB.makeSource(px ? px.data : new Uint8ClampedArray(4), px ? px.w : 1, px ? px.h : 1, raw, file.name);
    src.path = file.path || '';
    return src;
  },

  async decodeToPixels(bytes) {
    try {
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
      const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
      return { data: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
    } catch (e) { return null; }
  },

  // Pixels of what is currently shown (for Convert / Bake / Save picture)
  async currentPixels(tab) {
    const L = tab.doc.layout;
    if (L.kind === 'raster') { const out = new Uint8ClampedArray(L.width * L.height * 4); tab.doc.h.render(tab.doc, out, 0, L.height); return { data: out, w: L.width, h: L.height }; }
    const c = $('#cv'), x = c.getContext('2d');
    return { data: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
  },

  async convert(kind) {
    const tab = App.tab; if (!tab) return;
    App.clearPending();
    const px = await App.currentPixels(tab), base = tab.name.replace(/\.[^.]+$/, '');
    let bytes, name;
    if (kind === 'jpegrst') {
      const v = await App.modal({ title: 'JPEG made of blocks', text: 'Makes a new JPEG cut into small independent blocks. The “Shuffle JPEG blocks” tool can then reorder, repeat or empty them and the file still opens.', fields: [
        { id: 'q', label: 'Quality (1–100)', value: '85', type: 'number' },
        { id: 'r', label: 'Block size (MCUs per block)', value: '4', type: 'number' },
        { id: 's', label: 'Colour detail', value: 'full', options: [['full', 'Full (4:4:4)'], ['half', 'Half (4:2:0)']] }], ok: 'Make JPEG' });
      if (!v) return;
      Visual.busy(true); await new Promise((r) => setTimeout(r, 30));
      try { bytes = DB.encodeJPEG(px.data, px.w, px.h, { quality: +v.q || 85, restart: Math.max(1, +v.r || 4), subsample: v.s === 'half' }); } finally { Visual.busy(false); }
      name = base + '-blocks.jpg';
    }
    else if (kind === 'genloss') {
      const v = await App.modal({ title: 'Generation loss', text: 'Saves the picture as a JPEG again and again, like a photo copied through many hands. Each pass adds blocking and colour bleed.', fields: [
        { id: 'n', label: 'Passes', value: '60', type: 'number' },
        { id: 'q', label: 'Quality of each pass (1–100)', value: '55', type: 'number' },
        { id: 'o', label: 'Move the picture 1px each pass', value: 'yes', options: [['yes', 'Yes (blocks pile up)'], ['no', 'No']] }], ok: 'Start' });
      if (!v) return;
      bytes = await App.generationLoss(px, Math.max(1, Math.min(500, +v.n || 60)), DB.clamp(+v.q || 55, 1, 100) / 100, v.o === 'yes');
      if (!bytes) return;
      name = base + '-loss.jpg';
    }
    else if (kind === 'bmp') { bytes = DB.buildBMP(px.data, px.w, px.h); name = base + '-copy.bmp'; }
    else if (kind === 'tiff') { bytes = DB.buildTIFF(px.data, px.w, px.h); name = base + '-copy.tif'; }
    else if (kind === 'ppm') { bytes = DB.buildPPM(px.data, px.w, px.h); name = base + '-copy.ppm'; }
    else if (kind === 'gif') { bytes = DB.buildGIF(px.data, px.w, px.h); name = base + '-copy.gif'; }
    else {
      const c = document.createElement('canvas'); c.width = px.w; c.height = px.h;
      c.getContext('2d').putImageData(new ImageData(px.data, px.w, px.h), 0, 0);
      let q = 0.9;
      if (kind === 'jpeg' || kind === 'webp') {
        const v = await App.modal({ title: kind === 'jpeg' ? 'Bake into a JPEG' : 'Copy as WebP', text: 'The current look becomes a brand-new file you can corrupt again. Lower quality = blockier, more fragile.', input: true, type: 'number', value: '85', ok: 'Make it' });
        if (v === null) return; q = DB.clamp(parseInt(v, 10) || 85, 1, 100) / 100;
      }
      const mime = kind === 'jpeg' ? 'image/jpeg' : kind === 'webp' ? 'image/webp' : 'image/png';
      const blob = await new Promise((r) => c.toBlob(r, mime, q));
      bytes = new Uint8Array(await blob.arrayBuffer()); name = base + (kind === 'jpeg' ? '-baked.jpg' : kind === 'webp' ? '-copy.webp' : '-copy.png');
    }
    await App.openBytes(bytes, name);
  },

  async generationLoss(px, rounds, q, nudge) {
    const w = px.w, h = px.h, c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: false });
    x.putImageData(new ImageData(px.data, w, h), 0, 0);
    let blob = null;
    Visual.busy(true);
    try {
      for (let i = 0; i < rounds; i++) {
        blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', q));
        if (i === rounds - 1) break;
        const bmp = await createImageBitmap(blob);
        x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
        const k = nudge ? [[1, 0], [0, 1], [-1, 0], [0, -1]][i % 4] : [0, 0];
        x.drawImage(bmp, k[0], k[1]); bmp.close();
        if (i % 4 === 0) { App.status(`Generation loss: pass ${i + 1} of ${rounds}`); await new Promise((r) => setTimeout(r)); }
      }
    } catch (e) { App.toast('Generation loss failed: ' + e.message, 'bad'); return null; }
    finally { Visual.busy(false); }
    return new Uint8Array(await blob.arrayBuffer());
  },

  // A normal PNG picture of what a doc looks like (used by batch and variations)
  async docToPNG(doc) {
    let data, w, h;
    const L = doc.layout;
    if (L.kind === 'raster') { w = L.width; h = L.height; data = new Uint8ClampedArray(w * h * 4); doc.h.render(doc, data, 0, h); }
    else {
      const bmp = await createImageBitmap(new Blob([await doc.exportBytes()]));
      const c0 = document.createElement('canvas'); c0.width = bmp.width; c0.height = bmp.height;
      const x0 = c0.getContext('2d'); x0.drawImage(bmp, 0, 0); w = bmp.width; h = bmp.height; data = x0.getImageData(0, 0, w, h).data; bmp.close();
    }
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(data, w, h), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  },
  // true if a compressed file still decodes (so a batch never saves a broken file)
  async decodes(bytes) { try { const b = await createImageBitmap(new Blob([bytes])); b.close(); return true; } catch (e) { return false; } },

  // ------------------------------------------------------------------ tabs
  async activate(tab) {
    if (App.tab && App.tab !== tab) { App.clearPending(); }
    App.tab = tab;
    $$('#toasts .toast').forEach((x) => x.remove());
    $('#empty').style.display = 'none';
    App.renderTabs();
    Tools.attach(tab);
    if (App.rtab !== 'tool') Panels.render();
    await Visual.attach(tab);
    Hex.attach(tab);
    App.applyMode();
    App.chrome();
    FileMap.draw();
    if (Visual.split.on) Visual.showSplit();
    Tour.maybeStart();
    App.status(tab.doc.undoStack.length ? `${tab.doc.undoStack.length} edit${tab.doc.undoStack.length === 1 ? '' : 's'} so far. Pick a tool on the left, or switch to Hex.` : 'Pick a recipe or tool on the left, drag on the picture to select an area, or switch to Hex.');
  },
  isModified(t) { return t.doc.isModified(); },
  renderTabs() {
    $('#tabs').innerHTML = '';
    for (const t of App.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t === App.tab ? ' on' : '');
      el.innerHTML = `${App.isModified(t) ? '<span class="dot"></span>' : ''}<span class="nm">${esc(t.name)}</span><span class="x" title="Close">✕</span>`;
      el.onclick = (e) => { if (e.target.classList.contains('x')) App.closeTab(t); else if (t !== App.tab) App.activate(t); };
      $('#tabs').appendChild(el);
    }
  },
  async closeTab(tab) {
    tab = tab || App.tab; if (!tab) return;
    if (App.isModified(tab)) {
      const ok = await App.modal({ title: 'Close without saving?', text: `“${esc(tab.name)}” has edits that haven't been exported.`, ok: 'Close tab' });
      if (!ok) return;
    }
    if (tab === App.tab) App.clearPending();
    const i = App.tabs.indexOf(tab); App.tabs.splice(i, 1);
    if (!App.tabs.length) { App.tab = null; $('#empty').style.display = 'flex'; App.renderTabs(); App.chrome(); Tools.attach(null); return; }
    App.activate(App.tabs[Math.max(0, i - 1)]);
  },

  chrome() {
    const t = App.tab, d = t && t.doc;
    $('#btnUndo').disabled = !d || !d.undoStack.length;
    $('#btnRedo').disabled = !d || !d.redoStack.length;
    $('#btnExport').disabled = !d; $('#btnConvert').disabled = !d; $('#btnCompare').disabled = !d; $('#btnSplit').disabled = !d;
    if (d) {
      const L = d.layout;
      $('#fileinfo').innerHTML = `<b>${esc(t.name)}</b> · ${d.h.label || d.format.toUpperCase()} · ${L.width}×${L.height} · ${DB.fmtBytes(d.buf.length)}`;
      $('#expFile').firstChild.textContent = `Save file (${DB.extFor(d).toUpperCase()}) `;
      const notes = d.notes.filter((n) => !t.notesSeen || !t.notesSeen.has(n));
      $('#notes').classList.toggle('show', notes.length > 0);
      $('#notes span').textContent = notes.join('  ');
    } else { $('#fileinfo').textContent = ''; $('#notes').classList.remove('show'); }
    $('#stRight').textContent = d ? `${d.undoStack.length} edit${d.undoStack.length === 1 ? '' : 's'}` : '';
    App.renderTabs();
  },

  setMode(m) {
    App.mode = m; App.applyMode();
    if (m === 'hex') { Hex.layoutChanged(); Hex.syncFromVisual(); }
    Visual.fitIfAuto();
    Tools.refreshPanel();
  },
  applyMode() {
    $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === App.mode));
    $('#hex').style.display = App.mode === 'hex' ? 'flex' : 'none';
    $('#visual').className = App.mode === 'hex' ? 'small' : 'stretch';
    Visual.fitIfAuto();
    if (App.mode === 'hex') Hex.layoutChanged();
  },

  // ------------------------------------------------------------------ editing plumbing
  clearPending() {
    const t = App.tab;
    if (!t || !t.pending) return;
    const p = t.pending; t.pending = null;
    t.doc.revertPatch(p);
    Visual.renderDirty(t, p); // raster repaints at once; compressed formats re-decode in the background
    FileMap.draw(); Hex.refresh();
  },

  // A finished edit: commit it, repaint, and (for compressed formats) make sure the file still decodes.
  async commit(patch, label, histLabel) {
    const t = App.tab, d = t.doc;
    if (!patch.label) patch.label = histLabel || (label || 'Edit').replace(/\.\s.*$/, '');
    if (!patch.entries.length) { App.toast('Nothing changed. Try a bigger selection or stronger settings.'); return false; }
    d.commit(patch);
    const ok = await Visual.renderDirty(t, patch);
    if (!ok) {
      d.undo(); await Visual.renderDirty(t, patch);
      App.toast('That edit would have made the file unreadable, so it was undone.', 'bad');
      App.chrome(); return false;
    }
    App.afterChange();
    if (label) App.status(esc(label));
    return true;
  },
  afterChange() {
    App.chrome(); Hex.refresh(); FileMap.draw(); Tools.refreshPanel(true);
    if (App.rtab !== 'tool') Panels.render();
  },
  async undo() {
    const t = App.tab; if (!t) return;
    if (t.pending) { App.clearPending(); Tools.afterCancel(); return; }
    const p = t.doc.undo(); if (!p) return;
    await Visual.renderDirty(t, p); App.afterChange(); App.status('Undone');
  },
  async redo() {
    const t = App.tab; if (!t) return;
    const p = t.doc.redo(); if (!p) return;
    await Visual.renderDirty(t, p); App.afterChange(); App.status('Redone');
  },

  // The selection a tool should use, whichever mode is active.
  selectionForOps() {
    const t = App.tab; if (!t) return null;
    if (App.mode === 'visual' || !t.hexSel || t.hexSel.b - t.hexSel.a <= 1) return t.sel; // a single byte is a cursor, not a selection
    return Hex.selectionAsOps() || t.sel;
  },

  // ------------------------------------------------------------------ export
  async exportFile() {
    const t = App.tab; if (!t) return;
    App.clearPending();
    try {
      const bytes = await t.doc.exportBytes();
      const ext = DB.extFor(t.doc);
      const base = t.name.replace(/\.[^.]+$/, '').replace(/-(copy|baked|bent)$/, '');
      const dir = t.path ? t.path.replace(/[\\/][^\\/]*$/, '') : undefined;
      const out = await api.saveFile({ name: `${base}-bent.${ext}`, data: bytes, dir });
      if (out) { App.toast('Saved ' + out.split(/[\\/]/).pop(), 'good'); t.lastSaved = out; }
    } catch (e) { App.toast('Could not save: ' + e.message, 'bad'); }
  },
  async exportPicture(kind) {
    const t = App.tab; if (!t) return;
    App.clearPending();
    const px = await App.currentPixels(t);
    const c = document.createElement('canvas'); c.width = px.w; c.height = px.h;
    c.getContext('2d').putImageData(new ImageData(px.data, px.w, px.h), 0, 0);
    const mime = kind === 'jpeg' ? 'image/jpeg' : kind === 'webp' ? 'image/webp' : 'image/png';
    const blob = await new Promise((r) => c.toBlob(r, mime, 0.95));
    const base = t.name.replace(/\.[^.]+$/, '').replace(/-(copy|baked|bent)$/, '');
    const dir = t.path ? t.path.replace(/[\\/][^\\/]*$/, '') : undefined;
    const out = await api.saveFile({ name: `${base}-bent.${kind === 'jpeg' ? 'jpg' : kind}`, data: new Uint8Array(await blob.arrayBuffer()), dir });
    if (out) App.toast('Saved ' + out.split(/[\\/]/).pop(), 'good');
  },

};

/* ---------------------------------------------------------------------------------------------
   File map: the whole file as one bar. Green = safe, grey = locked, white ticks = what you changed.
--------------------------------------------------------------------------------------------- */
const FileMap = {
  cv: null,
  selRange() {
    const t = App.tab; if (!t) return null;
    const d = t.doc, L = d.layout;
    if (App.mode === 'hex' && t.hexSel) return [t.hexSel.a, t.hexSel.b];
    if (!t.sel) return null;
    if (L.kind === 'raster') {
      const r = DB.normSel(L, t.sel, false); if (!r) return null;
      const lo = Math.min(L.flipY ? L.height - r.y - r.h : r.y, L.flipY ? L.height - r.y : r.y + r.h);
      const a = d.l2b(Math.max(0, (L.flipY ? L.height - r.y - r.h : r.y) * L.stride));
      const b = d.l2b(Math.min(d.length - 1, (L.flipY ? L.height - r.y : r.y + r.h) * L.stride - 1)) + 1;
      return [a, b];
    }
    const rg = DB.streamRange(d, t.sel);
    return [d.l2b(rg.a), d.l2b(Math.max(rg.a, rg.b - 1)) + 1];
  },
  draw() {
    const t = App.tab, c = $('#mapcv');
    FileMap.cv = c;
    if (!t) { c.getContext('2d').clearRect(0, 0, c.width, c.height); return; }
    const d = t.doc, dpr = window.devicePixelRatio || 1, W = Math.max(50, Math.floor(c.clientWidth * dpr));
    c.width = W; c.height = Math.floor(14 * dpr);
    const x = c.getContext('2d'), total = d.buf.length, H = c.height;
    x.fillStyle = '#1c1c1c'; x.fillRect(0, 0, W, H);
    for (const z of d.zones) {
      if (z.kind === 'locked') continue;
      const x0 = Math.floor((z.start / total) * W), x1 = Math.max(x0 + 1, Math.ceil((z.end / total) * W));
      x.fillStyle = z.kind === 'tables' ? '#4a4a4a' : '#8a8a8a';
      x.globalAlpha = 1;
      x.fillRect(x0, 0, x1 - x0, H);
    }
    x.globalAlpha = 1;
    // edits
    x.fillStyle = '#ffffff';
    let n = 0;
    for (const p of d.undoStack.concat(t.pending ? [t.pending] : [])) for (const e of p.entries) {
      if (e.k !== 'b') continue;
      x.fillRect(Math.floor((e.off / total) * W), 0, Math.max(1, Math.ceil((e.b.length / total) * W)), H);
      if (++n > 60000) break;
    }
    const sr = FileMap.selRange();
    if (sr) { x.strokeStyle = '#fff'; x.lineWidth = Math.max(1, dpr); const x0 = (sr[0] / total) * W, w = Math.max(3, ((sr[1] - sr[0]) / total) * W); x.strokeRect(x0 + .5, .5, w, H - 1); }
    $('#mapInfo').textContent = `${DB.fmtBytes(total)} · ${(d.length / total * 100).toFixed(d.length / total > 0.99 ? 2 : 1)}% editable`;
  },
  hover(e) {
    const t = App.tab; if (!t) return;
    const r = $('#mapcv').getBoundingClientRect(), off = Math.floor(((e.clientX - r.left) / r.width) * t.doc.buf.length);
    const z = t.doc.zoneAt(off);
    $('#mapInfo').textContent = `0x${hex(off, 6)} · ${z ? z.label + (z.kind === 'locked' || z.kind === 'tables' ? ' (locked)' : '') : ''}`;
  },
  click(e) {
    const t = App.tab; if (!t) return;
    const r = $('#mapcv').getBoundingClientRect(), off = Math.floor(((e.clientX - r.left) / r.width) * t.doc.buf.length);
    if (App.mode !== 'hex') App.setMode('hex');
    Hex.jumpTo(DB.clamp(off, 0, t.doc.buf.length - 1));
  },
};
