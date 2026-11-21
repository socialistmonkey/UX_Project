(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const { u16 } = DB;

  // GIF is LZW-compressed, and a single changed byte in that stream usually breaks the decoder.
  // So (like PNG) we decompress the first frame to palette indices, let you edit those, and
  // re-compress on export. The result is always a valid GIF.

  function lzwDecode(data, minCode, count, loose) {
    const clear = 1 << minCode, eoi = clear + 1;
    const out = new Uint8Array(count);
    const prefix = new Int16Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097);
    let codeSize = minCode + 1, next = eoi + 1, bitBuf = 0, bits = 0, pos = 0, prev = -1, first = 0, o = 0;
    while (o < count) {
      while (bits < codeSize && pos < data.length) { bitBuf |= data[pos++] << bits; bits += 8; }
      if (bits < codeSize) break;
      const code = bitBuf & ((1 << codeSize) - 1);
      bitBuf >>>= codeSize; bits -= codeSize;
      if (code === clear) { codeSize = minCode + 1; next = eoi + 1; prev = -1; continue; }
      if (code === eoi) { if (loose) continue; break; }
      if (prev === -1) { if (code >= clear) { if (loose) continue; break; } out[o++] = code; prev = code; first = code; continue; }
      let cur = code, sp = 0;
      if (code >= next) { if (code > next) { if (loose) continue; break; } stack[sp++] = first; cur = prev; }
      while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur]; }
      stack[sp++] = cur; first = cur;
      while (sp && o < count) out[o++] = stack[--sp];
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first; next++;
        if (next === (1 << codeSize) && codeSize < 12) codeSize++;
      }
      prev = code;
    }
    return { pixels: out, decoded: o };
  }

  function lzwEncode(px, minCode) {
    const clear = 1 << minCode, eoi = clear + 1;
    let out = new Uint8Array(Math.max(1024, px.length >> 1)), n = 0;
    const push = (b) => { if (n === out.length) { const o2 = new Uint8Array(out.length * 2); o2.set(out); out = o2; } out[n++] = b; };
    let codeSize = minCode + 1, next = eoi + 1, bitBuf = 0, bits = 0;
    const emit = (c) => { bitBuf |= c << bits; bits += codeSize; while (bits >= 8) { push(bitBuf & 255); bitBuf >>>= 8; bits -= 8; } };
    let dict = new Map();
    emit(clear);
    let cur = px[0];
    for (let i = 1; i < px.length; i++) {
      const k = px[i], key = (cur << 8) | k, c = dict.get(key);
      if (c !== undefined) { cur = c; continue; }
      emit(cur);
      if (next === 4096) { emit(clear); next = eoi + 1; codeSize = minCode + 1; dict = new Map(); }
      else { if (next >= (1 << codeSize)) codeSize++; dict.set(key, next++); }
      cur = k;
    }
    emit(cur); emit(eoi);
    if (bits > 0) push(bitBuf & 255);
    return out.subarray(0, n);
  }
  DB.lzwEncode = lzwEncode; DB.lzwDecode = lzwDecode;

  const GIF = {
    id: 'gif', label: 'GIF',
    sanitize: DB.indexSanitizer,
    render(doc, out, r0, r1) { DB.renderRaster(doc.layout, doc.view(), out, r0, r1); },
    async exportBytes(doc) { return GIF.exportSync(doc); },
    exportSync(doc) {
      const m = doc.meta, L = doc.layout, rows = L.height, px = doc.view().subarray(0, L.width * rows);
      const z = lzwEncode(px, m.minCode);
      const parts = [m.pre, m.desc, m.lct, Uint8Array.of(m.minCode)];
      const blocks = [];
      for (let p = 0; p < z.length; p += 255) { const n = Math.min(255, z.length - p); const b = new Uint8Array(n + 1); b[0] = n; b.set(z.subarray(p, p + n), 1); blocks.push(b); }
      parts.push(...blocks, Uint8Array.of(0), m.tail);
      let total = 0; for (const p of parts) total += p.length;
      const out = new Uint8Array(total); let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    },
  };

  DB.openGIF = function (bytes, name) {
    const sig = String.fromCharCode(...bytes.subarray(0, 6));
    if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new DB.Unsupported('Not a GIF file.');
    const flags = bytes[10];
    let pos = 13;
    let gct = null;
    if (flags & 0x80) { const n = 3 * (1 << ((flags & 7) + 1)); gct = bytes.subarray(pos, pos + n); pos += n; }
    let trans = -1, frames = 0, descAt = -1;
    // walk blocks up to the first image
    while (pos < bytes.length) {
      const b = bytes[pos];
      if (b === 0x3b) break;
      if (b === 0x21) {
        if (bytes[pos + 1] === 0xf9 && descAt < 0 && bytes[pos + 2] >= 4 && (bytes[pos + 3] & 1)) trans = bytes[pos + 6];
        pos += 2; while (pos < bytes.length && bytes[pos] !== 0) pos += 1 + bytes[pos]; pos++;
      } else if (b === 0x2c) { descAt = pos; break; } else break;
    }
    if (descAt < 0) throw new DB.Unsupported('Could not find image data in this GIF.');
    const w = u16(bytes, descAt + 5, true), h = u16(bytes, descAt + 7, true), packed = bytes[descAt + 9];
    if (!w || !h) throw new DB.Unsupported('Strange GIF dimensions.');
    let p = descAt + 10, lct = new Uint8Array(0), pal = gct;
    if (packed & 0x80) { const n = 3 * (1 << ((packed & 7) + 1)); lct = bytes.slice(p, p + n); pal = lct; p += n; }
    if (!pal) throw new DB.Unsupported('This GIF has no colour table.');
    const minCode = bytes[p++];
    if (minCode < 2 || minCode > 8) throw new DB.Unsupported('Unusual GIF compression settings.');
    const data = []; let total = 0;
    while (p < bytes.length && bytes[p] !== 0) { const n = bytes[p]; data.push(bytes.subarray(p + 1, p + 1 + n)); total += n; p += 1 + n; }
    p++; // block terminator
    const z = new Uint8Array(total); { let o = 0; for (const d of data) { z.set(d, o); o += d.length; } }
    const { pixels, decoded } = lzwDecode(z, minCode, w * h);
    let px = pixels;
    if (packed & 0x40) { // interlaced: put the rows back in order
      const out = new Uint8Array(w * h); let src = 0;
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) { out.set(pixels.subarray(src * w, (src + 1) * w), y * w); src++; }
      px = out;
    }
    const nColors = pal.length / 3, palette = new Uint8Array(256 * 3); palette.set(pal.subarray(0, 768));
    // rest of the file after the first frame (more frames, trailer) is kept as is
    const tail = bytes.slice(p);
    for (let q = 0; q < tail.length;) { if (tail[q] === 0x2c) { frames++; break; } if (tail[q] === 0x21) { q += 2; while (q < tail.length && tail[q] !== 0) q += 1 + tail[q]; q++; } else break; }
    const desc = bytes.slice(descAt, descAt + 10); desc[9] &= ~0x40; // exported non-interlaced
    const L = { kind: 'raster', width: w, height: h, stride: w, bpp: 1, cb: 1, nch: 1, flipY: false, ri: 0, gi: 0, bi: 0, ai: -1, indexed: true, palette, hb: 0, nColors, trans: trans >= 0 ? trans : undefined };
    const zones = [{ start: 0, end: px.length, kind: 'pixels', label: 'Palette indices (decompressed)' }];
    const doc = new DB.Doc({ format: 'gif', name, buf: px.slice(), segments: [{ start: 0, len: px.length }], zones, layout: L, handler: GIF });
    Object.assign(doc.meta, { pre: bytes.slice(0, descAt), desc, lct, minCode, tail });
    doc.notes.push('GIF is compressed, so you edit the palette indices of the first frame. The file is re-compressed when you export.' + (frames ? ' Other frames are kept untouched.' : ''));
    if (decoded < w * h) doc.notes.push('This GIF was truncated; the missing area was filled in.');
    return doc;
  };

  DB.handlers = DB.handlers || {};
  DB.handlers.gif = GIF;
  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
