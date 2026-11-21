/* Tools: the list on the left, settings on the right, live preview, apply. */
for (const [k, o] of Object.entries(DB.OPS)) o.id = k;
const Tools = {
  timer: null, seq: 0, slow: false,
  FINE: [
    { id: 'strength', label: 'Strength', help: 'How much of the effect you keep. 100 is full strength; lower blends each changed byte back toward the original.' },
    { id: 'coverage', label: 'Coverage', help: 'How many of the changed spots you keep. 100 keeps all of them; lower leaves some places untouched.' },
  ],
  fineFor(op) { return op.needs !== 'none' && !op.verify && op.id !== 'cut'; },
  defaults(op, d, sel) { const p = DB.defaultParams(op, d, sel); if (Tools.fineFor(op)) { p.strength = 100; p.coverage = 100; } return p; },
  fr: { scope: 'this', seeds: 'each', ramp: 'flat' }, lockOpen: (() => { try { return !!localStorage.getItem('ib.lockopen'); } catch (e) { return false; } })(), closed: new Set((() => { try { return JSON.parse(localStorage.getItem('ib.closed') || '[]'); } catch (e) { return []; } })()),

  attach(tab) {
    Tools.renderList();
    Tools.renderPanel();
  },

  // ------------------------------------------------------------------ left: recipes + tools
  renderList() {
    const t = App.tab, el = $('#left');
    if (!t) { el.innerHTML = ''; return; }
    const d = t.doc, recipes = DB.recipesFor(d);
    let h = '<div class="sect">One-click recipes</div><div class="recipes">';
    for (const r of recipes) h += `<button data-recipe="${r.id}" title="${esc(r.blurb)}">${esc(r.title)}</button>`;
    h += '<button class="wide" data-recipe="__surprise">Surprise me</button></div>';
    h += Recipes.html();
    const groups = { Move: [], Colour: [], Destroy: [] }, locked = [];
    for (const tl of DB.toolsFor(d)) {
      if (tl.why) locked.push(tl);
      else (groups[tl.op.group] || (groups[tl.op.group] = [])).push(tl);
    }
    const btn = (tl) => {
      const on = t.tool && t.tool.id === tl.id;
      return `<button class="toolbtn${on ? ' on' : ''}" data-tool="${tl.id}" title="${esc(tl.op.blurb)}"><span>${esc(tl.op.title)}</span></button>`;
    };
    for (const [g, list] of Object.entries(groups)) {
      if (!list.length) continue;
      const closed = Tools.closed.has(g) && !(t.tool && list.some((x) => x.id === t.tool.id));
      h += `<div class="sect gh${closed ? ' shut' : ''}" data-g="${g}" role="button" aria-expanded="${!closed}">${g}<span class="n">${list.length}</span></div><div class="grp${closed ? ' shut' : ''}">`;
      for (const tl of list) h += btn(tl);
      h += '</div>';
    }
    // Tools this file cannot use sit in their own folded group, so the main list only shows what works.
    if (locked.length) {
      const open = Tools.lockOpen;
      h += `<div class="sect gh lockgh${open ? '' : ' shut'}" data-g="__locked" role="button" aria-expanded="${open}" title="Tools that need a different file type">Not for this file<span class="n">${locked.length}</span></div><div class="grp${open ? '' : ' shut'}">`;
      for (const tl of locked) h += `<button class="toolbtn off" data-tool="${tl.id}" title="${esc(tl.why)}"><span>${esc(tl.op.title)}</span><small>${esc(tl.why)}</small></button>`;
      h += '</div>';
    }
    el.innerHTML = h;
    el.onclick = (e) => {
      const gh = e.target.closest('.gh');
      if (gh && gh.dataset.g === '__locked') { Tools.lockOpen = !Tools.lockOpen; try { localStorage.setItem('ib.lockopen', Tools.lockOpen ? '1' : ''); } catch (x) { /* ignore */ } Tools.renderList(); return; }
      if (gh) { const g = gh.dataset.g; if (Tools.closed.has(g)) Tools.closed.delete(g); else Tools.closed.add(g); try { localStorage.setItem('ib.closed', JSON.stringify([...Tools.closed])); } catch (x) { /* ignore */ } Tools.renderList(); return; }
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.recipe) Tools.recipe(b.dataset.recipe);
      else if (b.dataset.urecipe) Recipes.run(+b.dataset.urecipe);
      else if (b.dataset.rfolder) api.recipesOpen();
      else if (b.dataset.radd) Recipes.addFile();
      else if (b.dataset.tool) {
        if (b.classList.contains('off')) { const nm = b.querySelector('span'); App.toast((nm ? nm.textContent + ': ' : '') + b.title, 'bad'); return; }
        Tools.select(b.dataset.tool);
      }
    };
  },

  async recipe(id) {
    const t = App.tab; if (!t) return;
    App.clearPending(); Tools.afterCancel(true);
    const d = t.doc, list = DB.recipesFor(d);
    if (id === '__surprise') id = list[Math.floor(Math.random() * list.length)].id;
    const seed = 1 + Math.floor(Math.random() * 1e6);
    try {
      const patch = DB.runRecipe(d, id, seed);
      const title = (DB.RECIPES[id] || {}).title || id;
      patch.step = DB.stepFromRecipe(id, seed); patch.label = 'Recipe: ' + title;
      Visual.busy(true);
      await App.commit(patch, `Recipe “${title}” (seed ${seed}). Click again for a different roll, ⌘Z to undo.`);
    } catch (e) { console.error(e); App.toast('Recipe failed: ' + e.message, 'bad'); }
    finally { Visual.busy(false); }
  },

  // ------------------------------------------------------------------ choosing a tool
  select(id) {
    const t = App.tab; if (!t) return;
    if (t.tool && t.tool.id === id) return;
    App.clearPending();
    const op = DB.OPS[id], sel = App.selectionForOps();
    if (!op || op.available(t.doc)) return;
    if (App.rtab !== 'tool') Panels.setTab('tool', true);
    t.tool = { id, params: Tools.defaults(op, t.doc, sel), touchedDest: false };
    Tools.renderList(); Tools.renderPanel();
    Visual.updateOverlay();
    Tools.schedule(true);
  },
  deselect() {
    const t = App.tab; if (!t) return;
    App.clearPending(); t.tool = null;
    Tools.renderList(); Tools.renderPanel(); Visual.updateOverlay(); FileMap.draw(); Hex.refresh();
  },

  // ------------------------------------------------------------------ right: settings
  renderPanel() {
    const t = App.tab, el = $('#rbody');
    if (App.rtab !== 'tool') return;
    if (!t) { el.innerHTML = ''; return; }
    if (!t.tool) {
      const stream = t.doc.layout.kind !== 'raster';
      el.innerHTML = `<div class="empty-tool"><h3>How this works</h3>
        <ol>
          <li><b>Drag on the picture</b> to choose an area. No selection means the whole image.</li>
          <li><b>Pick a tool</b> on the left. You see the result live.</li>
          <li><b>Apply</b> keeps it. Everything is undoable with ⌘Z.</li>
        </ol>
        <p>${stream ? 'This file is compressed, so a position on the picture only roughly matches a position in the data. Higher up means earlier in the data, which means a bigger effect.' : 'You can also switch to <b>Hex</b> mode and edit the raw bytes. Locked bytes (headers, metadata) are greyed out and can’t be changed.'}</p>
        <p>The bar at the bottom is the whole file: light grey is safe to edit, dark is locked, white marks are your edits.</p></div>`;
      return;
    }
    const op = DB.OPS[t.tool.id], d = t.doc, p = t.tool.params;
    let h = `<h2>${esc(op.title)}</h2><p class="blurb">${esc(op.blurb)}</p><div id="hintbox"></div>`;
    for (const q of op.params) {
      const b = DB.paramBounds(q, d), val = p[q.id];
      if (q.type === 'range') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span><span class="vv" data-vv="${q.id}"></span></label><div class="row"><input type="range" data-p="${q.id}" min="${b.min}" max="${b.max}" step="${q.step}" value="${val}"><input type="number" data-n="${q.id}" min="${b.min}" max="${b.max}" step="${q.step}" value="${val}"></div>${q.help ? `<div class="help">${esc(q.help)}</div>` : ''}</div>`;
      } else if (q.type === 'select') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><select data-p="${q.id}">${q.options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>${q.help ? `<div class="help">${esc(q.help)}</div>` : ''}</div>`;
      } else if (q.type === 'checkbox') {
        h += `<div class="prm chk"><label><input type="checkbox" data-p="${q.id}" ${val ? 'checked' : ''}>${esc(q.label)}</label></div>`;
      } else if (q.type === 'color') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><input type="color" data-p="${q.id}" value="${val}"></div>`;
      } else if (q.type === 'text') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><input type="text" data-p="${q.id}" value="${esc(val)}" spellcheck="false">${q.help ? `<div class="help">${esc(q.help)}</div>` : ''}</div>`;
      } else if (q.type === 'file') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><div class="row"><button data-pick="${q.id}">${val ? 'Change…' : 'Choose image…'}</button><span class="fname">${val ? esc(val.name) : 'none chosen'}</span></div></div>`;
      } else if (q.type === 'point') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><div class="pt">x <input type="number" data-pt="x" value="${Math.round(val.x)}" style="width:80px"> y <input type="number" data-pt="y" value="${Math.round(val.y)}" style="width:80px"></div>${q.help ? `<div class="help">${esc(q.help)}</div>` : ''}</div>`;
      } else if (q.type === 'seed') {
        h += `<div class="prm"><label><span>${esc(q.label)}</span></label><div class="row"><input type="number" data-p="${q.id}" value="${val}" step="1" min="1"><button data-reroll="${q.id}" title="Roll again">Roll again</button></div>${q.help ? `<div class="help">${esc(q.help)}</div>` : ''}</div>`;
      }
    }
    if (Tools.fineFor(op)) {
      const open = (p.strength != null && p.strength < 100) || (p.coverage != null && p.coverage < 100);
      h += `<details class="fine"${open ? ' open' : ''}><summary>Fine control <span class="vv" id="fineSum"></span></summary>`;
      for (const f of Tools.FINE) {
        const v = p[f.id] == null ? 100 : p[f.id];
        h += `<div class="prm"><label><span>${f.label}</span><span class="vv" data-vv="${f.id}"></span></label><div class="row"><input type="range" data-p="${f.id}" min="0" max="100" step="1" value="${v}"><input type="number" data-n="${f.id}" min="0" max="100" step="1" value="${v}"></div><div class="help">${f.help}</div></div>`;
      }
      h += '<div class="help">Tip: click a slider, then hold <kbd>⌥</kbd> and press the arrow keys for half-percent steps.</div></details>';
    }
    h += '<div class="btnrow"><button id="tReset" class="ghost">Reset</button><button id="tApply" class="primary" disabled>Apply</button></div>';
    h += '<div class="prm" style="margin-top:12px"><div class="help"><kbd>Enter</kbd> apply · <kbd>Esc</kbd> cancel · <kbd>⌘Z</kbd> undo</div></div>';
    el.innerHTML = h;
    Tools.syncValueLabels();
    Tools.refreshHint();
    el.oninput = (e) => Tools.paramEvent(e, false);
    el.onchange = (e) => Tools.paramEvent(e, true);
    el.onkeydown = Tools.fineKey;
    el.onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.id === 'tBandUp' || b.id === 'tBandDown') { b.blur(); Visual.nextBand(b.id === 'tBandUp' ? 'up' : 'down'); }
      else if (b.id === 'tApply') Tools.apply();
      else if (b.id === 'tReset') { t.tool.params = Tools.defaults(op, d, App.selectionForOps()); t.tool.touchedDest = false; Tools.renderPanel(); Visual.updateOverlay(); Tools.schedule(true); }
      else if (b.dataset.pick) Tools.pickFile(b.dataset.pick);
      else if (b.dataset.reroll) { const id = b.dataset.reroll; t.tool.params[id] = 1 + Math.floor(Math.random() * 99999); $(`[data-p="${id}"]`).value = t.tool.params[id]; Tools.schedule(true); }
    };
  },

  async pickFile(id) {
    const t = App.tab; if (!t || !t.tool) return;
    const files = await api.openDialog(); if (!files || !files.length) return;
    const src = await App.loadSource(files[0]);
    if (!src) return;
    t.tool.params[id] = src;
    Tools.renderPanel(); Tools.schedule(true);
  },

  syncValueLabels() {
    const t = App.tab; if (!t || !t.tool) return;
    const op = DB.OPS[t.tool.id];
    for (const f of Tools.FINE) { const el = $(`[data-vv="${f.id}"]`); if (el) { const v = t.tool.params[f.id] == null ? 100 : t.tool.params[f.id]; el.textContent = (Number.isInteger(v) ? v : v.toFixed(1)) + '%'; }; }
    const fs = $('#fineSum'); if (fs) { const a = t.tool.params.strength, c = t.tool.params.coverage; fs.textContent = (a < 100 || c < 100) ? `· ${Math.round(a)}% strength, ${Math.round(c)}% coverage` : ''; }
    for (const q of op.params) {
      if (q.type !== 'range') continue;
      const v = t.tool.params[q.id], el = $(`[data-vv="${q.id}"]`);
      if (el) el.textContent = (q.step < 1 ? (+v).toFixed(2) : Math.round(v)) + (q.unit ? ' ' + q.unit : '');
    }
  },

  paramEvent(e, final) {
    const t = App.tab; if (!t || !t.tool) return;
    const el = e.target, pt = el.dataset.pt;
    if (pt) { t.tool.params.dest = Object.assign({}, t.tool.params.dest, { [pt]: +el.value || 0 }); t.tool.touchedDest = true; Visual.updateOverlay(); Tools.schedule(final); return; }
    const id = el.dataset.p || el.dataset.n;
    if (!id) return;
    const q = DB.OPS[t.tool.id].params.find((x) => x.id === id) || Tools.FINE.find((x) => x.id === id) && { type: 'range' };
    if (!q) return;
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'range' || el.type === 'number') { v = parseFloat(el.value); if (isNaN(v)) return; }
    else v = el.value;
    t.tool.params[id] = v;
    if (q.type === 'range') { // keep slider and number box in step
      const other = $(`[${el.type === 'range' ? 'data-n' : 'data-p'}="${id}"]`);
      if (other && other !== el) other.value = v;
    }
    Tools.syncValueLabels();
    Tools.schedule(final);
  },

  // Alt + arrows on a slider: a tenth of the normal step
  fineKey(e) {
    const el = e.target;
    if (!e.altKey || el.type !== 'range' || !/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
    e.preventDefault();
    const fine = Tools.FINE.some((f) => f.id === el.dataset.p), st = parseFloat(el.step) || 1;
    if (!fine && st >= 1) return; // whole-number settings keep their normal arrow steps
    el.step = 'any';
    const dir = /Right|Up/.test(e.key) ? 1 : -1;
    const v = DB.clamp(Math.round((parseFloat(el.value) + dir * (fine ? 0.5 : st * 0.1)) * 1000) / 1000, +el.min, +el.max);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  setDest(x, y) {
    const t = App.tab; if (!t || !t.tool) return;
    t.tool.params.dest = { x, y }; t.tool.touchedDest = true;
    const ix = $('[data-pt="x"]'), iy = $('[data-pt="y"]'); if (ix) ix.value = x; if (iy) iy.value = y;
    Visual.updateOverlay(); Tools.schedule(false);
  },

  // ------------------------------------------------------------------ hints
  hasSel(sel) { return !!(sel && ((sel.range) || (sel.w > 0 && sel.h > 0))); },
  refreshHint(msg, kind) {
    const t = App.tab, hb = $('#hintbox'); if (!hb || !t || !t.tool) return;
    const op = DB.OPS[t.tool.id], sel = App.selectionForOps(), has = Tools.hasSel(sel), stream = t.doc.layout.kind !== 'raster';
    let text = msg, cls = kind || '';
    if (!text) {
      if (op.needs === 'none') text = 'This tool changes the whole file’s settings.';
      else if (has) { cls = 'ok'; text = stream ? 'Using your selection (a stretch of the data).' : sel.range ? 'Using your hex selection.' : `Using your selection: ${Math.round(sel.w)}×${Math.round(sel.h)} px.`; }
      else if (op.defaultAll) text = 'Nothing selected, so this uses the whole image. Drag on the picture to limit it.';
      else text = 'Drag on the picture to choose where this applies.';
    }
    const bands = has && !sel.range ? `<div class="btnrow bands"><button id="tBandUp" title="Select the band right above, same size (⌘↑)">${stream ? '↑ Stretch before' : '↑ Band above'}</button><button id="tBandDown" title="Select the band right below, same size (⌘↓)">${stream ? '↓ Stretch after' : '↓ Band below'}</button></div>${stream ? '' : '<div class="help keyhint"><span><kbd>⌘</kbd> + arrows: next band</span><span>arrows: nudge 1 px (<kbd>⇧</kbd> = 10)</span></div>'}` : '';
    hb.innerHTML = `<div class="hint ${cls}">${text}</div>${bands}`;
    const ap = $('#tApply'); if (ap) ap.disabled = !t.pending;
  },
  afterCancel(silent) { if (!silent) { Tools.refreshHint(); FileMap.draw(); Hex.refresh(); } else { const ap = $('#tApply'); if (ap) ap.disabled = true; } },

  refreshPanel(afterCommit) {
    const t = App.tab; if (!t) return;
    if (t.tool) Tools.refreshHint();
    if (afterCommit) Tools.renderList();
  },

  selectionChanged(live) {
    const t = App.tab; if (!t) return;
    if (t.tool) {
      const op = DB.OPS[t.tool.id];
      if (op.ghost && !t.tool.touchedDest) { t.tool.params.dest = DB.defaultParams(op, t.doc, t.sel).dest; Tools.renderPanel(); }
      Tools.refreshHint();
      Visual.updateOverlay();
      Tools.schedule(!live);
    }
  },

  // ------------------------------------------------------------------ live preview
  schedule(immediate) {
    clearTimeout(Tools.timer);
    if (Tools.slow && !immediate) return; // big areas: only update when the control is released
    Tools.timer = setTimeout(Tools.preview, immediate ? 0 : 90);
  },

  async preview() {
    const t = App.tab; if (!t || !t.tool) return;
    const d = t.doc, id = t.tool.id, op = DB.OPS[id], seq = ++Tools.seq;
    const old = t.pending; t.pending = null;
    if (old) d.revertPatch(old);
    const sel = App.selectionForOps();
    const needSel = (op.needs === 'rect' || op.needs === 'band') && !op.defaultAll;
    const redraw = async (patchA, patchB) => {
      if (d.layout.kind === 'raster') {
        const ra = patchA ? d.dirtyRows(patchA) : [0, 0], rb = patchB ? d.dirtyRows(patchB) : [0, 0];
        if (!ra || !rb) Visual.renderRows(t, 0, d.layout.height); else Visual.renderRows(t, Math.min(ra[0], rb[0]), Math.max(ra[1], rb[1]));
        Visual.updateOverlay(); return true;
      }
      return Visual.renderStream(t);
    };
    if (needSel && !Tools.hasSel(sel)) {
      await redraw(old, null); Tools.refreshHint(); FileMap.draw(); Hex.refresh(); return;
    }
    let patch;
    const t0 = performance.now();
    try { patch = DB.runOp(d, id, sel, t.tool.params); }
    catch (e) {
      console.warn(e.message); await redraw(old, null);
      Tools.refreshHint('This setting can’t be applied here: ' + esc(e.message), 'bad'); return;
    }
    if (seq !== Tools.seq) { d.revertPatch(patch); return; }
    if (!patch.entries.length) { await redraw(old, null); Tools.refreshHint('This changes nothing with these settings. Try a bigger area or stronger values.'); FileMap.draw(); Hex.refresh(); return; }
    t.pending = patch;
    if (d.layout.kind === 'raster' && (patch.full || old)) { /* layout may have changed: sizeTo handles it in renderRows */ }
    const ok = await redraw(old, patch);
    if (!ok) {
      d.revertPatch(patch); t.pending = null; await redraw(patch, null);
      Tools.refreshHint('These settings would make the file unreadable, so they were not applied. Try gentler values.', 'bad'); return;
    }
    if (op.verify && !(await Tools.opens(d))) { // the safety net: snap back when the file would no longer open
      d.revertPatch(patch); t.pending = null; await redraw(patch, null); FileMap.draw(); Hex.refresh();
      Tools.refreshHint('That would stop the file opening, so it snapped back. Try a smaller change.', 'bad'); return;
    }
    Tools.slow = performance.now() - t0 > 600;
    Tools.refreshHint(Tools.slow ? 'Previewing. This is a big area, so the preview updates when you let go of a control.' : 'Previewing. Press Apply to keep it.', 'ok');
    FileMap.draw(); Hex.refresh();
  },

  // Can the file as it stands now be read again from scratch (and, where the browser can, decoded)?
  async opens(d) {
    try {
      const bytes = await d.exportBytes();
      const re = await DB.open(bytes, d.name || 'x');
      if (!(re.layout.width > 0 && re.layout.height > 0)) return false;
      if (['png', 'jpeg', 'gif', 'bmp', 'webp'].includes(d.format) && d.format !== 'bmp') return await App.decodes(bytes);
      return true;
    } catch (e) { console.warn('verify:', e.message); return false; }
  },

  async apply() {
    const t = App.tab; if (!t || !t.pending) return;
    clearTimeout(Tools.timer);
    const p = t.pending; t.pending = null;
    try { p.step = DB.stepFromTool(t.doc, t.tool.id, App.selectionForOps(), t.tool.params); } catch (e) { /* not recordable */ }
    p.label = DB.OPS[t.tool.id].title;
    t.doc.commit(p);
    App.afterChange();
    App.status(`Applied “${esc(DB.OPS[t.tool.id].title)}”. Tweak the settings to stack another, or pick a different tool.`);
    const op = DB.OPS[t.tool.id];
    // after applying, stacked previews should start from fresh defaults for the position-like parameters
    if (op.ghost) t.tool.touchedDest = false;
    Tools.refreshHint('Applied. Change a setting to preview another pass.', 'ok');
    const ap = $('#tApply'); if (ap) ap.disabled = true;
  },
};
