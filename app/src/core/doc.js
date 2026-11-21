(function () {
  const DB = (globalThis.DB = globalThis.DB || {});

  /**
   * A Doc is one open image.
   *
   *  buf       the "edit buffer" — the file's bytes (BMP/TIFF/JPEG/GIF) or the decompressed pixels (PNG)
   *  segments  the ONLY places that may be edited, as {start, len} ranges of buf
   *  logical   the segments laid end to end. Every tool works in logical offsets, so a tool can never
   *            touch a header, a metadata block or a length byte — it has no way to address them.
   *  zones     everything in buf labelled for the hex view (locked headers, editable pixels, ...)
   */
  class Doc {
    constructor(o) {
      this.format = o.format;
      this.name = o.name || 'untitled';
      this.buf = o.buf;
      this.orig = o.buf.slice(); // pristine copy for "compare" and "revert"
      this.zones = o.zones;
      this.layout = o.layout;
      this.origLayout = o.layout;
      this.meta = o.meta || {};
      this.h = o.handler; // format handler: render / exportBytes / sanitize / ...
      this.notes = o.notes || []; // friendly warnings shown in the UI
      this.undoStack = [];
      this.redoStack = [];
      this.historyBytes = 0;
      this.version = 0;
      this._viewCache = null;
      this._viewVer = -1;
      this.setSegments(o.segments);
    }

    setSegments(segs) {
      let l = 0;
      this.segments = segs.map((s) => {
        const seg = { start: s.start, len: s.len, lstart: l };
        l += s.len;
        return seg;
      });
      this.length = l;
    }

    // ---------- address translation ----------
    l2b(l) {
      const s = this.segments;
      if (s.length === 1) return s[0].start + l;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (s[mid].lstart <= l) lo = mid; else hi = mid - 1;
      }
      return s[lo].start + (l - s[lo].lstart);
    }
    // buffer offset -> logical offset, or -1 when that byte is locked
    b2l(off) {
      const s = this.segments;
      let lo = 0, hi = s.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const g = s[mid];
        if (off < g.start) hi = mid - 1;
        else if (off >= g.start + g.len) lo = mid + 1;
        else return g.lstart + (off - g.start);
      }
      return -1;
    }
    isEditable(off) { return this.b2l(off) >= 0; }
    zoneAt(off) {
      const z = this.zones;
      let lo = 0, hi = z.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (off < z[mid].start) hi = mid - 1;
        else if (off >= z[mid].end) lo = mid + 1;
        else return z[mid];
      }
      return null;
    }

    // Contiguous view of the logical bytes (live subarray when there is one segment)
    view() {
      if (this.segments.length === 1) return this.buf.subarray(this.segments[0].start, this.segments[0].start + this.length);
      if (this._viewCache && this._viewVer === this.version) return this._viewCache;
      const out = new Uint8Array(this.length);
      for (const g of this.segments) out.set(this.buf.subarray(g.start, g.start + g.len), g.lstart);
      this._viewCache = out; this._viewVer = this.version;
      return out;
    }
    read(l, n) { // copy of logical bytes l..l+n (clipped), without building the whole view
      l = Math.max(0, l); n = Math.max(0, Math.min(n, this.length - l));
      if (this.segments.length === 1) { const s = this.segments[0].start + l; return this.buf.slice(s, s + n); }
      const out = new Uint8Array(n);
      let pos = 0;
      while (pos < n) {
        const b = this.l2b(l + pos);
        const seg = this.segments[this._segIndexOfBuf(b)];
        const k = Math.min(seg.start + seg.len - b, n - pos);
        out.set(this.buf.subarray(b, b + k), pos);
        pos += k;
      }
      return out;
    }

    // ---------- transactions ----------
    begin() { return new Tx(this); }

    _writeLogicalRaw(l, bytes) { // writes bytes into buf along the segments; assumes in range
      if (this.segments.length === 1) { this.buf.set(bytes, this.segments[0].start + l); return; }
      let pos = 0;
      while (pos < bytes.length) {
        const b = this.l2b(l + pos);
        const seg = this.segments[this._segIndexOfBuf(b)];
        const room = seg.start + seg.len - b;
        const n = Math.min(room, bytes.length - pos);
        this.buf.set(bytes.subarray(pos, pos + n), b);
        pos += n;
      }
    }
    _segIndexOfBuf(b) {
      const s = this.segments;
      let lo = 0, hi = s.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid].start <= b) lo = mid; else hi = mid - 1; }
      return lo;
    }

    applyPatch(p) { // redo
      for (const e of p.entries) { if (e.k === 'b') this.buf.set(e.b, e.off); else e.redo(); }
      this.version++;
    }
    revertPatch(p) { // undo
      for (let i = p.entries.length - 1; i >= 0; i--) { const e = p.entries[i]; if (e.k === 'b') this.buf.set(e.a, e.off); else e.undo(); }
      this.version++;
    }
    commit(p) {
      if (!p.entries.length) return;
      this.undoStack.push(p);
      this.historyBytes += p.size;
      this.redoStack.length = 0;
      while (this.historyBytes > 500e6 && this.undoStack.length > 1) this.historyBytes -= this.undoStack.shift().size;
    }
    undo() {
      const p = this.undoStack.pop();
      if (!p) return null;
      this.revertPatch(p); this.redoStack.push(p); this.historyBytes -= p.size;
      return p;
    }
    redo() {
      const p = this.redoStack.pop();
      if (!p) return null;
      this.applyPatch(p); this.undoStack.push(p); this.historyBytes += p.size;
      return p;
    }
    // Which display rows does a patch touch? null = everything
    dirtyRows(p) {
      if (p.full || this.layout.kind !== 'raster') return null;
      if (this.h.alwaysFull && this.h.alwaysFull(this)) return null;
      const L = this.layout;
      let lo = Infinity, hi = -1;
      for (const e of p.entries) {
        if (e.k !== 'b') return null;
        const a = this.b2l(e.off);
        const bEnd = this.b2l(e.off + e.b.length - 1);
        if (a < 0 || bEnd < 0) return null;
        lo = Math.min(lo, a); hi = Math.max(hi, bEnd);
      }
      if (hi < 0) return [0, 0];
      const r0 = Math.floor(lo / L.stride), r1 = Math.floor(hi / L.stride) + 1;
      return L.flipY ? [L.height - r1, L.height - r0] : [r0, r1];
    }

    // The untouched pixels, for "hold to compare"
    origView() {
      if (this.segments.length === 1) return this.orig.subarray(this.segments[0].start, this.segments[0].start + this.length);
      const out = new Uint8Array(this.length);
      for (const g of this.segments) out.set(this.orig.subarray(g.start, g.start + g.len), g.lstart);
      return out;
    }
    renderOrig(out) { DB.renderRaster(this.origLayout, this.origView(), out, 0, this.origLayout.height); }

    async exportBytes() { return this.h.exportBytes(this); }
    isModified() { return this.undoStack.length > 0; }

    // ---------- whole-state swaps (header edits change what the file means, so we re-read it) ----------
    snapshot() { return { buf: this.buf, segments: this.segments, length: this.length, zones: this.zones, layout: this.layout, meta: this.meta, notes: this.notes }; }
    restoreState(s) {
      this.buf = s.buf; this.segments = s.segments; this.length = s.length; this.zones = s.zones;
      this.layout = s.layout; this.meta = s.meta; this.notes = s.notes;
      this._viewCache = null; this.version++;
    }

    // An independent copy with its own bytes and an empty history
    clone() {
      const c = Object.create(Doc.prototype);
      Object.assign(c, this);
      c.buf = this.buf.slice();
      c.segments = this.segments.map((g) => ({ start: g.start, len: g.len, lstart: g.lstart }));
      c.layout = structuredClone(this.layout);
      c.meta = structuredClone(this.meta);
      c.notes = this.notes.slice();
      c.undoStack = []; c.redoStack = []; c.historyBytes = 0; c.version = 0;
      c._viewCache = null; c._viewVer = -1;
      return c;
    }
  }

  class Tx {
    constructor(doc) {
      this.doc = doc; this.entries = []; this.size = 0; this.full = false; this.touched = [];
    }
    // logical write, clipped to the editable area. Returns how many bytes were accepted.
    write(l, bytes) {
      const d = this.doc;
      if (l < 0) { bytes = bytes.subarray(-l); l = 0; }
      if (l >= d.length || !bytes.length) return 0;
      if (l + bytes.length > d.length) bytes = bytes.subarray(0, d.length - l);
      const cur = d.read(l, bytes.length);
      // Compare against what is there; store only the runs that really change
      if (bytes.length <= 512) {
        let a = -1, z = -1;
        for (let i = 0; i < bytes.length; i++) if (cur[i] !== bytes[i]) { if (a < 0) a = i; z = i; }
        if (a < 0) return bytes.length;
        this._rec(l + a, cur.slice(a, z + 1), bytes.slice(a, z + 1));
      } else {
        const runs = DB.diffRuns(cur, bytes, 32);
        for (const r of runs) this._rec(l + r.off, r.a, r.b);
      }
      return bytes.length;
    }
    _rec(l, oldB, newB) {
      const d = this.doc;
      // split on segment boundaries so entries address buf directly
      let pos = 0;
      while (pos < newB.length) {
        const b = d.l2b(l + pos);
        const seg = d.segments[d._segIndexOfBuf(b)];
        const n = Math.min(seg.start + seg.len - b, newB.length - pos);
        const e = { k: 'b', off: b, a: oldB.slice(pos, pos + n), b: newB.slice(pos, pos + n) };
        d.buf.set(e.b, b);
        this.entries.push(e); this.size += n * 2;
        pos += n;
      }
      this.touched.push([l, l + newB.length]);
      d.version++;
    }
    fill(l, n, v) { return this.write(l, new Uint8Array(n).fill(v)); }
    // sanctioned write straight into buf (header fields only). Format code uses this, tools never do.
    raw(off, bytes) {
      const d = this.doc;
      const e = { k: 'b', off, a: d.buf.slice(off, off + bytes.length), b: bytes.slice(), raw: true };
      d.buf.set(e.b, off);
      this.entries.push(e); this.size += bytes.length * 2; d.version++;
    }
    // Swap in a freshly parsed Doc state (same buffer length or not). Undoable.
    reopen(nd) {
      const d = this.doc, old = d.snapshot(), nw = { buf: nd.buf, segments: nd.segments, length: nd.length, zones: nd.zones, layout: nd.layout, meta: nd.meta, notes: nd.notes };
      this.meta(() => d.restoreState(nw), () => d.restoreState(old), nd.buf.length);
    }
    // Make the changes this transaction made gentler: strength (0-100) cross-fades each changed byte back toward
    // what it was; coverage (0-100) keeps only that share of the changed spots. Header writes are left alone.
    fade(strength, coverage, seed) {
      const d = this.doc;
      let s = strength == null ? 1 : DB.clamp(strength, 0, 100) / 100, c = coverage == null ? 1 : DB.clamp(coverage, 0, 100) / 100;
      if (s >= 1 && c >= 1) return;
      const data = this.entries.filter((e) => e.k === 'b' && !e.raw);
      if (!data.length) return;
      // merge the touched byte ranges
      const spans = data.map((e) => [e.off, e.off + e.b.length]).sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const sp of spans) { const l = merged[merged.length - 1]; if (l && sp[0] <= l[1]) l[1] = Math.max(l[1], sp[1]); else merged.push(sp.slice()); }
      const rng = DB.rng((seed || 1) * 2654435761 + 12345);
      const indexed = !!(d.layout && d.layout.indexed);
      const keep = this.entries.filter((e) => !(e.k === 'b' && !e.raw));
      const fresh = [];
      for (const [lo, hi] of merged) {
        const fin = d.buf.slice(lo, hi), orig = fin.slice();
        for (let i = data.length - 1; i >= 0; i--) { const e = data[i]; if (e.off >= lo && e.off + e.a.length <= hi) orig.set(e.a, e.off - lo); }
        const out = orig.slice();
        let i = 0;
        while (i < fin.length) {
          if (fin[i] === orig[i]) { i++; continue; }
          let j = i + 1, last = i; // one "spot" = changed bytes with small gaps
          while (j < fin.length && j - last <= 8) { if (fin[j] !== orig[j]) last = j; j++; }
          const end = last + 1, take = c >= 1 || rng() < c;
          if (take) for (let k = i; k < end; k++) {
            if (fin[k] === orig[k]) continue;
            if (indexed) out[k] = s >= 1 || rng() < s ? fin[k] : orig[k]; // palette numbers can't be blended, so thin them out
            else out[k] = Math.round(orig[k] + (fin[k] - orig[k]) * s);
          }
          i = end;
        }
        d.buf.set(out, lo);
        for (const r of DB.diffRuns(orig, out, 32)) fresh.push({ k: 'b', off: lo + r.off, a: r.a, b: r.b });
      }
      this.entries = keep.concat(fresh);
      this.size = this.entries.reduce((a, e) => a + (e.k === 'b' ? e.b.length * 2 : 64), 0);
      d.version++;
    }
    // run redo() now, remember undo() for later (geometry changes, PNG filter table, ...)
    meta(redo, undo, size) {
      redo();
      this.entries.push({ k: 'm', redo, undo }); this.size += size || 64; this.full = true; this.doc.version++;
    }
    finish() {
      const d = this.doc;
      if (d.h.sanitize && this.touched.length) d.h.sanitize(this, d, this.touched);
      return { entries: this.entries, size: this.size, full: this.full };
    }
  }

  DB.Doc = Doc;
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
