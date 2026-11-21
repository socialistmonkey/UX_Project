/* Visual mode: the picture, zoom, selection, the draggable paste ghost, hover readout, compare. */
const Visual = {
  cv: null, ctx: null, wrap: null,
  drag: null, hoverTimer: null,

  init() {
    Visual.cv = $('#cv'); Visual.ctx = Visual.cv.getContext('2d', { willReadFrequently: true });
    Visual.wrap = $('#canvasWrap');
    const w = Visual.wrap;
    w.addEventListener('pointerdown', Visual.down);
    w.addEventListener('pointermove', Visual.move);
    w.addEventListener('pointerup', Visual.up);
    w.addEventListener('pointercancel', Visual.up);
    w.addEventListener('pointerleave', () => { if (!Visual.drag) App.status('Ready'); });
    $('#visual').addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey) || !App.tab) return;
      e.preventDefault();
      Visual.setZoom(Visual.zoom() * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    }, { passive: false });
    $('#zIn').onclick = () => Visual.setZoom(Visual.zoom() * 1.25);
    $('#zOut').onclick = () => Visual.setZoom(Visual.zoom() / 1.25);
    $('#zFit').onclick = () => Visual.fit();
    Visual.initSplit();
    window.addEventListener('resize', () => { Visual.fitIfAuto(); FileMap.draw(); Hex.layoutChanged(); });
  },

  // ------------------------------------------------------------------ rendering
  async attach(tab) {
    tab.decodeSeq = 0; tab.imgData = null;
    const L = tab.doc.layout;
    Visual.cv.width = L.width; Visual.cv.height = L.height;
    Visual.holding = false; $('#cmp').style.display = 'none'; $('#compareTag').style.display = 'none'; $('#splitLine').style.display = 'none';
    await Visual.renderAll(tab);
    Visual.applyZoom(); Visual.updateOverlay();
    Visual.setHexMarker(null);
  },

  async renderAll(tab) {
    const d = tab.doc, L = d.layout;
    if (L.kind === 'raster') { Visual.sizeTo(tab, L.width, L.height); Visual.renderRows(tab, 0, L.height); return true; }
    return Visual.renderStream(tab);
  },

  sizeTo(tab, w, h) {
    if (Visual.cv.width !== w || Visual.cv.height !== h) { Visual.cv.width = w; Visual.cv.height = h; tab.imgData = null; }
    if (!tab.imgData || tab.imgData.width !== w || tab.imgData.height !== h) tab.imgData = new ImageData(w, h);
    Visual.applyZoom();
  },

  renderRows(tab, r0, r1) {
    const L = tab.doc.layout;
    Visual.sizeTo(tab, L.width, L.height);
    r0 = Math.max(0, r0); r1 = Math.min(L.height, r1);
    if (r1 <= r0) return;
    tab.doc.h.render(tab.doc, tab.imgData.data, r0, r1);
    Visual.ctx.putImageData(tab.imgData, 0, 0, 0, r0, L.width, r1 - r0);
  },

  async renderStream(tab) {
    const seq = ++tab.decodeSeq;
    try {
      const bmp = await tab.doc.h.decode(tab.doc);
      if (seq !== tab.decodeSeq || tab !== App.tab) return true; // a newer render superseded this one
      if (Visual.cv.width !== bmp.width || Visual.cv.height !== bmp.height) { Visual.cv.width = bmp.width; Visual.cv.height = bmp.height; }
      Visual.ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      tab.streamOk = true;
      Visual.applyZoom();
      return true;
    } catch (e) {
      if (seq !== tab.decodeSeq) return true;
      if (!tab.streamOk && !tab.doc.isModified()) { // the original itself won't decode: still allow editing, show a placeholder
        const L = tab.doc.layout; Visual.cv.width = L.width; Visual.cv.height = L.height;
        Visual.ctx.fillStyle = '#222'; Visual.ctx.fillRect(0, 0, L.width, L.height);
        Visual.ctx.fillStyle = '#999'; Visual.ctx.font = Math.max(14, L.width / 30) + 'px sans-serif'; Visual.ctx.fillText('Preview unavailable for this file', 20, 40);
        return true;
      }
      return false;
    }
  },

  // Repaint what a patch changed. Returns false when a compressed file no longer decodes.
  async renderDirty(tab, patch) {
    const d = tab.doc, L = d.layout;
    if (tab !== App.tab) return true;
    if (L.kind === 'raster') {
      const rows = patch ? d.dirtyRows(patch) : null;
      if (!rows) Visual.renderRows(tab, 0, L.height); else Visual.renderRows(tab, rows[0], rows[1]);
      Visual.updateOverlay();
      return true;
    }
    const ok = await Visual.renderStream(tab);
    Visual.updateOverlay();
    return ok;
  },

  busy(on) { $('#busy').style.display = on ? 'block' : 'none'; },

  // ------------------------------------------------------------------ zoom
  zoom() {
    const t = App.tab; if (!t) return 1;
    if (t.zoom) return t.zoom;
    const v = $('#visual'), W = Visual.cv.width, H = Visual.cv.height;
    return DB.clamp(Math.min((v.clientWidth - 48) / W, (v.clientHeight - 48) / H), 0.02, 8);
  },
  applyZoom() {
    const t = App.tab; if (!t) return;
    const z = Visual.zoom(), w = Visual.wrap;
    w.style.width = Visual.cv.width * z + 'px'; w.style.height = Visual.cv.height * z + 'px';
    Visual.cv.classList.toggle('px', z >= 2);
    $('#zLbl').textContent = t.zoom ? Math.round(z * 100) + '%' : 'Fit ' + Math.round(z * 100) + '%';
    Visual.updateOverlay();
  },
  setZoom(z, cx, cy) {
    const t = App.tab; if (!t) return;
    const v = $('#visual'), r = Visual.wrap.getBoundingClientRect();
    const old = Visual.zoom(), ax = cx === undefined ? v.getBoundingClientRect().left + v.clientWidth / 2 : cx, ay = cy === undefined ? v.getBoundingClientRect().top + v.clientHeight / 2 : cy;
    const ix = (ax - r.left) / old, iy = (ay - r.top) / old;
    t.zoom = DB.clamp(z, 0.02, 32);
    Visual.applyZoom();
    const r2 = Visual.wrap.getBoundingClientRect();
    v.scrollLeft += r2.left + ix * t.zoom - ax; v.scrollTop += r2.top + iy * t.zoom - ay;
  },
  fit() { const t = App.tab; if (!t) return; t.zoom = null; Visual.applyZoom(); const v = $('#visual'); v.scrollLeft = 0; v.scrollTop = 0; },
  fitIfAuto() { if (App.tab && !App.tab.zoom) Visual.applyZoom(); else Visual.updateOverlay(); },

  // ------------------------------------------------------------------ selection overlay
  imgPoint(e) {
    const r = Visual.wrap.getBoundingClientRect(), z = Visual.zoom();
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  },
  isStream() { return App.tab && App.tab.doc.layout.kind !== 'raster'; },
  imgW() { return Visual.cv.width; },
  imgH() { return Visual.cv.height; },

  ghostRect() {
    const t = App.tab; if (!t || !t.tool || !t.sel) return null;
    const op = DB.OPS[t.tool.id];
    if (!op || op.ghost !== 'dest' || !t.tool.params.dest) return null;
    return { x: t.tool.params.dest.x, y: t.tool.params.dest.y, w: t.sel.w, h: t.sel.h };
  },

  updateOverlay() {
    const t = App.tab, z = Visual.zoom(), sb = $('#selBox'), gb = $('#ghostBox');
    if (!t) { sb.style.display = gb.style.display = 'none'; return; }
    const s = t.sel;
    if (s && s.w > 0 && s.h > 0) {
      const stream = Visual.isStream();
      Object.assign(sb.style, { display: 'block', left: (stream ? 0 : s.x * z) + 'px', top: s.y * z + 'px', width: (stream ? Visual.imgW() * z : s.w * z) + 'px', height: s.h * z + 'px' });
      const tag = $('#selTag');
      if (stream) {
        const L = t.doc.layout, a = Math.round((s.y / L.height) * 100), b = Math.round(((s.y + s.h) / L.height) * 100);
        tag.textContent = `≈ ${a}%–${b}% down the data`;
      } else tag.textContent = `${Math.round(s.x)}, ${Math.round(s.y)}  ·  ${Math.round(s.w)}×${Math.round(s.h)} px`;
    } else sb.style.display = 'none';
    const g = Visual.ghostRect();
    if (g && !Visual.isStream()) Object.assign(gb.style, { display: 'block', left: g.x * z + 'px', top: g.y * z + 'px', width: g.w * z + 'px', height: g.h * z + 'px' });
    else gb.style.display = 'none';
  },

  setSelection(rect, silent) {
    const t = App.tab; if (!t) return;
    t.sel = rect && rect.w >= 1 && rect.h >= 1 ? rect : null;
    Visual.updateOverlay(); FileMap.draw();
    if (!silent) Tools.selectionChanged();
  },

  // The band exactly next to the selection, same size, no gap and no overlap: dir is up, down, left or right.
  // Near the edge it takes whatever is left of the picture. Returns false when there is no room.
  nextBand(dir) {
    const t = App.tab, s0 = t && t.sel; if (!s0) { App.toast('Select something first, then jump to the band next to it.'); return false; }
    const W = Visual.imgW(), H = Visual.imgH(), stream = Visual.isStream();
    if (stream && (dir === 'left' || dir === 'right')) return false;
    const s = { x: Math.round(s0.x), y: Math.round(s0.y), w: Math.max(1, Math.round(s0.w)), h: Math.max(1, Math.round(s0.h)) };
    if (stream) { s.x = 0; s.w = W; }
    const n = Object.assign({}, s), vert = dir === 'up' || dir === 'down', pos = vert ? 'y' : 'x', len = vert ? 'h' : 'w', max = vert ? H : W;
    if (dir === 'up' || dir === 'left') {
      if (s[pos] <= 0) { App.toast(vert ? 'Already at the top.' : 'Already at the left edge.'); return false; }
      n[pos] = Math.max(0, s[pos] - s[len]); n[len] = s[pos] - n[pos];
    } else {
      const start = s[pos] + s[len];
      if (start >= max) { App.toast(vert ? 'Already at the bottom.' : 'Already at the right edge.'); return false; }
      n[pos] = start; n[len] = Math.min(s[len], max - start);
    }
    Visual.setSelection(n);
    const sb = $('#selBox'); if (sb && sb.scrollIntoView) sb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  },
  // Move the selection by whole pixels, keeping its size.
  nudgeSel(dx, dy) {
    const t = App.tab, s = t && t.sel; if (!s) return false;
    const W = Visual.imgW(), H = Visual.imgH(), stream = Visual.isStream();
    const n = { x: stream ? 0 : DB.clamp(Math.round(s.x) + dx, 0, Math.max(0, W - Math.round(s.w))), y: DB.clamp(Math.round(s.y) + dy, 0, Math.max(0, H - Math.round(s.h))), w: stream ? W : Math.round(s.w), h: Math.round(s.h) };
    if (n.x === Math.round(s.x) && n.y === Math.round(s.y)) return true;
    Visual.setSelection(n);
    const sb = $('#selBox'); if (sb && sb.scrollIntoView) sb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  },

  setHexMarker(rect) {
    const hb = $('#hexBox'), z = Visual.zoom();
    if (!rect || Visual.isStream()) { hb.style.display = 'none'; return; }
    Object.assign(hb.style, { display: 'block', left: rect.x * z + 'px', top: rect.y * z + 'px', width: Math.max(2, rect.w * z) + 'px', height: Math.max(2, rect.h * z) + 'px' });
  },

  // ------------------------------------------------------------------ pointer handling
  hitSel(p) {
    const t = App.tab, s = t.sel; if (!s) return null;
    const z = Visual.zoom(), tol = 8 / z, stream = Visual.isStream();
    const x0 = stream ? 0 : s.x, x1 = stream ? Visual.imgW() : s.x + s.w, y0 = s.y, y1 = s.y + s.h;
    if (p.x < x0 - tol || p.x > x1 + tol || p.y < y0 - tol || p.y > y1 + tol) return null;
    let h = '';
    if (Math.abs(p.y - y0) < tol) h += 'n'; else if (Math.abs(p.y - y1) < tol) h += 's';
    if (!stream) { if (Math.abs(p.x - x0) < tol) h += 'w'; else if (Math.abs(p.x - x1) < tol) h += 'e'; }
    if (h) return { kind: 'resize', h };
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return { kind: 'move' };
    return null;
  },
  hitGhost(p) {
    const g = Visual.ghostRect(); if (!g || Visual.isStream()) return false;
    return p.x >= g.x && p.x <= g.x + g.w && p.y >= g.y && p.y <= g.y + g.h;
  },

  down(e) {
    const t = App.tab; if (!t || e.button !== 0) return;
    Visual.wrap.setPointerCapture(e.pointerId);
    const p = Visual.imgPoint(e), W = Visual.imgW(), H = Visual.imgH();
    if (Visual.hitGhost(p)) {
      const g = Visual.ghostRect();
      Visual.drag = { kind: 'ghost', dx: p.x - g.x, dy: p.y - g.y };
      return;
    }
    const hit = Visual.hitSel(p);
    if (hit && hit.kind === 'resize') Visual.drag = { kind: 'resize', h: hit.h, orig: { ...t.sel } };
    else if (hit && hit.kind === 'move') Visual.drag = { kind: 'move', dx: p.x - (Visual.isStream() ? 0 : t.sel.x), dy: p.y - t.sel.y, w: t.sel.w, h: t.sel.h };
    else Visual.drag = { kind: 'new', ax: DB.clamp(p.x, 0, W), ay: DB.clamp(p.y, 0, H), moved: false };
  },

  move(e) {
    const t = App.tab; if (!t) return;
    const p = Visual.imgPoint(e), W = Visual.imgW(), H = Visual.imgH(), d = Visual.drag, stream = Visual.isStream();
    if (!d) { Visual.hover(p); return; }
    if (d.kind === 'new') {
      const x = DB.clamp(p.x, 0, W), y = DB.clamp(p.y, 0, H);
      if (Math.abs(x - d.ax) + Math.abs(y - d.ay) > 3 / Visual.zoom()) d.moved = true;
      if (d.moved) Visual.setSelection({ x: stream ? 0 : Math.min(d.ax, x), y: Math.min(d.ay, y), w: stream ? W : Math.abs(x - d.ax), h: Math.abs(y - d.ay) }, true);
    } else if (d.kind === 'move') {
      const s = t.sel;
      Visual.setSelection({ x: stream ? 0 : DB.clamp(p.x - d.dx, 0, W - d.w), y: DB.clamp(p.y - d.dy, 0, H - d.h), w: s.w, h: s.h }, true);
    } else if (d.kind === 'resize') {
      let { x, y, w, h } = d.orig, x2 = x + w, y2 = y + h;
      const px = DB.clamp(p.x, 0, W), py = DB.clamp(p.y, 0, H);
      if (d.h.includes('n')) y = py; if (d.h.includes('s')) y2 = py;
      if (d.h.includes('w')) x = px; if (d.h.includes('e')) x2 = px;
      Visual.setSelection({ x: stream ? 0 : Math.min(x, x2), y: Math.min(y, y2), w: stream ? W : Math.abs(x2 - x), h: Math.abs(y2 - y) }, true);
    } else if (d.kind === 'ghost') {
      Tools.setDest(Math.round(p.x - d.dx), Math.round(p.y - d.dy));
    }
    if (d.kind !== 'ghost') Tools.selectionChanged(true); // live while dragging (debounced inside)
  },

  up(e) {
    const t = App.tab, d = Visual.drag; Visual.drag = null;
    if (!t || !d) return;
    try { Visual.wrap.releasePointerCapture(e.pointerId); } catch (_) {}
    if (d.kind === 'new' && !d.moved) Visual.setSelection(null);
    Tools.selectionChanged(false);
  },

  hover(p) {
    const t = App.tab, d = t.doc, L = d.layout;
    const x = Math.floor(p.x), y = Math.floor(p.y);
    // cursor shape
    const g = Visual.hitGhost(p), hit = t.sel ? Visual.hitSel(p) : null;
    Visual.wrap.style.cursor = g ? 'move' : hit ? (hit.kind === 'move' ? 'move' : hit.h === 'n' || hit.h === 's' ? 'ns-resize' : hit.h === 'w' || hit.h === 'e' ? 'ew-resize' : (hit.h === 'nw' || hit.h === 'se') ? 'nwse-resize' : 'nesw-resize') : 'crosshair';
    if (x < 0 || y < 0 || x >= Visual.imgW() || y >= Visual.imgH()) return;
    let px;
    if (t.imgData && L.kind === 'raster') { const i = (y * L.width + x) * 4, a = t.imgData.data; px = [a[i], a[i + 1], a[i + 2]]; }
    else px = [...Visual.ctx.getImageData(x, y, 1, 1).data].slice(0, 3);
    let where = '';
    if (L.kind === 'raster') {
      const sr = L.flipY ? L.height - 1 - y : y, l = sr * L.stride + x * L.bpp, off = d.l2b(l);
      where = `  ·  byte 0x${hex(off, 6)} (${off.toLocaleString()})  ·  row ${y}`;
    }
    App.status(`x ${x}  y ${y}  ·  <span class="sw" style="background:rgb(${px})"></span>${px.join(' ')}${where}`);
  },

  // ------------------------------------------------------------------ compare with original
  split: { on: false, pos: 0.5 }, holding: false,

  // The untouched picture of the current document (cached on the doc, so every frame keeps its own)
  async origCanvas(t) {
    const d = t.doc;
    if (d._origCanvas) return d._origCanvas;
    const oc = document.createElement('canvas'), L = d.origLayout;
    if (L.kind === 'raster') {
      oc.width = L.width; oc.height = L.height;
      const out = new Uint8ClampedArray(L.width * L.height * 4); d.renderOrig(out);
      oc.getContext('2d').putImageData(new ImageData(out, L.width, L.height), 0, 0);
    } else {
      try { const bmp = await createImageBitmap(new Blob([d.orig])); oc.width = bmp.width; oc.height = bmp.height; oc.getContext('2d').drawImage(bmp, 0, 0); } catch (e) { return null; }
    }
    d._origCanvas = oc;
    return oc;
  },
  async drawCmp(t) {
    const oc = await Visual.origCanvas(t); if (!oc) return false;
    const c = $('#cmp');
    c.width = oc.width; c.height = oc.height;
    c.getContext('2d').drawImage(oc, 0, 0);
    return true;
  },

  // Hold: the whole picture flips to the original
  async showCompare() {
    const t = App.tab; if (!t) return;
    Visual.holding = true;
    const ok = await Visual.drawCmp(t);
    if (!ok || !Visual.holding) return;
    const c = $('#cmp');
    c.style.clipPath = 'none'; c.style.display = 'block'; $('#compareTag').style.display = 'block';
    $('#splitLine').style.display = 'none';
  },
  hideCompare() {
    Visual.holding = false;
    if (Visual.split.on && App.tab) { Visual.showSplit(); return; }
    $('#cmp').style.display = 'none'; $('#compareTag').style.display = 'none'; $('#splitLine').style.display = 'none';
  },

  // Split view: original on the left of a draggable line, edited on the right
  async setSplit(on) {
    Visual.split.on = on;
    $('#btnSplit').classList.toggle('on', on);
    if (on) await Visual.showSplit(); else Visual.hideCompare();
  },
  async showSplit() {
    const t = App.tab; if (!t || !Visual.split.on) return;
    const ok = await Visual.drawCmp(t);
    if (!ok) { $('#cmp').style.display = 'none'; $('#splitLine').style.display = 'none'; return; }
    if (Visual.holding) return;
    $('#compareTag').style.display = 'none';
    $('#cmp').style.display = 'block';
    $('#splitLine').style.display = 'block';
    Visual.placeSplit();
  },
  placeSplit() {
    const p = DB.clamp(Visual.split.pos, 0, 1) * 100;
    $('#cmp').style.clipPath = `inset(0 ${100 - p}% 0 0)`;
    $('#splitLine').style.left = p + '%';
  },
  initSplit() {
    const line = $('#splitLine i');
    let drag = false;
    const at = (e) => { const r = Visual.wrap.getBoundingClientRect(); Visual.split.pos = DB.clamp((e.clientX - r.left) / r.width, 0, 1); Visual.placeSplit(); };
    line.addEventListener('pointerdown', (e) => { e.stopPropagation(); drag = true; line.setPointerCapture(e.pointerId); });
    line.addEventListener('pointermove', (e) => { if (drag) at(e); });
    line.addEventListener('pointerup', (e) => { drag = false; try { line.releasePointerCapture(e.pointerId); } catch (_) {} });
    $('#splitLine').addEventListener('pointerdown', (e) => e.stopPropagation());
  },
};
