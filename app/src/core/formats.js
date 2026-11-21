(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const { u16, u32, i32le, put16, put32 } = DB;

  class Unsupported extends Error {}
  DB.Unsupported = Unsupported;

  // pieces: sorted, non-overlapping [{start,end,kind,label}]. Gaps become locked "header" zones.
  function buildZones(total, pieces, gapLabel) {
    const zones = [];
    let pos = 0;
    for (const p of pieces) {
      if (p.start > pos) zones.push({ start: pos, end: p.start, kind: 'locked', label: gapLabel || 'Header / metadata' });
      zones.push(p);
      pos = p.end;
    }
    if (pos < total) zones.push({ start: pos, end: total, kind: 'locked', label: 'Trailing data' });
    return zones;
  }

  const rasterRender = (doc, out, r0, r1) => DB.renderRaster(doc.layout, doc.view(), out, r0, r1);
  const plainExport = async (doc) => doc.buf.slice();

  // =============================================================================================
  // BMP
  // =============================================================================================
  const BMP = {
    id: 'bmp', label: 'BMP', render: rasterRender, exportBytes: plainExport, sanitize: (tx, doc, t) => DB.indexSanitizer(tx, doc, t),
    open(bytes, name) {
      if (bytes.length < 54) throw new Unsupported('This BMP file is too short to be valid.');
      const off = u32(bytes, 10, true), dib = u32(bytes, 14, true);
      if (dib < 40) throw new Unsupported('This is an old OS/2-style BMP. Open it in Preview and export a normal BMP.');
      const w = i32le(bytes, 18); let h = i32le(bytes, 22);
      const bpp = u16(bytes, 28, true), comp = u32(bytes, 30, true);
      const flipY = h > 0; h = Math.abs(h);
      if (![8, 24, 32].includes(bpp)) throw new Unsupported(`This BMP is ${bpp}-bit. Image Bender supports 8, 24 and 32-bit BMP.`);
      if (comp !== 0 && !(comp === 3 && bpp === 32)) throw new Unsupported('This BMP is compressed (RLE). Export it uncompressed.');
      if (w < 1 || h < 1 || w > 65535 || h > 65535) throw new Unsupported('Strange BMP dimensions.');
      const stride = ((w * bpp + 31) >>> 5) << 2, need = stride * h;
      if (off + need > bytes.length) throw new Unsupported('This BMP is truncated (the pixel data is shorter than its header says).');
      const bytesPP = bpp / 8;
      const L = { kind: 'raster', width: w, height: h, stride, bpp: bytesPP, cb: 1, nch: bytesPP, flipY, ri: 2, gi: 1, bi: 0, ai: -1, indexed: bpp === 8, hb: 0 };
      if (bpp === 8) {
        const n = u32(bytes, 46, true) || 256, pal = new Uint8Array(256 * 3), po = 14 + dib;
        for (let i = 0; i < Math.min(n, 256); i++) { pal[i * 3] = bytes[po + i * 4 + 2]; pal[i * 3 + 1] = bytes[po + i * 4 + 1]; pal[i * 3 + 2] = bytes[po + i * 4]; }
        L.palette = pal; L.nch = 1; L.ri = L.gi = L.bi = 0; L.nColors = Math.min(n, 256);
      }
      const zones = buildZones(bytes.length, [{ start: off, end: off + need, kind: 'pixels', label: 'Pixels' }], 'BMP header' + (bpp === 8 ? ' & palette' : ''));
      const doc = new DB.Doc({ format: 'bmp', name, buf: bytes.slice(), segments: [{ start: off, len: need }], zones, layout: L, handler: BMP });
      doc.meta.rowsFromBytes = true;
      return doc;
    },
    // Re-read the same pixel bytes with a different width: the classic "wrong width" shear.
    setWidth(tx, doc, newW) {
      const L = doc.layout, bits = L.bpp * 8;
      const stride = ((newW * bits + 31) >>> 5) << 2;
      const newH = Math.max(1, Math.floor(doc.length / stride));
      const L2 = Object.assign({}, L, { width: newW, height: newH, stride });
      const hdr = new Uint8Array(8); put32(hdr, 0, newW, true); put32(hdr, 4, L.flipY ? newH : -newH, true);
      const sz = new Uint8Array(4); put32(sz, 0, stride * newH, true);
      tx.raw(18, hdr); tx.raw(34, sz);
      tx.meta(() => { doc.layout = L2; }, () => { doc.layout = L; });
    },
  };

  // =============================================================================================
  // TIFF (classic, uncompressed, chunky)
  // =============================================================================================
  const TIFF_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

  const TIFF = {
    id: 'tiff', label: 'TIFF', render: rasterRender, exportBytes: plainExport,
    open(bytes, name) {
      const le = bytes[0] === 0x49;
      const g16 = (o) => u16(bytes, o, le), g32 = (o) => u32(bytes, o, le);
      if (g16(2) === 43) throw new Unsupported('BigTIFF is not supported. Export a normal TIFF.');
      let ifd = g32(4);
      if (ifd + 2 > bytes.length) throw new Unsupported('This TIFF has a damaged header.');
      const n = g16(ifd);
      const tags = {};
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12;
        if (e + 12 > bytes.length) break;
        const type = g16(e + 2), count = g32(e + 4), sz = (TIFF_SIZES[type] || 1) * count;
        tags[g16(e)] = { entryOff: e, type, count, dataOff: sz <= 4 ? e + 8 : g32(e + 8) };
      }
      const vals = (t) => {
        const ent = tags[t];
        if (!ent) return null;
        const out = [];
        for (let i = 0; i < Math.min(ent.count, 100000); i++) {
          if (ent.type === 3) out.push(g16(ent.dataOff + i * 2));
          else if (ent.type === 4) out.push(g32(ent.dataOff + i * 4));
          else if (ent.type === 1 || ent.type === 7) out.push(bytes[ent.dataOff + i]);
          else out.push(0);
        }
        return out;
      };
      const one = (t, d) => { const v = vals(t); return v && v.length ? v[0] : d; };
      const w = one(256, 0), h = one(257, 0);
      const comp = one(259, 1), photo = one(262, 1), spp = one(277, 1), planar = one(284, 1);
      const bps = vals(258) || [1];
      if (comp !== 1) throw new Unsupported('This TIFF is compressed (LZW/ZIP/JPEG inside). Re-export it with compression set to None. In Photoshop: Image Compression → None.');
      if (tags[322] || tags[324]) throw new Unsupported('This TIFF is stored in tiles. Re-export it as a normal (strip) TIFF, or use Convert.');
      if (planar !== 1) throw new Unsupported('Planar TIFFs are not supported. Re-export with Pixel Order → Interleaved.');
      if (!(bps.every((b) => b === bps[0]) && (bps[0] === 8 || bps[0] === 16))) throw new Unsupported('Only 8-bit and 16-bit TIFFs are supported.');
      if (tags[339] && vals(339).some((v) => v !== 1)) throw new Unsupported('Floating-point or signed TIFFs are not supported.');
      if (![0, 1, 2, 3].includes(photo)) throw new Unsupported('Only RGB, grayscale and palette TIFFs are supported (no CMYK/Lab).');
      if (!w || !h || w > 65535 || h > 65535) throw new Unsupported('Strange TIFF dimensions.');
      const cb = bps[0] / 8, nch = spp, bpp = cb * nch, stride = w * bpp;
      let rps = one(278, h); if (!rps || rps > h) rps = h;
      const offs = vals(273);
      if (!offs || !offs.length) throw new Unsupported('This TIFF has no strip data.');
      const nStrips = Math.ceil(h / rps);
      if (offs.length < nStrips) throw new Unsupported('This TIFF has a damaged strip table.');
      const segs = [];
      for (let i = 0; i < nStrips; i++) {
        const rows = Math.min(rps, h - i * rps), len = rows * stride; // sizes are computed, because many files store wrong byte counts
        if (offs[i] + len > bytes.length) throw new Unsupported('This TIFF is truncated.');
        const last = segs[segs.length - 1];
        if (last && last.start + last.len === offs[i]) last.len += len; else segs.push({ start: offs[i], len });
      }
      for (let i = 1; i < segs.length; i++) if (segs[i].start < segs[i - 1].start + segs[i - 1].len) throw new Unsupported('This TIFF has overlapping strips.');
      const L = { kind: 'raster', width: w, height: h, stride, bpp, cb, nch, flipY: false, ri: 0, gi: 0, bi: 0, ai: -1, indexed: false, hb: le ? 1 : 0 };
      const extra = vals(338) || [];
      if (photo === 2) {
        if (nch < 3) throw new Unsupported('RGB TIFF with fewer than 3 channels.');
        L.ri = 0; L.gi = 1; L.bi = 2;
        if (nch >= 4 && (extra[0] === 1 || extra[0] === 2)) L.ai = 3;
      } else if (photo === 3) {
        if (bps[0] !== 8) throw new Unsupported('Only 8-bit palette TIFFs are supported.');
        const cm = vals(320) || [];
        const pal = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) { pal[i * 3] = (cm[i] || 0) >> 8; pal[i * 3 + 1] = (cm[256 + i] || 0) >> 8; pal[i * 3 + 2] = (cm[512 + i] || 0) >> 8; }
        L.indexed = true; L.palette = pal;
      } else {
        L.invert = photo === 0;
        if (nch >= 2 && (extra[0] === 1 || extra[0] === 2)) L.ai = 1;
      }
      const pieces = segs.map((s, i) => ({ start: s.start, end: s.start + s.len, kind: 'pixels', label: segs.length > 1 ? `Pixels (block ${i + 1})` : 'Pixels' }));
      const zones = buildZones(bytes.length, pieces, 'TIFF header, directory & metadata');
      const doc = new DB.Doc({ format: 'tiff', name, buf: bytes.slice(), segments: segs, zones, layout: L, handler: TIFF });
      doc.meta.tags = tags; doc.meta.le = le; doc.meta.rps = rps; doc.meta.nStrips = nStrips;
      if (tags[274] && one(274, 1) !== 1) doc.notes.push('This TIFF has an orientation flag. The preview ignores it, so it may look rotated compared to other apps.');
      if (nStrips > 1) doc.notes.push('This TIFF is stored in several strips, so the Wrong-width tool is unavailable. Use Convert → TIFF to make a single-strip copy.');
      return doc;
    },
    _putTag(tx, doc, tag, value) {
      const t = doc.meta.tags[tag], le = doc.meta.le;
      if (!t || t.count !== 1) return false;
      const e = new Uint8Array(12);
      if (t.type === 3 && value <= 65535) { put16(e, 0, 3, le); put32(e, 2, 1, le); put16(e, 6, value, le); }
      else { put16(e, 0, 4, le); put32(e, 2, 1, le); put32(e, 6, value, le); }
      tx.raw(t.entryOff + 2, e.subarray(0, 10));
      return true;
    },
    setWidth(tx, doc, newW) {
      if (doc.meta.nStrips !== 1) throw new Unsupported('Multi-strip TIFF');
      const L = doc.layout, stride = newW * L.bpp;
      const newH = Math.max(1, Math.floor(doc.length / stride));
      TIFF._putTag(tx, doc, 256, newW); TIFF._putTag(tx, doc, 257, newH);
      TIFF._putTag(tx, doc, 278, newH); TIFF._putTag(tx, doc, 279, stride * newH);
      doc.meta.rps = newH;
      const L2 = Object.assign({}, L, { width: newW, height: newH, stride });
      tx.meta(() => { doc.layout = L2; }, () => { doc.layout = L; });
    },
  };

  // =============================================================================================
  // JPEG — only the compressed scan data is editable. Everything else is locked.
  // =============================================================================================
  const JPEG_LABELS = {
    0xdb: 'JPEG detail tables', 0xc4: 'Huffman tables', 0xdd: 'Restart interval', 0xfe: 'Comment', 0xda: 'Scan header',
  };
  const JPEG = {
    id: 'jpeg', label: 'JPEG',
    open(bytes, name) {
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Unsupported('Not a JPEG file.');
      const pieces = [], scans = [], dqts = [];
      let sof = null, pos = 2, progressive = false;
      while (pos < bytes.length - 1) {
        if (bytes[pos] !== 0xff) { pos++; continue; }
        let m = bytes[pos + 1];
        if (m === 0xff) { pos++; continue; }                 // fill byte
        if (m === 0xd9) { pieces.push({ start: pos, end: pos + 2, kind: 'locked', label: 'End of image' }); pos += 2; break; }
        if (m === 0x00 || m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { pos += 2; continue; }
        const len = u16(bytes, pos + 2, false);
        if (len < 2 || pos + 2 + len > bytes.length) break;
        const segEnd = pos + 2 + len;
        let label = JPEG_LABELS[m] || (m >= 0xe0 && m <= 0xef ? (m === 0xe1 ? 'EXIF / metadata' : 'Application data') : 'Header');
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          label = 'Frame header (size & color layout)';
          if (!sof) sof = { off: pos, marker: m, h: u16(bytes, pos + 5, false), w: u16(bytes, pos + 7, false), ncomp: bytes[pos + 9] };
          if (m === 0xc2) progressive = true;
          if (m === 0xc3 || m >= 0xc5) throw new Unsupported('This JPEG type (lossless/arithmetic) is not supported.');
        }
        if (m === 0xdb) { // remember where the 8-bit tables live for the JPEG detail tables tool
          let p = pos + 4;
          while (p < segEnd) {
            const pq = bytes[p] >> 4, n = pq ? 128 : 64;
            if (pq === 0 && p + 1 + n <= segEnd) dqts.push({ off: p + 1, n });
            p += 1 + n;
          }
        }
        pieces.push({ start: pos, end: segEnd, kind: m === 0xdb ? 'tables' : 'locked', label });
        pos = segEnd;
        if (m === 0xda) { // entropy-coded data runs to the next real marker
          let p = pos;
          while (p < bytes.length - 1) {
            if (bytes[p] === 0xff) {
              const nx = bytes[p + 1];
              if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7) || nx === 0xff) { p += nx === 0xff ? 1 : 2; continue; }
              break;
            }
            p++;
          }
          if (p >= bytes.length - 1) p = bytes.length;
          if (p > pos) { scans.push({ start: pos, len: p - pos }); pieces.push({ start: pos, end: p, kind: 'scan', label: 'Image data' }); }
          pos = p;
        }
      }
      if (!sof || !scans.length) throw new Unsupported('Could not find the image data in this JPEG.');
      const zones = buildZones(bytes.length, pieces.sort((a, b) => a.start - b.start), 'Header');
      const L = { kind: 'stream', width: sof.w, height: sof.h, length: scans.reduce((a, s) => a + s.len, 0) };
      const doc = new DB.Doc({ format: 'jpeg', name, buf: bytes.slice(), segments: scans, zones, layout: L, handler: JPEG });
      doc.meta.sof = sof; doc.meta.dqts = dqts; doc.meta.progressive = progressive;
      let rst = 0; // restart markers inside the scans (each one starts a block that decodes on its own)
      for (const sc of scans) for (let i = sc.start; i < sc.start + sc.len - 1; i++) if (bytes[i] === 0xff && bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7) rst++;
      doc.meta.restartCount = rst;
      if (progressive) doc.notes.push('Progressive JPEG: the image is stored in several passes, so edits give less predictable results than baseline JPEG.');
      return doc;
    },
    // Keep the compressed stream decodable: an FF byte may only be followed by 00 (stuffing), a restart marker, or FF.
    sanitize(tx, doc, touched) {
      for (const seg of doc.segments) {
        const segEnd = seg.start + seg.len;
        for (const [a, b] of touched) {
          const lo = Math.max(seg.lstart, a - 1), hi = Math.min(seg.lstart + seg.len, b + 1);
          for (let l = lo; l < hi; l++) {
            const off = seg.start + (l - seg.lstart);
            if (doc.buf[off] !== 0xff) continue;
            const nx = off + 1 < segEnd ? doc.buf[off + 1] : 0xff;
            if (nx === 0x00 || nx === 0xff || (nx >= 0xd0 && nx <= 0xd7)) continue;
            tx.write(l, Uint8Array.of(0xfe));
          }
        }
      }
    },
    setWidth(tx, doc, newW) {
      const sof = doc.meta.sof, b = new Uint8Array(2);
      put16(b, 0, DB.clamp(newW, 1, 65535), false);
      tx.raw(sof.off + 7, b);
      const L = doc.layout, L2 = Object.assign({}, L, { width: newW });
      tx.meta(() => { doc.layout = L2; }, () => { doc.layout = L; });
    },
    quantTables(doc) { return doc.meta.dqts; },
    async decode(doc) {
      const bmp = await createImageBitmap(new Blob([doc.buf], { type: 'image/jpeg' }));
      return bmp;
    },
    exportBytes: plainExport,
  };

  DB.handlers = Object.assign(DB.handlers || {}, { bmp: BMP, tiff: TIFF, jpeg: JPEG });

  // =============================================================================================
  // Open any supported file
  // =============================================================================================
  DB.sniff = function (b) {
    if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp';
    if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a)) return 'tiff';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
    return null;
  };

  DB.open = async function (bytes, name) {
    const kind = DB.sniff(bytes);
    if (!kind) throw new Unsupported("Image Bender doesn't recognise this file type.");
    if (kind === 'png') return DB.openPNG(bytes, name);
    if (kind === 'gif') return DB.openGIF(bytes, name);
    if (kind === 'webp') throw new Unsupported('WebP is compressed in a way that cannot be edited safely. Use Convert to turn it into a BMP/TIFF/PNG first.');
    return DB.handlers[kind].open(bytes, name);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
