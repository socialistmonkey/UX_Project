/* Hex mode: a full manual hex editor. Locked bytes are greyed out and cannot be edited, everything else can. */
const Hex = {
  RH: 20,
  BPR: 16, auto: true, groupMode: 'px', dec: false, endian: 'le', col: 'hex',
  top: 0, dragging: false, anchor: null, nib: null, nibOff: null, tab: null,
  body: null, rows: null,
  find: { open: false, mode: 'hex', matchCase: false, q: '', hits: [], len: 0, cur: -1, key: '', timer: null, err: '' },

  init() {
    Hex.body = $('#hexbody'); Hex.rows = $('#hexrows');
    try {
      const c = localStorage.getItem('ib.hex.cols'), g = localStorage.getItem('ib.hex.group'), e = localStorage.getItem('ib.hex.endian');
      if (c) { if (c === 'auto') Hex.auto = true; else { Hex.auto = false; Hex.BPR = +c || 16; } }
      if (g) Hex.groupMode = g;
      if (e) Hex.endian = e;
    } catch (e) { /* storage unavailable */ }
    $('#hxCols').value = Hex.auto ? 'auto' : String(Hex.BPR);
    $('#hxGroup').value = Hex.groupMode;
    const b = Hex.body;
    b.addEventListener('mousedown', Hex.mouseDown);
    window.addEventListener('mousemove', Hex.mouseMove);
    window.addEventListener('mouseup', () => { Hex.dragging = false; Hex.thumbDrag = null; });
    b.addEventListener('wheel', (e) => { e.preventDefault(); Hex.scrollBy(Math.round(e.deltaY / 20) || Math.sign(e.deltaY)); }, { passive: false });
    b.addEventListener('keydown', Hex.key);
    $('#hexscroll').addEventListener('mousedown', Hex.scrollDown);
    $('#hxGo').onclick = () => Hex.goto();
    $('#hxFind').onclick = () => Hex.openFind();
    $('#hxCopy').onclick = () => Hex.copy();
    $('#hxCopyTxt').onclick = () => Hex.copyText();
    $('#hxPaste').onclick = () => Hex.paste();
    $('#hxPasteTxt').onclick = () => Hex.pasteText();
    $('#hxFill').onclick = () => Hex.fill('pattern');
    $('#hxZero').onclick = () => Hex.fill('zero');
    $('#hxRand').onclick = () => Hex.fill('rand');
    $('#hxInv').onclick = () => Hex.fill('inv');
    $('#hxRevert').onclick = () => Hex.fill('revert');
    $('#hxInc').onclick = () => Hex.nudge(1);
    $('#hxDec').onclick = () => Hex.nudge(-1);
    $('#hxCols').onchange = (e) => Hex.setCols(e.target.value);
    $('#hxGroup').onchange = (e) => { Hex.groupMode = e.target.value; try { localStorage.setItem('ib.hex.group', Hex.groupMode); } catch (x) { /* ignore */ } Hex.header(); Hex.render(); };
    $('#hexhead').onclick = (e) => { if (e.target.closest('.ho')) { Hex.dec = !Hex.dec; Hex.header(); Hex.render(); } };
    $('#hxMarks').onclick = (e) => { e.stopPropagation(); Hex.marksMenu(); };
    $('#marksMenu').onclick = (e) => Hex.marksClick(e);
    // find bar
    const q = $('#hfQ');
    q.oninput = () => { Hex.find.q = q.value; Hex.runFind(true); };
    q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); Hex.findStep(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') Hex.closeFind(); e.stopPropagation(); };
    $('#hfRep').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); Hex.replaceOne(); } else if (e.key === 'Escape') Hex.closeFind(); e.stopPropagation(); };
    $('#hfMode').onchange = (e) => { Hex.find.mode = e.target.value; q.placeholder = Hex.find.mode === 'hex' ? 'FF D8 ?? E0  (?? = any byte)' : 'Text to find'; Hex.runFind(true); };
    $('#hfCase').onchange = (e) => { Hex.find.matchCase = e.target.checked; Hex.runFind(true); };
    $('#hfPrev').onclick = () => Hex.findStep(-1);
    $('#hfNext').onclick = () => Hex.findStep(1);
    $('#hfRepOne').onclick = () => Hex.replaceOne();
    $('#hfRepAll').onclick = () => Hex.replaceAll();
    $('#hfClose').onclick = () => Hex.closeFind();
    // inspector number boxes
    $('#inspector').addEventListener('keydown', (e) => { if (e.target.dataset && e.target.dataset.kind && e.key === 'Enter') { e.preventDefault(); Hex.writeNumber(e.target); } if (e.key === 'Escape') { e.target.blur(); Hex.body.focus(); } e.stopPropagation(); });
    $('#inspector').addEventListener('change', (e) => { if (e.target.id === 'insEndian') { Hex.endian = e.target.value; try { localStorage.setItem('ib.hex.endian', Hex.endian); } catch (x) { /* ignore */ } Hex.inspect(true); } });
    Hex.header();
  },

  // ------------------------------------------------------------------ geometry
  get t() { return App.tab; },
  pixelSize() { const L = Hex.t && Hex.t.doc.layout; return L && L.kind === 'raster' ? L.bpp : 1; },
  eff() { // bytes per row for the current file
    if (!Hex.auto) return Hex.BPR;
    const L = Hex.t && Hex.t.doc.layout;
    return L && L.kind === 'raster' && L.bpp > 1 ? 24 : 16;
  },
  // rows start on a pixel boundary so channels line up in columns
  shift() {
    const t = Hex.t; if (!t) return 0;
    const L = t.doc.layout, bpp = L.kind === 'raster' ? L.bpp : 1;
    if (bpp <= 1) return 0;
    return (bpp - (t.doc.segments[0].start % bpp)) % bpp;
  },
  rowOf(o) { return Math.floor((o + Hex.shift()) / Hex.eff()); },
  rowOff(r) { return r * Hex.eff() - Hex.shift(); },
  get total() { return Math.ceil((App.tab.doc.buf.length + Hex.shift()) / Hex.eff()); },
  get vis() { return Math.max(1, Math.floor(Hex.body.clientHeight / Hex.RH)); },
  groupSize() { return Hex.groupMode === 'none' ? 0 : Hex.groupMode === 'px' ? (Hex.pixelSize() > 1 ? Hex.pixelSize() : 8) : +Hex.groupMode; },

  setCols(v) {
    const t = Hex.t, keep = t ? Hex.rowOff(t.hexTop) : 0;
    if (v === 'auto') Hex.auto = true; else { Hex.auto = false; Hex.BPR = +v; }
    try { localStorage.setItem('ib.hex.cols', v); } catch (e) { /* ignore */ }
    Hex.header();
    if (t) { t.hexTop = Math.max(0, Hex.rowOf(Math.max(0, keep))); Hex.clampTop(); Hex.render(); }
  },

  header() {
    const n = Hex.eff(), g = Hex.groupSize();
    let h = `<div class="hr"><span class="ho" title="Click to switch between hex and decimal offsets">${Hex.dec ? 'Offset·dec' : 'Offset'}</span><span class="hb">`;
    for (let i = 0; i < n; i++) h += `<i class="${g && i > 0 && i % g === 0 ? 'gap' : ''}">${DB.hex(i & 255)}</i>`;
    $('#hexhead').innerHTML = h + '</span><span class="ha">Text</span></div>';
  },

  attach(tab) {
    Hex.tab = tab; Hex.nib = null;
    if (!tab.hexSel) {
      const z = tab.doc.segments[0];
      tab.hexCur = z.start; tab.hexSel = { a: z.start, b: z.start + 1 }; tab.hexTop = Hex.rowOf(z.start);
    }
    if (!tab.marks) tab.marks = [];
    Hex.header();
    Hex.find.key = ''; Hex.find.hits = [];
    if (Hex.find.open) Hex.runFind(false);
    Hex.layoutChanged();
  },

  layoutChanged() { if (App.mode !== 'hex' || !App.tab) return; Hex.clampTop(); Hex.render(); },
  clampTop() { const t = Hex.t; t.hexTop = DB.clamp(t.hexTop, 0, Math.max(0, Hex.total - Hex.vis)); },

  scrollBy(rows) { const t = Hex.t; if (!t) return; t.hexTop += rows; Hex.clampTop(); Hex.render(); },
  ensureVisible(off) {
    const t = Hex.t, r = Hex.rowOf(off);
    if (r < t.hexTop) t.hexTop = r; else if (r >= t.hexTop + Hex.vis - 1) t.hexTop = r - Hex.vis + 2;
    Hex.clampTop();
  },

  // ------------------------------------------------------------------ drawing
  render() {
    const t = Hex.t; if (!t || App.mode !== 'hex') return;
    const d = t.doc, buf = d.buf, orig = d.orig, L = d.layout, sel = t.hexSel, cur = t.hexCur;
    const colorCh = L.kind === 'raster' && !L.indexed && L.nch >= 3;
    const n = Hex.eff(), g = Hex.groupSize(), sh = Hex.shift();
    const first = t.hexTop, last = Math.min(Hex.total, first + Hex.vis + 1);
    // find hits and bookmarks that fall into the visible window
    const winA = Math.max(0, Hex.rowOff(first)), winB = Math.min(buf.length, Hex.rowOff(last));
    const hit = new Map(), F = Hex.find;
    if (F.open && F.hits.length && F.len) {
      let lo = 0, hi = F.hits.length;
      const from = winA - F.len + 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (F.hits[m] < from) lo = m + 1; else hi = m; }
      for (let i = lo; i < F.hits.length && F.hits[i] < winB; i++) for (let k = 0; k < F.len; k++) hit.set(F.hits[i] + k, i === F.cur ? 2 : 1);
    }
    const marks = new Set((t.marks || []).map((m) => m.off));
    const out = [];
    for (let r = first; r < last; r++) {
      const o0 = Hex.rowOff(r), rowEd = d.isEditable(Math.max(0, o0));
      let hb = '', ha = '';
      for (let i = 0; i < n; i++) {
        const o = o0 + i, gap = g && i > 0 && i % g === 0 ? ' gap' : '';
        if (o < 0) { hb += `<i class="e${gap}"></i>`; ha += '<i class="e"></i>'; continue; }
        if (o >= buf.length) break;
        const l = d.b2l(o), v = buf[o];
        const cls = [];
        if (l < 0) { const z = d.zoneAt(o); cls.push(z && z.kind === 'tables' ? 'tb' : 'lk'); }
        else {
          if (v === 0) cls.push('z');
          if (colorCh) {
            const within = l % L.stride;
            if (within < L.width * L.bpp) { const k = Math.floor((within % L.bpp) / L.cb); cls.push(k === L.ri ? 'c0' : k === L.gi ? 'c1' : k === L.bi ? 'c2' : ''); }
          }
        }
        const modded = v !== orig[o];
        if (modded) cls.push('mod');
        const h = hit.get(o); if (h) cls.push(h === 2 ? 'hitcur' : 'hit');
        if (marks.has(o)) cls.push('bm');
        if (sel && o >= sel.a && o < sel.b) cls.push('sel');
        if (o === cur) cls.push('cur' + (Hex.col === 'ascii' ? ' inA' : ''));
        const pending = Hex.nib !== null && o === Hex.nibOff;
        if (pending) cls.push('pend');
        const txt = pending ? Hex.nib + '_' : DB.hex(v);
        const clsStr = cls.join(' '), ttl = modded ? ` title="was ${DB.hex(orig[o])}"` : '';
        hb += `<i data-o="${o}" class="${clsStr}${gap}"${ttl}>${txt}</i>`;
        ha += `<i data-o="${o}" class="${clsStr}">${v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '·'}</i>`;
      }
      const label = Hex.dec ? String(Math.max(0, o0)).padStart(9, ' ') : DB.hex(Math.max(0, o0), 8);
      out.push(`<div class="hr${rowEd ? ' ez' : ''}" data-r="${r}"><span class="ho">${label}</span><span class="hb">${hb}</span><span class="ha">${ha}</span></div>`);
    }
    Hex.rows.innerHTML = out.join('');
    Hex.thumb();
    Hex.inspect();
    Hex.statusLine();
    if (F.open && F.key && F.key !== Hex.findKey()) Hex.scheduleFind();
  },

  thumb() {
    const t = Hex.t, tr = $('#hexscroll'), th = $('#hexthumb'), H = tr.clientHeight;
    const total = Hex.total, vis = Hex.vis;
    const h = Math.max(28, Math.min(H, (vis / Math.max(total, 1)) * H));
    const span = Math.max(1, total - vis);
    th.style.height = h + 'px';
    th.style.top = (total <= vis ? 0 : (t.hexTop / span) * (H - h)) + 'px';
  },

  statusLine() {
    const t = Hex.t, s = t.hexSel; if (!s) return;
    const n = s.b - s.a;
    $('#hxHint').textContent = n > 1 ? `${n.toLocaleString()} bytes selected · 0x${DB.hex(s.a, 6)} – 0x${DB.hex(s.b - 1, 6)}` : 'Type hex digits to overwrite. Click the text column to type letters. Locked bytes can’t be changed.';
  },

  refresh() { Hex.render(); },

  // ------------------------------------------------------------------ scrollbar
  scrollDown(e) {
    const tr = $('#hexscroll'), th = $('#hexthumb'), H = tr.clientHeight;
    const set = (clientY) => {
      const r = tr.getBoundingClientRect(), h = th.offsetHeight;
      const f = DB.clamp((clientY - r.top - (Hex.thumbDrag ? Hex.thumbDrag.grab : h / 2)) / Math.max(1, H - h), 0, 1);
      Hex.t.hexTop = Math.round(f * Math.max(0, Hex.total - Hex.vis)); Hex.render();
    };
    Hex.thumbDrag = { grab: e.target === th ? e.clientY - th.getBoundingClientRect().top : th.offsetHeight / 2 };
    set(e.clientY);
    const mv = (ev) => { if (!Hex.thumbDrag) { window.removeEventListener('mousemove', mv); return; } set(ev.clientY); };
    window.addEventListener('mousemove', mv);
    e.preventDefault();
  },

  // ------------------------------------------------------------------ selection
  setSel(a, b, cur, silent) {
    const t = Hex.t; if (!t) return;
    t.hexSel = { a: Math.min(a, b), b: Math.max(a, b) }; t.hexCur = cur === undefined ? a : cur;
    Hex.nib = null;
    if (!silent) Hex.onSel();
    Hex.render();
  },
  onSel() {
    FileMap.draw();
    const r = Hex.selectionAsOps();
    if (r && r.w !== undefined) Visual.setHexMarker(r); else Visual.setHexMarker(null);
    Tools.selectionChanged(false);
  },

  offFromEvent(e) { const i = e.target.closest && e.target.closest('i[data-o]'); return i ? +i.dataset.o : null; },

  mouseDown(e) {
    if (e.button !== 0) return;
    Hex.body.focus();
    const ho = e.target.closest && e.target.closest('.ho');
    if (ho) { // click an offset: select that whole row
      const r = +ho.parentElement.dataset.r, a = Math.max(0, Hex.rowOff(r)), b = Math.min(Hex.t.doc.buf.length, Hex.rowOff(r) + Hex.eff());
      Hex.anchor = a; Hex.setSel(a, b, a); e.preventDefault(); return;
    }
    const o = Hex.offFromEvent(e);
    if (o === null) return;
    Hex.col = e.target.closest('.ha') ? 'ascii' : 'hex';
    Hex.dragging = true;
    if (e.shiftKey && Hex.anchor !== null) Hex.setSel(Hex.anchor, Math.max(Hex.anchor, o) + 1, o);
    else { Hex.anchor = o; Hex.setSel(o, o + 1, o); }
    e.preventDefault();
  },
  mouseMove(e) {
    if (!Hex.dragging || !Hex.t) return;
    const el = document.elementFromPoint(e.clientX, e.clientY), i = el && el.closest && el.closest('i[data-o]');
    if (!i) return;
    const o = +i.dataset.o, a = Hex.anchor;
    Hex.setSel(Math.min(a, o), Math.max(a, o) + 1, o);
  },

  selectAll() { const t = Hex.t; Hex.anchor = 0; Hex.setSel(0, t.doc.buf.length, 0); },

  key(e) {
    const t = Hex.t; if (!t) return;
    const mod = e.metaKey || e.ctrlKey, cur = t.hexCur === null ? 0 : t.hexCur, max = t.doc.buf.length - 1, n = Hex.eff();
    const move = (delta, abs) => {
      let q = abs !== undefined ? abs : cur + delta; q = DB.clamp(q, 0, max);
      if (e.shiftKey) { if (Hex.anchor === null) Hex.anchor = cur; Hex.setSel(Math.min(Hex.anchor, q), Math.max(Hex.anchor, q) + 1, q); }
      else { Hex.anchor = q; Hex.setSel(q, q + 1, q); }
      Hex.ensureVisible(q); Hex.render();
      e.preventDefault();
    };
    if (mod) {
      if (e.key === 'a') { Hex.selectAll(); e.preventDefault(); }
      else if (e.key === 'f') { Hex.openFind(); e.preventDefault(); }
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { Hex.nudge((e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 16 : 1)); e.preventDefault(); return; }
    switch (e.key) {
      case 'ArrowLeft': return move(-1);
      case 'ArrowRight': return move(1);
      case 'ArrowUp': return move(-n);
      case 'ArrowDown': return move(n);
      case 'PageUp': return move(-n * Hex.vis);
      case 'PageDown': return move(n * Hex.vis);
      case 'Home': return e.ctrlKey ? move(0, 0) : move(0, cur - (((cur + Hex.shift()) % n)));
      case 'End': return e.ctrlKey ? move(0, max) : move(0, cur - (((cur + Hex.shift()) % n)) + n - 1);
      case 'Tab': Hex.col = Hex.col === 'hex' ? 'ascii' : 'hex'; Hex.nib = null; Hex.render(); e.preventDefault(); return;
      case 'Escape': if (Hex.nib !== null) { Hex.nib = null; Hex.render(); } else if (Hex.find.open) Hex.closeFind(); return;
      case 'F3': Hex.findStep(e.shiftKey ? -1 : 1); e.preventDefault(); return;
      case 'Delete': case 'Backspace':
        if (Hex.nib !== null) { Hex.nib = null; Hex.render(); } else Hex.fill('zero');
        e.preventDefault(); return;
    }
    if (Hex.col === 'ascii') { if (e.key.length === 1) { Hex.typeByte(e.key.charCodeAt(0) & 255); e.preventDefault(); } return; }
    if (/^[0-9a-fA-F]$/.test(e.key)) { Hex.typeDigit(e.key.toUpperCase()); e.preventDefault(); }
  },

  async typeDigit(c) {
    const t = Hex.t, o = t.hexCur; if (o === null) return;
    if (!t.doc.isEditable(o)) { Hex.locked(o); return; }
    if (Hex.nib === null) { Hex.nib = c; Hex.nibOff = o; Hex.render(); return; }
    const byte = parseInt(Hex.nib + c, 16); Hex.nib = null;
    await Hex.typeByte(byte, o);
  },
  async typeByte(byte, o) {
    const t = Hex.t; o = o === undefined ? t.hexCur : o;
    if (o === null || !t.doc.isEditable(o)) { Hex.locked(o === null ? 0 : o); return; }
    const ok = await Hex.writeAt(o, Uint8Array.of(byte), true);
    if (ok && o + 1 <= t.doc.buf.length - 1) { Hex.anchor = o + 1; Hex.setSel(o + 1, o + 2, o + 1); Hex.ensureVisible(o + 1); Hex.render(); }
  },

  locked(off) {
    const z = Hex.t.doc.zoneAt(off), el = Hex.rows.querySelector(`i[data-o="${off}"]`);
    if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    const why = z && z.kind === 'tables' ? 'Use the JPEG detail tables tool to change these safely.' : 'Changing it could make the file unreadable.';
    App.toast(`Locked: ${z ? z.label : 'header'}. ${why}`, 'bad');
  },

  // ------------------------------------------------------------------ writing
  async writeAt(off, bytes, quiet) {
    const t = Hex.t, d = t.doc, l = d.b2l(off);
    if (l < 0) { Hex.locked(off); return false; }
    App.clearPending(); Tools.afterCancel(true);
    const tx = d.begin(); tx.write(l, bytes);
    return App.commit(tx.finish(), `Wrote ${bytes.length.toLocaleString()} byte${bytes.length === 1 ? '' : 's'} at 0x${DB.hex(off, 6)}`, `Hex: wrote ${bytes.length.toLocaleString()} byte${bytes.length === 1 ? '' : 's'} at 0x${DB.hex(off, 6)}`);
  },

  // first / last editable logical offsets within the selection
  selLogical() {
    const t = Hex.t, d = t.doc, s = t.hexSel; if (!s) return null;
    let la = -1, lb = -1;
    if (d.segments.length === 1) {
      const g = d.segments[0], a = Math.max(s.a, g.start), b = Math.min(s.b, g.start + g.len);
      if (b > a) { la = a - g.start; lb = b - g.start; }
    } else {
      for (const g of d.segments) {
        const a = Math.max(s.a, g.start), b = Math.min(s.b, g.start + g.len);
        if (b > a) { if (la < 0) la = g.lstart + (a - g.start); lb = g.lstart + (b - g.start); }
        if (g.start >= s.b) break;
      }
    }
    return la < 0 ? null : { a: la, b: lb };
  },

  selectionAsOps() {
    const t = Hex.t; if (!t || !t.hexSel) return null;
    const d = t.doc, L = d.layout, sl = Hex.selLogical(); if (!sl) return null;
    if (L.kind !== 'raster') return { range: { a: sl.a, b: sl.b }, x: 0, y: 0, w: 0, h: 0 };
    const r0 = Math.floor(sl.a / L.stride), r1 = Math.floor((sl.b - 1) / L.stride);
    if (r0 >= L.height) return null;
    const dispY = (r) => (L.flipY ? L.height - 1 - r : r);
    if (r0 === r1) {
      const x = Math.min(L.width - 1, Math.floor((sl.a - r0 * L.stride) / L.bpp)), x1 = Math.min(L.width, Math.max(x + 1, Math.ceil((sl.b - r0 * L.stride) / L.bpp)));
      return { x, y: dispY(r0), w: x1 - x, h: 1 };
    }
    const ra = Math.min(r0, L.height - 1), rb = Math.min(r1, L.height - 1);
    return { x: 0, y: L.flipY ? dispY(rb) : ra, w: L.width, h: rb - ra + 1 };
  },

  origLogical(a, n) { // the untouched bytes at logical offsets a..a+n
    const d = Hex.t.doc, out = new Uint8Array(n); let pos = 0;
    while (pos < n) { const b = d.l2b(a + pos), seg = d.segments[d._segIndexOfBuf(b)], k = Math.min(seg.start + seg.len - b, n - pos); out.set(d.orig.subarray(b, b + k), pos); pos += k; }
    return out;
  },

  // ------------------------------------------------------------------ copy / paste / fill
  bytesOfSelection() {
    const t = Hex.t, d = t.doc, sl = Hex.selLogical();
    if (sl) return d.read(sl.a, sl.b - sl.a);
    const s = t.hexSel; return s ? d.buf.slice(s.a, s.b) : null;
  },
  toText(bytes) { const n = Math.min(bytes.length, 200000); let s = ''; for (let i = 0; i < n; i++) s += (i ? ' ' : '') + DB.hex(bytes[i]); return s; },
  onCopy(e) {
    const b = Hex.bytesOfSelection(); if (!b || !b.length) return;
    App.clip = b; App.clipText = Hex.toText(b);
    e.clipboardData.setData('text/plain', App.clipText); e.preventDefault();
    App.toast(`Copied ${b.length.toLocaleString()} byte${b.length === 1 ? '' : 's'}`);
  },
  copy() { Hex.body.focus(); document.execCommand('copy'); },
  async copyText() {
    const b = Hex.bytesOfSelection(); if (!b || !b.length) return;
    const s = Array.from(b.subarray(0, 200000), (v) => (v >= 32 && v < 127 ? String.fromCharCode(v) : '.')).join('');
    try { await navigator.clipboard.writeText(s); App.toast(`Copied ${b.length.toLocaleString()} characters`); } catch (e) { App.toast('The clipboard is not available.', 'bad'); }
  },
  parseText(text) {
    const m = (text || '').replace(/0x/gi, ' ').match(/[0-9a-fA-F]{2}/g);
    return m ? Uint8Array.from(m.map((h) => parseInt(h, 16))) : null;
  },
  async onPaste(e) {
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    const bytes = App.clip && text === App.clipText ? App.clip : Hex.parseText(text);
    if (!bytes || !bytes.length) { App.toast('The clipboard has no bytes to paste.'); return; }
    await Hex.pasteBytes(bytes);
  },
  async paste() {
    Hex.body.focus();
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* denied: fall back to the internal clipboard */ }
    const bytes = App.clip && (!text || text === App.clipText) ? App.clip : Hex.parseText(text);
    if (!bytes || !bytes.length) { App.toast('The clipboard has no bytes to paste.'); return; }
    await Hex.pasteBytes(bytes);
  },
  async pasteText() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch (e) { /* ignore */ }
    if (!text) { App.toast('The clipboard has no text to paste.'); return; }
    await Hex.pasteBytes(new TextEncoder().encode(text), 'text');
  },
  async pasteBytes(bytes, kind) {
    const t = Hex.t, d = t.doc, at = t.hexSel ? t.hexSel.a : t.hexCur;
    if (!d.isEditable(at)) { Hex.locked(at); return; }
    const l = d.b2l(at), n = Math.min(bytes.length, d.length - l);
    if (!(await Hex.writeAt(at, bytes.subarray(0, n)))) return;
    Hex.setSel(at, at + n, at);
    App.toast(`Pasted ${n.toLocaleString()} ${kind === 'text' ? 'text ' : ''}bytes at 0x${DB.hex(at, 6)}${n < bytes.length ? ' (clipped at the end of the safe area)' : ''}`, 'good');
  },

  async fill(kind) {
    const t = Hex.t, d = t.doc, sl = Hex.selLogical();
    if (!sl) { App.toast(t.hexSel ? 'That part is locked. Select some pixel or image-data bytes.' : 'Select some bytes first.', 'bad'); return; }
    const n = sl.b - sl.a; let out, label = 'Filled';
    if (kind === 'zero') { out = new Uint8Array(n); label = 'Zeroed'; }
    else if (kind === 'rand') { out = new Uint8Array(n); const r = DB.rng((Math.random() * 1e9) | 0); for (let i = 0; i < n; i++) out[i] = r.int(256); label = 'Randomised'; }
    else if (kind === 'inv') { out = d.read(sl.a, n); for (let i = 0; i < n; i++) out[i] = 255 - out[i]; label = 'Inverted'; }
    else if (kind === 'revert') { out = Hex.origLogical(sl.a, n); label = 'Reverted'; }
    else {
      const pat = Hex.parseText($('#hxPat').value);
      if (!pat || !pat.length) { App.toast('Type a pattern of hex bytes, like FF 00 FF.', 'bad'); return; }
      out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = pat[i % pat.length];
    }
    App.clearPending(); Tools.afterCancel(true);
    const tx = d.begin(); tx.write(sl.a, out);
    await App.commit(tx.finish(), `${label} ${n.toLocaleString()} bytes`, `Hex: ${label.toLowerCase()} ${n.toLocaleString()} bytes`);
  },

  // add or subtract from every selected byte (wraps around)
  async nudge(delta) {
    const t = Hex.t, d = t.doc, sl = Hex.selLogical();
    if (!sl) { App.toast('Select some editable bytes first.', 'bad'); return; }
    const out = d.read(sl.a, sl.b - sl.a);
    for (let i = 0; i < out.length; i++) out[i] = (out[i] + delta) & 255;
    App.clearPending(); Tools.afterCancel(true);
    const tx = d.begin(); tx.write(sl.a, out);
    await App.commit(tx.finish(), `${delta > 0 ? 'Added' : 'Subtracted'} ${Math.abs(delta)} ${delta > 0 ? 'to' : 'from'} ${out.length.toLocaleString()} byte${out.length === 1 ? '' : 's'}`, `Hex: ${delta > 0 ? '+' : '−'}${Math.abs(delta)} on ${out.length.toLocaleString()} bytes`);
  },

  // ------------------------------------------------------------------ navigation
  jumpTo(off) {
    const t = Hex.t; if (!t) return;
    off = DB.clamp(off, 0, t.doc.buf.length - 1);
    t.hexTop = Math.max(0, Hex.rowOf(off) - Math.floor(Hex.vis / 2));
    Hex.anchor = off; Hex.setSel(off, off + 1, off);
    Hex.clampTop(); Hex.render();
  },

  async goto() {
    const t = Hex.t; if (!t) return;
    const d = t.doc, L = d.layout;
    const v = await App.modal({
      title: 'Go to…', input: true, ok: 'Go',
      text: L.kind === 'raster' ? 'Type an offset (<code>0x1F4A</code> or <code>8010</code>), <code>row 300</code>, <code>pixel 120,300</code>, <code>start</code> or <code>end</code>. Use <code>+100</code> or <code>-100</code> to move from here.' : 'Type an offset (<code>0x1F4A</code> or <code>8010</code>), <code>start</code> or <code>end</code>. Use <code>+100</code> or <code>-100</code> to move from here.',
    });
    if (v === null) return;
    const s = v.trim().toLowerCase();
    let off = null, m;
    const rowToOff = (y) => d.l2b((L.flipY ? L.height - 1 - y : y) * L.stride);
    if (s === 'start' || s === 'pixels') off = d.segments[0].start;
    else if (s === 'end') off = d.buf.length - 1;
    else if ((m = /^([+-])\s*(0x[0-9a-f]+|\d+)$/.exec(s))) off = (t.hexCur || 0) + (m[1] === '-' ? -1 : 1) * (m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10));
    else if (L.kind === 'raster' && (m = /^row\s+(\d+)$/.exec(s))) off = rowToOff(Math.min(L.height - 1, +m[1]));
    else if (L.kind === 'raster' && (m = /^(?:pixel\s+)?(\d+)\s*[, ]\s*(\d+)$/.exec(s))) {
      const x = Math.min(L.width - 1, +m[1]), y = Math.min(L.height - 1, +m[2]);
      off = d.l2b((L.flipY ? L.height - 1 - y : y) * L.stride + x * L.bpp);
    }
    else if (/^0x[0-9a-f]+$/.test(s)) off = parseInt(s, 16);
    else if (/^[0-9]+$/.test(s)) off = parseInt(s, 10);
    else if (/^[0-9a-f]+$/.test(s)) off = parseInt(s, 16);
    if (off === null || isNaN(off)) { App.toast('Could not understand that position.', 'bad'); return; }
    if (App.mode !== 'hex') App.setMode('hex');
    Hex.jumpTo(off);
  },

  // When switching from Visual: land on the selected area
  syncFromVisual() {
    const t = Hex.t; if (!t) return;
    const d = t.doc, L = d.layout, s = t.sel;
    if (s && L.kind === 'raster') {
      const r = DB.normSel(L, s, false);
      if (r) {
        const sr = L.flipY ? L.height - 1 - r.y : r.y, a = d.l2b(sr * L.stride + r.x * L.bpp);
        Hex.anchor = a; t.hexTop = Math.max(0, Hex.rowOf(a) - 2); Hex.setSel(a, a + r.w * L.bpp, a); return;
      }
    }
    if (s && L.kind !== 'raster') { const rg = DB.streamRange(d, s), a = d.l2b(rg.a); Hex.anchor = a; t.hexTop = Math.max(0, Hex.rowOf(a) - 2); Hex.setSel(a, Math.min(d.buf.length, a + 64), a); return; }
    Hex.layoutChanged();
  },

  // ------------------------------------------------------------------ bookmarks
  marksMenu() {
    const t = Hex.t, m = $('#marksMenu'); if (!t) return;
    const open = m.classList.contains('open');
    $$('.menu').forEach((x) => x.classList.remove('open'));
    if (open) return;
    let h = '<button data-add="1">Bookmark the cursor<small>Remember this spot</small></button>';
    if (t.marks.length) h += '<hr>' + t.marks.map((k, i) => `<button data-go="${i}">${esc(k.name)}<small>0x${DB.hex(k.off, 8)} · click to jump · <span data-del="${i}">remove</span></small></button>`).join('');
    m.innerHTML = h; m.classList.add('open');
  },
  marksClick(e) {
    const t = Hex.t, b = e.target.closest('button'); if (!b || !t) return;
    const del = e.target.closest('[data-del]');
    if (del) { t.marks.splice(+del.dataset.del, 1); e.stopPropagation(); Hex.marksMenu(); Hex.render(); return; }
    if (b.dataset.add) {
      const o = t.hexCur || 0, z = t.doc.zoneAt(o);
      if (!t.marks.some((k) => k.off === o)) t.marks.push({ off: o, name: `${z ? z.label : 'Offset'} · ${o.toLocaleString()}` });
      Hex.render(); App.toast('Bookmarked 0x' + DB.hex(o, 6));
    } else if (b.dataset.go !== undefined) Hex.jumpTo(t.marks[+b.dataset.go].off);
  },

  // ------------------------------------------------------------------ find and replace
  findKey() { const F = Hex.find, t = Hex.t; return `${F.q}|${F.mode}|${F.matchCase}|${t ? t.doc.version : 0}|${t ? t.id : 0}`; },
  openFind() {
    const t = Hex.t; if (!t) return;
    if (App.mode !== 'hex') App.setMode('hex');
    const F = Hex.find; F.open = true;
    $('#hexfind').classList.add('open');
    const s = t.hexSel;
    if (s && s.b - s.a > 1 && s.b - s.a <= 32 && F.mode === 'hex') { $('#hfQ').value = Hex.toText(t.doc.buf.subarray(s.a, s.b)); F.q = $('#hfQ').value; }
    $('#hfQ').focus(); $('#hfQ').select();
    Hex.runFind(false);
  },
  closeFind() { Hex.find.open = false; $('#hexfind').classList.remove('open'); Hex.find.hits = []; Hex.body.focus(); Hex.render(); },
  pattern() {
    const F = Hex.find;
    if (F.mode === 'hex') return DB.parseHex(F.q, true);
    return Array.from(new TextEncoder().encode(F.q));
  },
  scheduleFind() { clearTimeout(Hex.find.timer); Hex.find.timer = setTimeout(() => Hex.runFind(false, true), 150); },
  runFind(jump, keepCur) {
    const F = Hex.find, t = Hex.t; if (!t) return;
    let pat;
    try { pat = F.q ? Hex.pattern() : []; F.err = ''; } catch (e) { F.err = e.message; pat = []; }
    F.hits = []; F.len = pat.length;
    const prevStart = keepCur && F.cur >= 0 ? F.hitsPrev : null;
    if (pat.length && !pat.every((x) => x < 0)) {
      const buf = t.doc.buf, n = buf.length, ci = F.mode === 'text' && !F.matchCase, m = pat.length;
      const isLetter = (x) => (x >= 65 && x <= 90) || (x >= 97 && x <= 122);
      let k0 = pat.findIndex((x) => x >= 0);
      const first = pat[k0], firstCi = ci && isLetter(first);
      for (let i = 0; i + m <= n && F.hits.length < 50000; i++) {
        const b0 = buf[i + k0];
        if (firstCi ? (b0 | 32) !== (first | 32) : b0 !== first) continue;
        let ok = true;
        for (let k = 0; k < m; k++) {
          const p = pat[k]; if (p < 0) continue;
          const b = buf[i + k];
          if (ci && isLetter(p) ? (b | 32) !== (p | 32) : b !== p) { ok = false; break; }
        }
        if (ok) F.hits.push(i);
      }
    }
    F.key = Hex.findKey();
    F.cur = -1;
    if (F.hits.length && jump) { const from = t.hexCur || 0; let i = F.hits.findIndex((h) => h >= from); if (i < 0) i = 0; F.cur = i; Hex.showHit(); }
    Hex.findCount(); Hex.render();
  },
  findCount() {
    const F = Hex.find, el = $('#hfCount');
    if (F.err) el.textContent = F.err;
    else if (!F.q) el.textContent = '';
    else if (!F.hits.length) el.textContent = 'No matches';
    else el.textContent = `${F.cur >= 0 ? F.cur + 1 + ' of ' : ''}${F.hits.length.toLocaleString()}${F.hits.length >= 50000 ? '+' : ''} match${F.hits.length === 1 ? '' : 'es'}`;
  },
  showHit() {
    const F = Hex.find, t = Hex.t, o = F.hits[F.cur]; if (o === undefined) return;
    Hex.anchor = o; t.hexTop = Math.max(0, Hex.rowOf(o) - Math.floor(Hex.vis / 2));
    t.hexSel = { a: o, b: o + F.len }; t.hexCur = o; Hex.nib = null; Hex.clampTop(); Hex.onSel();
    Hex.findCount();
  },
  findStep(dir) {
    const F = Hex.find, t = Hex.t; if (!t) return;
    if (!F.open) { Hex.openFind(); return; }
    if (F.key !== Hex.findKey()) Hex.runFind(false);
    if (!F.hits.length) return;
    const from = t.hexSel ? t.hexSel.a : 0;
    let i;
    if (dir > 0) { i = F.hits.findIndex((h) => h > from); if (i < 0) i = 0; }
    else { i = -1; for (let k = F.hits.length - 1; k >= 0; k--) if (F.hits[k] < from) { i = k; break; } if (i < 0) i = F.hits.length - 1; }
    F.cur = i; Hex.showHit(); Hex.render();
  },
  async replaceBytes(hits) {
    const t = Hex.t, d = t.doc, F = Hex.find;
    let rep;
    try { rep = DB.parseHex($('#hfRep').value, true); } catch (e) { App.toast(e.message, 'bad'); return null; }
    if (F.mode === 'text' && !/^\s*([0-9a-f]{2}|\?\?)([\s,]*([0-9a-f]{2}|\?\?))*\s*$/i.test($('#hfRep').value)) rep = Array.from(new TextEncoder().encode($('#hfRep').value));
    if (!rep.length) { App.toast('Type what to write over each match.', 'bad'); return null; }
    App.clearPending(); Tools.afterCancel(true);
    const tx = d.begin(); let done = 0, skipped = 0;
    for (const o of hits) {
      const l = d.b2l(o), end = d.b2l(Math.min(d.buf.length - 1, o + rep.length - 1));
      if (l < 0 || end !== l + Math.min(rep.length, d.buf.length - o) - 1) { skipped++; continue; }
      const cur = d.read(l, rep.length), out = Uint8Array.from(rep, (v, i) => (v < 0 ? cur[i] : v));
      tx.write(l, out); done++;
    }
    if (!done) { App.toast(skipped ? 'Those matches are in locked bytes, so nothing was replaced.' : 'Nothing to replace.', 'bad'); d.revertPatch(tx.finish()); return null; }
    await App.commit(tx.finish(), `Replaced ${done.toLocaleString()} match${done === 1 ? '' : 'es'}`, `Hex: replace ${done.toLocaleString()} match${done === 1 ? '' : 'es'}`);
    if (skipped) App.toast(`${skipped} match${skipped === 1 ? ' was' : 'es were'} in locked bytes and left alone.`);
    return done;
  },
  async replaceOne() {
    const F = Hex.find; if (F.key !== Hex.findKey()) Hex.runFind(false);
    if (F.cur < 0) { Hex.findStep(1); return; }
    const o = F.hits[F.cur];
    await Hex.replaceBytes([o]);
    Hex.runFind(false); Hex.findStep(1);
  },
  async replaceAll() {
    const F = Hex.find; if (F.key !== Hex.findKey()) Hex.runFind(false);
    if (!F.hits.length) { App.toast('No matches to replace.'); return; }
    await Hex.replaceBytes(F.hits.slice());
    Hex.runFind(false);
  },

  // ------------------------------------------------------------------ inspector
  inspect(force) {
    const t = Hex.t, d = t.doc, L = d.layout, ins = $('#inspector'), o = t.hexCur;
    if (o === null || o === undefined) { ins.innerHTML = ''; return; }
    const a = document.activeElement;
    if (!force && a && ins.contains(a) && a.tagName === 'INPUT') return; // don't disturb someone typing a number
    const v = d.buf[o], z = d.zoneAt(o), l = d.b2l(o), ed = l >= 0;
    const rows = [];
    rows.push(['Offset', `0x${DB.hex(o, 8)}  ·  ${o.toLocaleString()}`]);
    rows.push(['Zone', ed ? `${z ? esc(z.label) : 'Editable'} · safe to edit` : `<span class="lockedtxt">${z ? esc(z.label) : 'Locked'} · locked. Changing it could make the file unreadable.</span>`]);
    rows.push(['Value', `0x${DB.hex(v)}  ·  ${v}  ·  ${v.toString(2).padStart(8, '0')}`]);
    if (ed && L.kind === 'raster') {
      const sr = Math.floor(l / L.stride), within = l % L.stride, y = L.flipY ? L.height - 1 - sr : sr;
      if (within < L.width * L.bpp && sr < L.height) {
        const x = Math.floor(within / L.bpp), k = Math.floor((within % L.bpp) / L.cb);
        const name = L.indexed ? 'palette index' : k === L.ri ? 'red' : k === L.gi ? 'green' : k === L.bi ? 'blue' : k === L.ai ? 'alpha' : '';
        let sw = '';
        if (t.imgData) { const i = (y * L.width + x) * 4, px = t.imgData.data; sw = `<span class="sw" style="background:rgb(${px[i]},${px[i + 1]},${px[i + 2]})"></span>`; }
        rows.push(['Pixel', `${sw}x ${x}, y ${y}  ·  ${name} channel`]);
      } else rows.push(['Pixel', 'row padding (ignored by viewers)']);
    }
    const s = t.hexSel;
    if (s && s.b - s.a > 1) {
      let extra = '';
      if (L.kind === 'raster' && ed) { const rl = (s.b - s.a) / L.stride, px = (s.b - s.a) / L.bpp; if (Number.isInteger(rl)) extra = `  =  ${rl} full row${rl === 1 ? '' : 's'}`; else if (Number.isInteger(px)) extra = `  =  ${px.toLocaleString()} pixels`; }
      rows.push(['Selection', `${(s.b - s.a).toLocaleString()} bytes${extra}`]);
    }
    // numbers at the cursor
    const buf8 = new Uint8Array(8); buf8.set(d.buf.subarray(o, o + 8));
    const dv = new DataView(buf8.buffer), le = Hex.endian === 'le', fits = (n) => o + n <= d.buf.length;
    const fld = (kind, label, val, n) => `<label>${label}<input data-kind="${kind}" value="${esc(val)}" ${fits(n) ? '' : 'disabled'} spellcheck="false"></label>`;
    const f32 = fits(4) ? dv.getFloat32(0, le) : NaN;
    const nums = [
      fld('u8', 'u8', dv.getUint8(0), 1), fld('i8', 'i8', dv.getInt8(0), 1),
      fld('u16', 'u16', fits(2) ? dv.getUint16(0, le) : '', 2), fld('i16', 'i16', fits(2) ? dv.getInt16(0, le) : '', 2),
      fld('u32', 'u32', fits(4) ? dv.getUint32(0, le) : '', 4), fld('i32', 'i32', fits(4) ? dv.getInt32(0, le) : '', 4),
      fld('f32', 'float', fits(4) ? (Number.isFinite(f32) ? +f32.toPrecision(7) : String(f32)) : '', 4),
    ].join('');
    ins.innerHTML = `<div class="insl">${rows.map(([k, val]) => `<span class="k">${k}</span><span class="v">${val}</span>`).join('')}</div>
      <div class="insr"><div class="insh"><span>Numbers at the cursor · press Enter in a box to write it</span><select id="insEndian"><option value="le"${le ? ' selected' : ''}>Low byte first</option><option value="be"${le ? '' : ' selected'}>High byte first</option></select></div><div class="insg">${nums}</div></div>`;
  },

  async writeNumber(input) {
    const t = Hex.t, o = t.hexCur, kind = input.dataset.kind, le = Hex.endian === 'le';
    const size = { u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4 }[kind];
    let val = Number(String(input.value).trim());
    if (!Number.isFinite(val) && kind !== 'f32') { App.toast('Type a number.', 'bad'); return; }
    const lim = { u8: [0, 255], i8: [-128, 127], u16: [0, 65535], i16: [-32768, 32767], u32: [0, 4294967295], i32: [-2147483648, 2147483647] }[kind];
    if (lim && (val < lim[0] || val > lim[1] || !Number.isInteger(val))) { App.toast(`That does not fit: ${kind} goes from ${lim[0].toLocaleString()} to ${lim[1].toLocaleString()}.`, 'bad'); return; }
    const dv = new DataView(new ArrayBuffer(4));
    if (kind === 'u8') dv.setUint8(0, val); else if (kind === 'i8') dv.setInt8(0, val);
    else if (kind === 'u16') dv.setUint16(0, val, le); else if (kind === 'i16') dv.setInt16(0, val, le);
    else if (kind === 'u32') dv.setUint32(0, val, le); else if (kind === 'i32') dv.setInt32(0, val, le); else dv.setFloat32(0, val, le);
    const bytes = new Uint8Array(dv.buffer, 0, size);
    for (let i = 0; i < size; i++) if (!t.doc.isEditable(o + i)) { Hex.locked(o + i); return; }
    input.blur(); Hex.body.focus();
    await Hex.writeAt(o, Uint8Array.from(bytes));
    Hex.setSel(o, o + size, o);
  },
};
