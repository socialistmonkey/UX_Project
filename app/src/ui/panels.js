/* Right-hand panels besides the tool settings: History (jump to any step) and Macros (replay, batch, variations). */
const Panels = {
  macros: [], cancel: false,

  init() {
    try { Panels.macros = JSON.parse(localStorage.getItem('ib.macros') || '[]'); } catch (e) { Panels.macros = []; }
    $('#rtabs').onclick = (e) => { const b = e.target.closest('button'); if (b) Panels.setTab(b.dataset.rt); };
  },
  save() { try { localStorage.setItem('ib.macros', JSON.stringify(Panels.macros)); } catch (e) { App.toast('Could not save macros here.', 'bad'); } },

  setTab(name, quiet) {
    App.rtab = name;
    $$('#rtabs button').forEach((b) => b.classList.toggle('on', b.dataset.rt === name));
    if (name === 'tool') { const el = $('#rbody'); el.oninput = el.onchange = el.onclick = null; Tools.renderPanel(); }
    else if (!quiet) Panels.render();
  },

  render() {
    const el = $('#rbody'), t = App.tab;
    if (App.rtab === 'tool') return;
    el.oninput = el.onchange = el.onclick = null;
    if (!t) { el.innerHTML = '<div class="empty-tool"><p>Open an image first.</p></div>'; return; }
    if (App.rtab === 'history') Panels.renderHistory(el, t); else Panels.renderMacros(el, t);
  },

  // ------------------------------------------------------------------ history
  renderHistory(el, t) {
    const d = t.doc, past = d.undoStack, future = d.redoStack.slice().reverse();
    const row = (i, label, cls, size) => `<button class="hrow ${cls}" data-i="${i}"><span class="n">${i}</span><span class="lb">${esc(label)}</span><span class="sz">${size || ''}</span></button>`;
    const sz = (p) => (p.entries.some((e) => e.k === 'b') ? DB.fmtBytes(Math.round(p.size / 2)) : '');
    let h = '<h2>History</h2><p class="blurb">Click any step to go back to how the picture looked then. If you edit after going back, the steps that came after are replaced.</p><div class="hist">';
    h += row(0, 'Original', past.length === 0 ? 'cur' : 'past');
    past.forEach((p, i) => { h += row(i + 1, p.label || 'Edit', i === past.length - 1 ? 'cur' : 'past', sz(p)); });
    future.forEach((p, i) => { h += row(past.length + i + 1, p.label || 'Edit', 'future', sz(p)); });
    h += '</div>';
    h += `<div class="btnrow"><button id="hsOrig"${past.length ? '' : ' disabled'}>Back to original</button><button id="hsUndo"${past.length ? '' : ' disabled'}>Undo</button><button id="hsRedo"${future.length ? '' : ' disabled'}>Redo</button></div>`;
    h += '<p class="help" style="margin-top:12px">Tip: Macros → “Save history as macro” turns these steps into something you can replay on other images.</p>';
    el.innerHTML = h;
    const cur = $('.hrow.cur', el); if (cur) cur.scrollIntoView({ block: 'nearest' });
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.i !== undefined) Panels.jumpTo(+b.dataset.i);
      else if (b.id === 'hsOrig') Panels.jumpTo(0);
      else if (b.id === 'hsUndo') App.undo(); else if (b.id === 'hsRedo') App.redo();
    };
  },

  async jumpTo(n) {
    const t = App.tab; if (!t) return;
    const d = t.doc;
    App.clearPending(); Tools.afterCancel(true);
    if (n === d.undoStack.length) return;
    while (d.undoStack.length > n) d.undo();
    while (d.undoStack.length < n && d.redoStack.length) d.redo();
    await Visual.renderDirty(t, null);
    App.afterChange();
    App.status(n === 0 ? 'Back to the original.' : `Went to step ${n}.`);
  },

  // ------------------------------------------------------------------ macros
  stepsFromHistory(t) { return t.doc.undoStack.flatMap((p) => p.macroSteps || (p.step ? [p.step] : [])); },

  renderMacros(el, t) {
    const steps = Panels.stepsFromHistory(t), all = t.doc.undoStack.length;
    let h = '<h2>Macros</h2><p class="blurb">A macro is a list of tools and settings. Replay it on this image, on a whole folder, or make a set of variations. Positions are stored relative to the picture, so it works on images of any size.</p>';
    h += `<div class="mbox"><div class="mt">Current history</div><div class="help">${steps.length} replayable step${steps.length === 1 ? '' : 's'}${all > steps.length ? ` (${all - steps.length} hex edit${all - steps.length === 1 ? '' : 's'} can’t be replayed and are left out)` : ''}</div><button id="mcSave"${steps.length ? '' : ' disabled'}>Save history as macro…</button></div>`;
    h += `<div class="prm"><label><span>Randomness</span></label><select id="mcSeed"><option value="fresh"${Panels.seedMode !== 'keep' ? ' selected' : ''}>New dice roll each time</option><option value="keep"${Panels.seedMode === 'keep' ? ' selected' : ''}>Same as when recorded</option></select></div>`;
    if (!Panels.macros.length) h += '<p class="help">No saved macros yet. Make some edits, then save your history as a macro.</p>';
    Panels.macros.forEach((m, i) => {
      h += `<div class="mbox"><div class="mt">${esc(m.name)}</div><div class="help">${m.steps.length} step${m.steps.length === 1 ? '' : 's'}: ${esc(m.steps.slice(0, 4).map(DB.stepTitle).join(' → '))}${m.steps.length > 4 ? ' …' : ''}</div>
        <div class="mbtn"><button data-run="${i}">Run here</button><button data-batch="${i}">Folder…</button><button data-vars="${i}">Variations…</button></div>
        <div class="mbtn sm"><button data-share="${i}" title="Put a copy in the recipes folder">To recipes</button><button data-exp="${i}">Export</button><button data-ren="${i}">Rename</button><button data-del="${i}">Delete</button></div></div>`;
    });
    h += '<div class="btnrow"><button id="mcImport">Import macro…</button><button id="mcFolder">Recipes folder</button></div><input type="file" id="mcFile" accept=".json,application/json" style="display:none">';
    el.innerHTML = h;
    el.onchange = (e) => { if (e.target.id === 'mcSeed') Panels.seedMode = e.target.value; };
    el.onclick = (e) => Panels.macroClick(e);
    $('#mcFile').onchange = (e) => Panels.importFile(e.target.files[0]);
  },

  async macroClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    const t = App.tab, ds = b.dataset;
    if (b.id === 'mcSave') {
      const name = await App.modal({ title: 'Save macro', input: true, value: 'My macro ' + (Panels.macros.length + 1), ok: 'Save', text: 'Name it so you can find it later.' });
      if (!name) return;
      Panels.macros.push({ id: Date.now(), name: name.trim() || 'Macro', steps: JSON.parse(JSON.stringify(Panels.stepsFromHistory(t))) });
      Panels.save(); Panels.render(); App.toast('Macro saved', 'good');
    } else if (b.id === 'mcImport') $('#mcFile').click();
    else if (b.id === 'mcFolder') api.recipesOpen();
    else if (ds.run !== undefined) Panels.runHere(Panels.macros[+ds.run]);
    else if (ds.batch !== undefined) Panels.batch(Panels.macros[+ds.batch]);
    else if (ds.vars !== undefined) Panels.variations(Panels.macros[+ds.vars]);
    else if (ds.share !== undefined) Recipes.share(Panels.macros[+ds.share]);
    else if (ds.exp !== undefined) { const m = Panels.macros[+ds.exp]; const out = await api.saveText({ name: m.name.replace(/[^\w-]+/g, '-') + '.imagebender-macro.json', text: JSON.stringify({ format: 'image-bender-macro', version: 1, name: m.name, steps: m.steps }, null, 1) }); if (out) App.toast('Saved ' + out.split(/[\\/]/).pop(), 'good'); }
    else if (ds.ren !== undefined) { const m = Panels.macros[+ds.ren]; const n = await App.modal({ title: 'Rename macro', input: true, value: m.name, ok: 'Rename' }); if (n) { m.name = n.trim() || m.name; Panels.save(); Panels.render(); } }
    else if (ds.del !== undefined) { const m = Panels.macros[+ds.del]; if (await App.modal({ title: 'Delete macro?', text: `“${esc(m.name)}” will be removed.`, ok: 'Delete' })) { Panels.macros.splice(+ds.del, 1); Panels.save(); Panels.render(); } }
  },

  async importFile(f) {
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (j.format !== 'image-bender-macro' || !Array.isArray(j.steps)) throw new Error('Not a macro file.');
      Panels.macros.push({ id: Date.now(), name: j.name || 'Imported macro', steps: j.steps }); Panels.save(); Panels.render(); App.toast('Macro imported', 'good');
    } catch (e) { App.toast('Could not import: ' + e.message, 'bad'); }
  },

  opts(base) { return { seed: base, keepSeeds: Panels.seedMode === 'keep' }; },

  // pictures that Mix steps refer to, loaded once
  async loadFiles(steps) {
    const files = new Map();
    for (const p of DB.stepFiles(steps)) {
      if (!p) continue;
      try { const f = await api.readFile(p); const src = await App.loadSource(f); if (src) files.set(p, src); } catch (e) { /* skipped later with a message */ }
    }
    return files;
  },
  skipNote(res) {
    if (!res.skipped.length) return '';
    const w = res.skipped[0];
    return ` ${res.skipped.length} step${res.skipped.length === 1 ? ' was' : 's were'} skipped (${w.why}).`;
  },

  async runHere(m) { return Panels.runMacroOn(m, 'Macro: ' + m.name); },

  // One macro (or shared recipe) on this picture
  async runMacroOn(m, label) {
    const t = App.tab; if (!t) return;
    App.clearPending(); Tools.afterCancel(true);
    Visual.busy(true);
    try {
      const files = await Panels.loadFiles(m.steps);
      const res = DB.runMacro(t.doc, m.steps, Object.assign(Panels.opts(1 + Math.floor(Math.random() * 1e6)), { files }));
      if (!res.patch.entries.length) { App.toast(`“${m.name}” changed nothing on this image.` + Panels.skipNote(res)); return; }
      res.patch.macroSteps = m.steps; res.patch.label = label;
      await App.commit(res.patch, `Ran “${m.name}”.${Panels.skipNote(res)}`);
    } catch (e) { console.error(e); App.toast('Macro failed: ' + e.message, 'bad'); }
    finally { Visual.busy(false); }
  },

  outFormat: [['file', 'Same format as the original'], ['png', 'PNG pictures (what you see)']],
  async encode(doc, how) { return how === 'png' ? App.docToPNG(doc) : doc.exportBytes(); },
  extFor(doc, how) { return how === 'png' ? 'png' : DB.extFor(doc); },

  progress(text) { $('#busy').textContent = text; $('#busy').style.display = 'block'; App.status(esc(text)); },
  endProgress() { $('#busy').textContent = 'Rendering…'; $('#busy').style.display = 'none'; },

  // Run a macro on every image in a folder
  async batch(m) {
    const dir = await api.pickDir('Choose the folder of images to process');
    if (!dir) return;
    const list = await api.listDir(dir);
    if (!list.length) { App.toast('No images (BMP, TIFF, PNG, JPEG, GIF, WebP) in that folder.', 'bad'); return; }
    const v = await App.modal({ title: `Run “${m.name}” on ${list.length} image${list.length === 1 ? '' : 's'}`, text: 'Results go into a new folder called <code>image-bender-out</code> inside the one you chose. Your originals are never touched.', fields: [{ id: 'f', label: 'Save as', value: 'file', options: Panels.outFormat }], ok: 'Start' });
    if (!v) return;
    const out = dir.replace(/[\\/]$/, '') + '/image-bender-out';
    const files = await Panels.loadFiles(m.steps);
    Panels.cancel = false;
    const onKey = (e) => { if (e.key === 'Escape') Panels.cancel = true; };
    document.addEventListener('keydown', onKey, true);
    let ok = 0, bad = 0; const notes = [];
    for (let i = 0; i < list.length && !Panels.cancel; i++) {
      Panels.progress(`Image ${i + 1} of ${list.length}: ${list[i].name}  (Esc to stop)`);
      await new Promise((r) => setTimeout(r, 10));
      try {
        const f = await api.readFile(list[i].path);
        const { doc } = await App.docFromBytes(new Uint8Array(f.data), list[i].name);
        const res = await Panels.runChecked(doc, m, files, i + 1);
        if (!res) { bad++; notes.push(list[i].name + ': changed nothing'); continue; }
        const data = await Panels.encode(doc, v.f);
        const base = list[i].name.replace(/\.[^.]+$/, '');
        await api.writeInDir({ dir: out, name: `${base}-bent.${Panels.extFor(doc, v.f)}`, data });
        ok++;
      } catch (e) { console.error(e); bad++; notes.push(list[i].name + ': ' + e.message); }
    }
    document.removeEventListener('keydown', onKey, true);
    Panels.endProgress();
    App.status(`Batch finished: ${ok} saved${bad ? `, ${bad} skipped` : ''}.`);
    App.toast(`${Panels.cancel ? 'Stopped. ' : ''}${ok} saved to image-bender-out${bad ? `, ${bad} skipped` : ''}.`, ok ? 'good' : 'bad');
    if (notes.length) console.warn(notes.join('\n'));
    if (ok) api.reveal(out);
  },

  // Runs the macro on a doc; for compressed files it retries with other dice rolls if the result won't open.
  async runChecked(doc, m, files, seedBase) {
    const compressed = doc.layout.kind !== 'raster';
    for (let attempt = 0; attempt < (compressed ? 6 : 1); attempt++) {
      const res = DB.runMacro(doc, m.steps, Object.assign(Panels.opts(seedBase * 7 + attempt * 101), { files }));
      if (!res.patch.entries.length) return null;
      if (!compressed || (await App.decodes(await doc.exportBytes()))) return res;
      doc.revertPatch(res.patch);
      if (Panels.seedMode === 'keep') return null;
    }
    return null;
  },

  // Many seeded versions of the current image (options to pick from)
  async variations(m) {
    const t = App.tab; if (!t) return;
    const v = await App.modal({ title: `Variations of “${t.name}”`, text: 'Runs the macro again and again with a different dice roll each time and saves every result, numbered.', fields: [{ id: 'n', label: 'How many', value: '24', type: 'number' }, { id: 'f', label: 'Save as', value: 'png', options: Panels.outFormat }], ok: 'Choose folder…' });
    if (!v) return;
    const n = DB.clamp(parseInt(v.n, 10) || 24, 1, 2000);
    const dir = await api.pickDir('Choose where to save the variations');
    if (!dir) return;
    const d = t.doc, base = t.name.replace(/\.[^.]+$/, '').replace(/-(copy|baked|bent)$/, '');
    App.clearPending(); Tools.afterCancel(true);
    const files = await Panels.loadFiles(m.steps);
    Panels.cancel = false;
    const onKey = (e) => { if (e.key === 'Escape') Panels.cancel = true; };
    document.addEventListener('keydown', onKey, true);
    let ok = 0; const pad = String(n).length;
    for (let i = 0; i < n && !Panels.cancel; i++) {
      Panels.progress(`Variation ${i + 1} of ${n}  (Esc to stop)`);
      await new Promise((r) => setTimeout(r, 10));
      try {
        const res = await Panels.runChecked(d, m, files, 1000 + i * 13);
        if (!res) continue;
        const data = await Panels.encode(d, v.f);
        d.revertPatch(res.patch);
        await api.writeInDir({ dir, name: `${base}-var-${String(i + 1).padStart(pad, '0')}.${Panels.extFor(d, v.f)}`, data });
        ok++;
      } catch (e) { console.error(e); }
    }
    document.removeEventListener('keydown', onKey, true);
    Panels.endProgress();
    await Visual.renderDirty(t, null); App.afterChange();
    App.toast(`${Panels.cancel ? 'Stopped. ' : ''}Saved ${ok} variation${ok === 1 ? '' : 's'}.`, ok ? 'good' : 'bad');
    if (ok) api.reveal(dir);
  },
};
