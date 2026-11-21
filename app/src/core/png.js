(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const { u32, put32 } = DB;

  // ---------- zlib via the platform's streams (works in Electron's renderer and in Node 18+) ----------
  async function readAll(readable) {
    const reader = readable.getReader(), chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
      }
    } catch (e) { /* truncated stream: keep what we got */ }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  async function pipe(Stream, kind, u8) {
    const s = new Stream(kind);
    const w = s.writable.getWriter();
    const writing = w.write(u8).then(() => w.close()).catch(() => {});
    const out = await readAll(s.readable);
    await writing;
    return out;
  }
  DB.inflate = (u8) => pipe(DecompressionStream, 'deflate', u8);
  DB.deflate = (u8) => pipe(CompressionStream, 'deflate', u8);

  // ---------- PNG scanline filters ----------
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  // filtered rows [type, bytes...] -> raw pixels. `claimed` (optional) overrides the type each row announces.
  function unfilter(src, stride, fb, rows, claimed, typesOut) {
    const rs = stride + 1, raw = new Uint8Array(rows * stride);
    for (let y = 0; y < rows; y++) {
      const ft = claimed ? claimed[y] : src[y * rs];
      if (typesOut) typesOut[y] = src[y * rs];
      const so = y * rs + 1, d = y * stride, up = d - stride;
      switch (ft) {
        case 1:
          for (let i = 0; i < stride; i++) raw[d + i] = src[so + i] + (i >= fb ? raw[d + i - fb] : 0);
          break;
        case 2:
          for (let i = 0; i < stride; i++) raw[d + i] = src[so + i] + (y ? raw[up + i] : 0);
          break;
        case 3:
          for (let i = 0; i < stride; i++) raw[d + i] = src[so + i] + (((i >= fb ? raw[d + i - fb] : 0) + (y ? raw[up + i] : 0)) >> 1);
          break;
        case 4:
          for (let i = 0; i < stride; i++) {
            const a = i >= fb ? raw[d + i - fb] : 0, b = y ? raw[up + i] : 0, c = i >= fb && y ? raw[up + i - fb] : 0;
            raw[d + i] = src[so + i] + paeth(a, b, c);
          }
          break;
        default:
          for (let i = 0; i < stride; i++) raw[d + i] = src[so + i];
      }
    }
    return raw;
  }

  // raw pixels -> filtered rows using the given per-row types
  function filterRows(raw, stride, fb, rows, types) {
    const rs = stride + 1, out = new Uint8Array(rows * rs);
    for (let y = 0; y < rows; y++) {
      const ft = types[y], so = y * rs + 1, d = y * stride, up = d - stride;
      out[y * rs] = ft;
      switch (ft) {
        case 1:
          for (let i = 0; i < stride; i++) out[so + i] = raw[d + i] - (i >= fb ? raw[d + i - fb] : 0);
          break;
        case 2:
          for (let i = 0; i < stride; i++) out[so + i] = raw[d + i] - (y ? raw[up + i] : 0);
          break;
        case 3:
          for (let i = 0; i < stride; i++) out[so + i] = raw[d + i] - (((i >= fb ? raw[d + i - fb] : 0) + (y ? raw[up + i] : 0)) >> 1);
          break;
        case 4:
          for (let i = 0; i < stride; i++) {
            const a = i >= fb ? raw[d + i - fb] : 0, b = y ? raw[up + i] : 0, c = i >= fb && y ? raw[up + i - fb] : 0;
            out[so + i] = raw[d + i] - paeth(a, b, c);
          }
          break;
        default:
          for (let i = 0; i < stride; i++) out[so + i] = raw[d + i];
      }
    }
    return out;
  }
  DB.pngUnfilter = unfilter; DB.pngFilter = filterRows;

  const mkChunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    put32(out, 0, data.length, false);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    put32(out, 8 + data.length, DB.crc32(out, 4, 8 + data.length), false);
    return out;
  };

  DB.pngChunk = mkChunk;

  const sameRows = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

  const PNG = {
    id: 'png', label: 'PNG',
    sanitize: (tx, doc, t) => DB.indexSanitizer(tx, doc, t),
    alwaysFull(doc) { return !sameRows(doc.meta.trueTypes, doc.meta.claimed); },
    // What a viewer would show: the raw pixels, unless some rows lie about their filter type.
    source(doc) {
      const m = doc.meta;
      if (sameRows(m.trueTypes, m.claimed)) return doc.view();
      if (m.sim && m.simVer === doc.version) return m.sim;
      const L = doc.layout;
      const filtered = filterRows(doc.view(), L.stride, L.bpp, L.height, m.trueTypes);
      m.sim = unfilter(filtered, L.stride, L.bpp, L.height, m.claimed);
      m.simVer = doc.version;
      return m.sim;
    },
    render(doc, out, r0, r1) { DB.renderRaster(doc.layout, PNG.source(doc), out, r0, r1); },

    async exportBytes(doc) {
      const L = doc.layout, m = doc.meta, rows = L.height;
      const filtered = filterRows(doc.view().subarray(0, rows * L.stride), L.stride, L.bpp, rows, m.trueTypes);
      for (let y = 0; y < rows; y++) filtered[y * (L.stride + 1)] = m.claimed[y]; // the "lie" a viewer will believe
      const z = await DB.deflate(filtered);
      const ihdr = m.ihdr.slice();
      put32(ihdr, 0, L.width, false); put32(ihdr, 4, rows, false);
      const parts = [Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), mkChunk('IHDR', ihdr), ...m.pre];
      const piece = m.idatSize || (1 << 20);
      for (let p = 0; p < z.length; p += piece) parts.push(mkChunk('IDAT', z.subarray(p, Math.min(z.length, p + piece))));
      parts.push(...m.post, mkChunk('IEND', new Uint8Array(0)));
      let total = 0; for (const p of parts) total += p.length;
      const out = new Uint8Array(total); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },

    // Make rows announce a different filter type than the one the data was written with.
    setFilters(tx, doc, r0, r1, pick) {
      const m = doc.meta, old = m.claimed.slice(), next = m.claimed.slice();
      for (let y = Math.max(0, r0); y < Math.min(next.length, r1); y++) next[y] = pick(y);
      tx.meta(() => { m.claimed = next; }, () => { m.claimed = old; }, old.length * 2);
    },
    setWidth(tx, doc, newW) {
      const L = doc.layout, m = doc.meta, stride = newW * L.bpp, newH = Math.max(1, Math.floor(doc.length / stride));
      const L2 = Object.assign({}, L, { width: newW, height: newH, stride });
      const oT = m.trueTypes, oC = m.claimed, nT = new Uint8Array(newH), nC = new Uint8Array(newH);
      tx.meta(() => { doc.layout = L2; m.trueTypes = nT; m.claimed = nC; }, () => { doc.layout = L; m.trueTypes = oT; m.claimed = oC; }, 4096);
    },
  };

  DB.openPNG = async function (bytes, name) {
    let pos = 8, ihdr = null, plte = null, seenIdat = false;
    const idat = [], pre = [], post = [];
    while (pos + 12 <= bytes.length) {
      const len = u32(bytes, pos, false);
      const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (pos + 12 + len > bytes.length) break;
      const data = bytes.subarray(pos + 8, pos + 8 + len), whole = bytes.slice(pos, pos + 12 + len);
      if (type === 'IHDR') ihdr = data.slice();
      else if (type === 'IDAT') { idat.push(data); seenIdat = true; }
      else if (type === 'IEND') break;
      else { if (type === 'PLTE') plte = data.slice(); (seenIdat ? post : pre).push(whole); }
      pos += 12 + len;
    }
    if (!ihdr || !idat.length) throw new DB.Unsupported('This PNG is damaged (no image data).');
    const w = u32(ihdr, 0, false), h = u32(ihdr, 4, false), depth = ihdr[8], ctype = ihdr[9], interlace = ihdr[12];
    if (interlace) throw new DB.Unsupported('This PNG is interlaced. Use Convert → PNG to make a normal copy first.');
    if (depth < 8) throw new DB.Unsupported('This PNG has fewer than 8 bits per channel. Use Convert → PNG to make a normal copy first.');
    if (![0, 2, 3, 4, 6].includes(ctype) || (ctype === 3 && depth !== 8)) throw new DB.Unsupported('This PNG type is not supported.');
    if (!w || !h || w > 65535 || h > 65535) throw new DB.Unsupported('Strange PNG dimensions.');
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype], cb = depth / 8, bpp = ch * cb, stride = w * bpp;
    let total = 0; for (const d of idat) total += d.length;
    const z = new Uint8Array(total); let o = 0; for (const d of idat) { z.set(d, o); o += d.length; }
    let data = await DB.inflate(z);
    const need = h * (stride + 1);
    const notes = [];
    if (data.length < need) { const d2 = new Uint8Array(need); d2.set(data); data = d2; notes.push('This PNG was truncated; the missing area was filled in.'); }
    const trueTypes = new Uint8Array(h);
    const raw = unfilter(data, stride, bpp, h, null, trueTypes);
    for (let y = 0; y < h; y++) if (trueTypes[y] > 4) trueTypes[y] = 0;
    const L = { kind: 'raster', width: w, height: h, stride, bpp, cb, nch: ch, flipY: false, ri: 0, gi: 0, bi: 0, ai: -1, indexed: false, hb: 0 };
    if (ctype === 2 || ctype === 6) { L.gi = 1; L.bi = 2; if (ctype === 6) L.ai = 3; }
    if (ctype === 4) L.ai = 1;
    if (ctype === 3) {
      L.indexed = true;
      const pal = new Uint8Array(256 * 3);
      if (plte) pal.set(plte.subarray(0, Math.min(plte.length, 768)));
      L.palette = pal; L.nColors = Math.max(1, Math.min(256, plte ? Math.floor(plte.length / 3) : 256));
    }
    const zones = [{ start: 0, end: raw.length, kind: 'pixels', label: 'Pixels (decompressed)' }];
    const doc = new DB.Doc({ format: 'png', name, buf: raw, segments: [{ start: 0, len: raw.length }], zones, layout: L, handler: PNG, notes });
    Object.assign(doc.meta, { ihdr, pre, post, trueTypes, claimed: trueTypes.slice(), depth, ctype });
    doc.notes.push('PNG is compressed, so you edit the decompressed pixels. The file is re-compressed when you export.');
    return doc;
  };

  DB.handlers = DB.handlers || {};
  DB.handlers.png = PNG;
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
