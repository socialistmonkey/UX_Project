(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const { u16, u32, put32 } = DB;
  const Unsupported = DB.Unsupported;

  const rasterRender = (doc, out, r0, r1) => DB.renderRaster(doc.layout, doc.view(), out, r0, r1);
  const plainExport = async (doc) => doc.buf.slice();
  const pieces = (total, list, gap) => {
    const zones = []; let pos = 0;
    for (const p of list) { if (p.start > pos) zones.push({ start: pos, end: p.start, kind: 'locked', label: gap }); zones.push(p); pos = p.end; }
    if (pos < total) zones.push({ start: pos, end: total, kind: 'locked', label: 'Trailing data' });
    return zones;
  };

  // file extension to save a doc with
  DB.extFor = function (doc) {
    if (doc.meta && doc.meta.ext) return doc.meta.ext.replace(/^\./, '');
    return { bmp: 'bmp', tiff: 'tif', png: 'png', jpeg: 'jpg', gif: 'gif', ppm: doc.layout.nch === 1 ? 'pgm' : 'ppm', ico: 'ico', webp: 'webp', raw: 'bin' }[doc.format] || 'bin';
  };

  // =============================================================================================
  // PPM / PGM (binary P6 and P5, 8-bit)
  // =============================================================================================
  const PNM = {
    id: 'ppm', label: 'PPM / PGM', render: rasterRender, exportBytes: plainExport,
    open(bytes, name) {
      const kind = String.fromCharCode(bytes[0], bytes[1]);
      if (kind !== 'P5' && kind !== 'P6') throw new Unsupported('Only binary PPM (P6) and PGM (P5) files are supported.');
      let pos = 2; const nums = [];
      while (nums.length < 3 && pos < bytes.length) {
        const c = bytes[pos];
        if (c === 0x23) { while (pos < bytes.length && bytes[pos] !== 0x0a) pos++; continue; } // comment
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) { pos++; continue; }
        let n = 0, any = false;
        while (pos < bytes.length && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) { n = n * 10 + bytes[pos] - 0x30; pos++; any = true; }
        if (!any) throw new Unsupported('This PNM file has a damaged header.');
        nums.push(n);
      }
      if (nums.length < 3) throw new Unsupported('This PNM file has a damaged header.');
      pos++; // the single whitespace after maxval
      const [w, h, max] = nums;
      if (max > 255) throw new Unsupported('16-bit PNM files are not supported.');
      if (!w || !h || w > 65535 || h > 65535) throw new Unsupported('Strange PNM dimensions.');
      const ch = kind === 'P6' ? 3 : 1, need = w * h * ch;
      if (pos + need > bytes.length) throw new Unsupported('This PNM file is truncated.');
      const L = { kind: 'raster', width: w, height: h, stride: w * ch, bpp: ch, cb: 1, nch: ch, flipY: false, ri: 0, gi: ch === 3 ? 1 : 0, bi: ch === 3 ? 2 : 0, ai: -1, indexed: false, hb: 0 };
      const zones = pieces(bytes.length, [{ start: pos, end: pos + need, kind: 'pixels', label: 'Pixels' }], 'PNM header');
      const doc = new DB.Doc({ format: 'ppm', name, buf: bytes.slice(), segments: [{ start: pos, len: need }], zones, layout: L, handler: PNM });
      doc.meta.kind = kind; doc.meta.max = max;
      return doc;
    },
    // rewrite the (text) header for another width: the file changes size, so it is re-read
    setWidth(tx, doc, newW) {
      const L = doc.layout, m = doc.meta, stride = newW * L.bpp, newH = Math.max(1, Math.floor(doc.length / stride));
      const head = new TextEncoder().encode(`${m.kind}\n${newW} ${newH}\n${m.max}\n`), px = doc.view().subarray(0, stride * newH);
      const out = new Uint8Array(head.length + px.length); out.set(head); out.set(px, head.length);
      tx.reopen(PNM.open(out, doc.name));
    },
  };

  // =============================================================================================
  // ICO: edits the largest picture. DIB pictures (32/24/8-bit) are edited in place; PNG pictures are
  // decompressed like any PNG and put back into the icon file on export.
  // =============================================================================================
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47];
  const ICO = {
    id: 'ico', label: 'ICO', render: rasterRender, exportBytes: plainExport,
    entries(bytes) {
      if (bytes.length < 22 || u16(bytes, 0, true) !== 0 || u16(bytes, 2, true) !== 1) throw new Unsupported('Not a valid ICO file.');
      const n = u16(bytes, 4, true), list = [];
      for (let i = 0; i < n; i++) {
        const o = 6 + i * 16; if (o + 16 > bytes.length) break;
        list.push({ i, w: bytes[o] || 256, h: bytes[o + 1] || 256, bits: u16(bytes, o + 6, true), size: u32(bytes, o + 8, true), off: u32(bytes, o + 12, true), dirAt: o });
      }
      return list.filter((e) => e.off + e.size <= bytes.length && e.size > 0);
    },
    async open(bytes, name) {
      const list = ICO.entries(bytes);
      if (!list.length) throw new Unsupported('This ICO file has no readable pictures.');
      list.sort((a, b) => b.w * b.h - a.w * a.h || b.bits - a.bits);
      const e = list[0], isPng = PNG_SIG.every((v, i) => bytes[e.off + i] === v);
      const count = list.length;
      if (isPng) {
        const png = await DB.openPNG(bytes.slice(e.off, e.off + e.size), name);
        png.format = 'ico';
        png.h = Object.assign({}, png.h, { id: 'ico', label: 'ICO', exportBytes: async (doc) => ICO.wrapPNG(doc, await DB.handlers.png.exportBytes.call(DB.handlers.png, doc)) });
        png.meta.ico = { bytes: bytes.slice(), entry: e };
        png.notes.push(`This icon holds ${count} size${count === 1 ? '' : 's'}. You are editing the biggest (${e.w}×${e.h}); the others are kept as they are.`);
        return png;
      }
      const dib = e.off, hs = u32(bytes, dib, true);
      if (hs < 40) throw new Unsupported('Unusual icon picture format.');
      const w = u32(bytes, dib + 4, true), h2 = u32(bytes, dib + 8, true), h = h2 >> 1, bpp = u16(bytes, dib + 14, true), comp = u32(bytes, dib + 16, true);
      if (![8, 24, 32].includes(bpp)) throw new Unsupported(`This icon picture is ${bpp}-bit. Image Bender supports 8, 24 and 32-bit icons.`);
      if (comp !== 0 && comp !== 3) throw new Unsupported('This icon picture is compressed.');
      const stride = ((w * bpp + 31) >>> 5) << 2, need = stride * h;
      let pix = dib + hs;
      if (bpp === 8) pix += 4 * (u32(bytes, dib + 32, true) || 256);
      if (pix + need > e.off + e.size) throw new Unsupported('This icon picture is truncated.');
      const bytesPP = bpp / 8;
      const L = { kind: 'raster', width: w, height: h, stride, bpp: bytesPP, cb: 1, nch: bytesPP, flipY: true, ri: 2, gi: 1, bi: 0, ai: bpp === 32 ? 3 : -1, indexed: bpp === 8, hb: 0 };
      if (bpp === 8) {
        const nc = Math.min(256, u32(bytes, dib + 32, true) || 256), pal = new Uint8Array(768), po = dib + hs;
        for (let i = 0; i < nc; i++) { pal[i * 3] = bytes[po + i * 4 + 2]; pal[i * 3 + 1] = bytes[po + i * 4 + 1]; pal[i * 3 + 2] = bytes[po + i * 4]; }
        L.palette = pal; L.nch = 1; L.ri = L.gi = L.bi = 0; L.nColors = nc;
      }
      const zones = pieces(bytes.length, [{ start: pix, end: pix + need, kind: 'pixels', label: 'Pixels' }], 'ICO header & directory');
      const doc = new DB.Doc({ format: 'ico', name, buf: bytes.slice(), segments: [{ start: pix, len: need }], zones, layout: L, handler: ICO });
      doc.notes.push(`This icon holds ${count} size${count === 1 ? '' : 's'}. You are editing the biggest (${w}×${h}); the others are kept as they are.`);
      return doc;
    },
    // put a re-compressed PNG back into the ICO it came from
    wrapPNG(doc, pngBytes) {
      const { bytes, entry } = doc.meta.ico;
      const before = bytes.subarray(0, entry.off), after = bytes.subarray(entry.off + entry.size);
      const out = new Uint8Array(before.length + pngBytes.length + after.length);
      out.set(before); out.set(pngBytes, before.length); out.set(after, before.length + pngBytes.length);
      const delta = pngBytes.length - entry.size;
      put32(out, entry.dirAt + 8, pngBytes.length, true);
      const n = u16(out, 4, true);
      for (let i = 0; i < n; i++) { const o = 6 + i * 16; if (o !== entry.dirAt && u32(out, o + 12, true) > entry.off) put32(out, o + 12, u32(out, o + 12, true) + delta, true); }
      return out;
    },
  };

  // =============================================================================================
  // WebP: like JPEG, only the compressed picture data is editable. Anything that stops it decoding is
  // undone by the app (lossy WebP is forgiving, lossless breaks easily).
  // =============================================================================================
  const WEBP = {
    id: 'webp', label: 'WebP', exportBytes: plainExport,
    open(bytes, name) {
      const bad = () => new Unsupported("This kind of WebP can't be edited directly. Use Convert to turn it into a BMP/PNG first.");
      if (bytes.length < 20 || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WEBP') throw bad();
      let pos = 12, found = null; const list = [];
      while (pos + 8 <= bytes.length) {
        const cc = String.fromCharCode(...bytes.subarray(pos, pos + 4)), size = u32(bytes, pos + 4, true), end = pos + 8 + size;
        if (end > bytes.length) break;
        if (cc === 'ANIM' || cc === 'ANMF') throw new Unsupported('Animated WebP is not supported. Use Convert to make a still BMP/PNG first.');
        list.push({ cc, start: pos + 8, end });
        if ((cc === 'VP8 ' || cc === 'VP8L') && !found) found = { cc, start: pos + 8, end };
        pos = end + (size & 1);
      }
      if (!found) throw bad();
      let w, h, lockEnd;
      if (found.cc === 'VP8 ') {
        const tag = bytes[found.start] | (bytes[found.start + 1] << 8) | (bytes[found.start + 2] << 16);
        if (tag & 1) throw bad(); // not a key frame
        w = u16(bytes, found.start + 6, true) & 0x3fff; h = u16(bytes, found.start + 8, true) & 0x3fff;
        lockEnd = found.start + 10 + (tag >> 5);
      } else {
        if (bytes[found.start] !== 0x2f) throw bad();
        const v = u32(bytes, found.start + 1, true);
        w = (v & 0x3fff) + 1; h = ((v >> 14) & 0x3fff) + 1;
        lockEnd = found.start + 5;
      }
      if (!w || !h || found.end - lockEnd < 16) throw bad();
      const zs = [{ start: lockEnd, end: found.end, kind: 'scan', label: found.cc === 'VP8L' ? 'Picture data (lossless)' : 'Picture data' }];
      const L = { kind: 'stream', width: w, height: h, length: found.end - lockEnd };
      const doc = new DB.Doc({ format: 'webp', name, buf: bytes.slice(), segments: [{ start: lockEnd, len: found.end - lockEnd }], zones: pieces(bytes.length, zs, 'WebP header'), layout: L, handler: WEBP });
      doc.meta.lossless = found.cc === 'VP8L';
      doc.notes.push(doc.meta.lossless ? 'Lossless WebP breaks easily. Edits that stop it opening are undone automatically, so try gentle changes (or use a lossy WebP).' : 'WebP is compressed. Edits that stop it opening are undone automatically.');
      return doc;
    },
    async decode(doc) { return createImageBitmap(new Blob([doc.buf], { type: 'image/webp' })); },
  };

  // =============================================================================================
  // RAW: any file read as raw pixels (corrupt a song, a program, a PDF ...)
  // =============================================================================================
  const RAW_FORMATS = {
    gray: { bpp: 1, nch: 1, ri: 0, gi: 0, bi: 0, label: 'Greyscale, 1 byte per pixel' },
    rgb: { bpp: 3, nch: 3, ri: 0, gi: 1, bi: 2, label: 'RGB, 3 bytes per pixel' },
    bgr: { bpp: 3, nch: 3, ri: 2, gi: 1, bi: 0, label: 'BGR, 3 bytes per pixel' },
    rgbx: { bpp: 4, nch: 4, ri: 0, gi: 1, bi: 2, label: 'RGBA, 4 bytes per pixel (alpha ignored)' },
    bgrx: { bpp: 4, nch: 4, ri: 2, gi: 1, bi: 0, label: 'BGRA, 4 bytes per pixel (alpha ignored)' },
  };
  DB.RAW_FORMATS = RAW_FORMATS;
  const RAW = {
    id: 'raw', label: 'Raw', render: rasterRender, exportBytes: plainExport,
    setWidth(tx, doc, newW) {
      const m = doc.meta;
      tx.reopen(DB.openRaw(doc.buf.slice(), doc.name, { width: newW, format: m.rawFormat, lock: m.lock, ext: m.ext }));
    },
  };
  DB.openRaw = function (bytes, name, o) {
    const f = RAW_FORMATS[o.format] || RAW_FORMATS.rgb, lock = Math.max(0, Math.min(bytes.length - 1, o.lock | 0));
    const width = DB.clamp(Math.round(o.width) || 256, 1, 65535), stride = width * f.bpp;
    const rows = Math.min(65535, Math.floor((bytes.length - lock) / stride));
    if (rows < 1) throw new Unsupported('That width is too big for this file. Try a smaller one.');
    const need = rows * stride;
    const L = { kind: 'raster', width, height: rows, stride, bpp: f.bpp, cb: 1, nch: f.nch, flipY: false, ri: f.ri, gi: f.gi, bi: f.bi, ai: -1, indexed: false, hb: 0 };
    const zs = []; if (lock) zs.push({ start: 0, end: lock, kind: 'locked', label: 'Locked start of the file' });
    zs.push({ start: lock, end: lock + need, kind: 'pixels', label: 'Data shown as pixels' });
    if (lock + need < bytes.length) zs.push({ start: lock + need, end: bytes.length, kind: 'locked', label: 'Left-over bytes (not a full row)' });
    const ext = (o.ext || (/\.[^.]+$/.exec(name) || ['.bin'])[0]);
    const doc = new DB.Doc({ format: 'raw', name, buf: bytes.slice(), segments: [{ start: lock, len: need }], zones: zs, layout: L, handler: RAW });
    Object.assign(doc.meta, { rawFormat: o.format in RAW_FORMATS ? o.format : 'rgb', lock, ext });
    doc.notes.push('Raw mode: this file is shown as pixels, but every byte is editable (nothing protects it). It is saved as the same kind of file it came from.');
    return doc;
  };

  DB.buildPPM = function (rgba, w, h) {
    const head = new TextEncoder().encode(`P6\n${w} ${h}\n255\n`), out = new Uint8Array(head.length + w * h * 3);
    out.set(head);
    for (let i = 0, s = 0, o = head.length; i < w * h; i++, s += 4) { const a = rgba[s + 3] / 255, inv = 255 * (1 - a); out[o++] = rgba[s] * a + inv; out[o++] = rgba[s + 1] * a + inv; out[o++] = rgba[s + 2] * a + inv; }
    return out;
  };

  DB.handlers = Object.assign(DB.handlers || {}, { ppm: PNM, ico: ICO, webp: WEBP, raw: RAW });

  // ---- sniffing and opening for the new kinds (wraps the earlier versions) ----
  const sniff0 = DB.sniff, open0 = DB.open;
  DB.sniff = function (b) {
    const k = sniff0(b);
    if (k) return k;
    if (b[0] === 0x50 && (b[1] === 0x35 || b[1] === 0x36) && (b[2] === 0x0a || b[2] === 0x20 || b[2] === 0x0d || b[2] === 0x09 || b[2] === 0x23)) return 'ppm';
    if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 && b[4] > 0 && b[5] === 0) return 'ico';
    return null;
  };
  DB.open = async function (bytes, name) {
    const kind = DB.sniff(bytes);
    if (kind === 'webp') return WEBP.open(bytes, name);
    if (kind === 'ppm') return PNM.open(bytes, name);
    if (kind === 'ico') return ICO.open(bytes, name);
    return open0(bytes, name);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
