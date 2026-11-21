(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const OPS = DB.OPS, clamp = DB.clamp;
  const { normSel, isRaster, seedParam, rasterOnly, only } = DB.opHelpers;
  const { put16, put32, u16, u32, i32le } = DB;

  // =============================================================================================
  // Compression glitch: squeeze the bytes with a real compressor, damage the squeezed data, unsqueeze.
  // This is what a damaged PNG / GIF / ZIP does to a picture, and the result is always a normal file.
  // =============================================================================================
  const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

  DB.deflateFixed = function (src) {
    let out = new Uint8Array(Math.max(1024, src.length >> 1)), n = 0, acc = 0, nb = 0;
    const bits = (v, k) => { acc |= v << nb; nb += k; while (nb >= 8) { if (n === out.length) { const o = new Uint8Array(out.length * 2); o.set(out); out = o; } out[n++] = acc & 255; acc >>>= 8; nb -= 8; } };
    const code = (c, k) => { let r = 0; for (let i = 0; i < k; i++) r |= ((c >> i) & 1) << (k - 1 - i); bits(r, k); }; // Huffman codes go in MSB first
    const lit = (s) => { if (s < 144) code(0x30 + s, 8); else if (s < 256) code(0x190 + s - 144, 9); else if (s < 280) code(s - 256, 7); else code(0xc0 + s - 280, 8); };
    bits(1, 1); bits(1, 2); // final block, fixed Huffman
    const N = src.length, head = new Int32Array(65536).fill(-1), prev = new Int32Array(N).fill(-1);
    const hash = (i) => ((src[i] << 8) ^ (src[i + 1] << 4) ^ src[i + 2]) & 65535;
    let i = 0;
    while (i < N) {
      let bl = 0, bd = 0;
      if (i + 2 < N) {
        const h = hash(i); let c = head[h], tries = 24;
        while (c >= 0 && i - c <= 32768 && tries-- > 0) {
          let l = 0; const max = Math.min(258, N - i);
          while (l < max && src[c + l] === src[i + l]) l++;
          if (l > bl) { bl = l; bd = i - c; if (l === max) break; }
          c = prev[c];
        }
        prev[i] = head[h]; head[h] = i;
      }
      if (bl >= 3) {
        let li = 28; while (LEN_BASE[li] > bl) li--;
        lit(257 + li); bits(bl - LEN_BASE[li], LEN_EXTRA[li]);
        let di = 29; while (DIST_BASE[di] > bd) di--;
        code(di, 5); bits(bd - DIST_BASE[di], DIST_EXTRA[di]);
        for (let k = 1; k < bl; k++) { const p = i + k; if (p + 2 < N) { const h = hash(p); prev[p] = head[h]; head[h] = p; } }
        i += bl;
      } else { lit(src[i]); i++; }
    }
    lit(256);
    if (nb > 0) bits(0, 8 - nb);
    return out.subarray(0, n);
  };

  // forgiving: stops at the first thing that makes no sense and says how many bytes it got
  DB.inflateFixed = function (z, count, loose) {
    const out = new Uint8Array(count); let o = 0, pos = 0, bit = 0;
    const total = z.length * 8;
    const rd = () => { if (pos >= total) return -1; const b = (z[pos >> 3] >> (pos & 7)) & 1; pos++; return b; };
    const rn = (k) => { let v = 0; for (let i = 0; i < k; i++) { const b = rd(); if (b < 0) return -1; v |= b << i; } return v; };
    rd(); // BFINAL
    const bt = rn(2);
    if (bt !== 1) return { data: out, n: 0 };
    for (;;) {
      let c = 0, ok = true;
      for (let i = 0; i < 7; i++) { const b = rd(); if (b < 0) { ok = false; break; } c = (c << 1) | b; }
      if (!ok) break;
      let sym;
      if (c <= 23) sym = 256 + c;
      else {
        let b = rd(); if (b < 0) break; c = (c << 1) | b;
        if (c >= 48 && c <= 191) sym = c - 48;
        else if (c >= 192 && c <= 199) sym = 280 + c - 192;
        else { b = rd(); if (b < 0) break; c = (c << 1) | b; if (c >= 400 && c <= 511) sym = 144 + c - 400; else break; }
      }
      if (sym < 256) { if (o >= count) break; out[o++] = sym; continue; }
      if (sym === 256) { if (loose) continue; break; }
      const li = sym - 257; if (li > 28) { if (loose) continue; break; }
      const ex = rn(LEN_EXTRA[li]); if (ex < 0) break;
      const len = LEN_BASE[li] + ex;
      let dc = 0; for (let i = 0; i < 5; i++) { const b = rd(); if (b < 0) { dc = -1; break; } dc = (dc << 1) | b; }
      if (dc < 0) break;
      if (dc > 29) { if (loose) continue; break; }
      const dex = rn(DIST_EXTRA[dc]); if (dex < 0) break;
      let dist = DIST_BASE[dc] + dex;
      if (dist > o) { if (loose && o > 0) dist = o; else break; } // points before the start: a strict decoder gives up, a loose one makes something up
      for (let k = 0; k < len && o < count; k++) { out[o] = out[o - dist]; o++; }
      if (o >= count) break;
    }
    return { data: out, n: o };
  };

  OPS.compGlitch = {
    title: 'Corrupt compression', group: 'Bytes', needs: 'band', defaultAll: true, available: rasterOnly,
    blurb: 'Squeezes the pixels with a real compressor (the kind inside PNG and ZIP, or GIF), damages the squeezed data, then unpacks it. One bad bit makes everything after it smear, repeat or collapse, exactly like a damaged file. The result is always a normal, valid picture.',
    params: [
      { id: 'algo', label: 'Compressor', type: 'select', def: 'deflate', options: [['deflate', 'Deflate (PNG, ZIP) — streaks and repeats'], ['lzw', 'LZW (GIF) — colour drift and noise']] },
      { id: 'hits', label: 'Damage spots', type: 'range', min: 1, max: 200, step: 1, def: 4, help: 'How many places in the squeezed data get damaged.' },
      { id: 'how', label: 'Damage', type: 'select', def: 'byte', options: [['byte', 'Random byte'], ['flip', 'Flip one bit'], ['zero', 'Zero a byte'], ['copy', 'Copy a block over it']] },
      { id: 'after', label: 'If it breaks completely', type: 'select', def: 'keep', options: [['keep', 'Keep the original'], ['smear', 'Smear the last row'], ['black', 'Fill with black']], help: 'A damaged stream can stop making sense. This is what the rest of the area becomes.' },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, true);
      const s0 = L.flipY ? L.height - (r.y + r.h) : r.y;
      const a = s0 * L.stride, b = Math.min(doc.length, (s0 + r.h) * L.stride);
      const data = doc.read(a, b - a);
      const lzw = p.algo === 'lzw';
      let z = lzw ? DB.lzwEncode(data, 8).slice() : DB.deflateFixed(data).slice();
      const skip = lzw ? 2 : 1; // keep the very start (block header / clear code) intact so it still begins
      for (let i = 0; i < Math.round(p.hits); i++) {
        const at = skip + rng.int(Math.max(1, z.length - skip));
        if (p.how === 'flip') z[at] ^= 1 << rng.int(8);
        else if (p.how === 'byte') z[at] = rng.int(256);
        else if (p.how === 'zero') z[at] = 0;
        else { const n = rng.range(4, 32), from = rng.int(Math.max(1, z.length - n)); for (let k = 0; k < n && at + k < z.length; k++) z[at + k] = z[from + k]; }
      }
      let out, n;
      if (lzw) { const r2 = DB.lzwDecode(z, 8, data.length, true); out = r2.pixels; n = r2.decoded; }
      else { const r2 = DB.inflateFixed(z, data.length, true); out = r2.data; n = r2.n; }
      if (n < data.length) {
        if (p.after === 'keep') out.set(data.subarray(n), n);
        else if (p.after === 'smear') { const st = Math.min(L.stride, Math.max(1, n)); for (let i = n; i < out.length; i++) out[i] = out[Math.max(0, n - st) + ((i - n) % st)]; }
        // 'black' leaves zeros
      }
      tx.write(a, out);
    },
  };

  // =============================================================================================
  // PNG chunk tools: change how the file is built without touching the picture's pixels
  // =============================================================================================
  const isAncillary = (c) => (c[4] & 0x20) !== 0;
  const ctype = (c) => String.fromCharCode(c[4], c[5], c[6], c[7]);
  const movable = (c) => isAncillary(c) && ctype(c) !== 'tRNS';

  OPS.pngChunks = {
    title: 'PNG chunks', group: 'File structure', needs: 'none', available: only('png'), verify: true,
    blurb: 'A PNG is a stack of labelled chunks. Reorder the optional ones, copy them, drop them, add your own text, or cut the picture data into small pieces. The pixels stay the same; the file is rebuilt with every checksum fixed.',
    params: [
      { id: 'action', label: 'Do this', type: 'select', def: (d) => ((d.meta.pre || []).concat(d.meta.post || []).some(movable) ? 'shuffle' : 'text'), options: [['shuffle', 'Shuffle the optional chunks'], ['repeat', 'Repeat text chunks'], ['drop', 'Drop all optional chunks'], ['text', 'Add a text chunk'], ['split', 'Cut the picture data into pieces']] },
      { id: 'count', label: 'How many', type: 'range', min: 1, max: 50, step: 1, def: 5, help: 'Copies to add (repeat, text).' },
      { id: 'text', label: 'Text to add', type: 'text', def: 'made with Image Bender' },
      { id: 'piece', label: 'Piece size', type: 'range', min: 16, max: 65536, step: 16, def: 256, unit: 'bytes', help: 'For “cut into pieces”: the size of each picture-data chunk.' },
      seedParam,
    ],
    run({ tx, doc, p, rng }) {
      const m = doc.meta, oldPre = m.pre, oldPost = m.post, oldSize = m.idatSize;
      let pre = oldPre.slice(), post = oldPost.slice(), size = oldSize;
      const shuffleIn = (list) => { const idx = list.map((c, i) => (movable(c) ? i : -1)).filter((i) => i >= 0), items = idx.map((i) => list[i]); for (let i = items.length - 1; i > 0; i--) { const j = rng.int(i + 1); [items[i], items[j]] = [items[j], items[i]]; } idx.forEach((pos, k) => (list[pos] = items[k])); };
      if (p.action === 'shuffle') { if (!pre.concat(post).some(movable)) throw new Error('This PNG has no optional chunks to shuffle. Try “Add a text chunk” first.'); shuffleIn(pre); shuffleIn(post); }
      else if (p.action === 'drop') { const keep = (c) => !movable(c); if (pre.concat(post).every(keep)) throw new Error('This PNG has no optional chunks to drop.'); pre = pre.filter(keep); post = post.filter(keep); }
      else if (p.action === 'text') {
        const kw = Array.from('Comment').map((c) => c.charCodeAt(0)), txt = Array.from(String(p.text || '')).map((c) => (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63));
        for (let i = 0; i < Math.round(p.count); i++) pre.push(DB.pngChunk('tEXt', Uint8Array.from([...kw, 0, ...txt])));
      } else if (p.action === 'repeat') {
        const texts = pre.concat(post).filter((c) => ['tEXt', 'zTXt', 'iTXt'].includes(ctype(c)));
        if (!texts.length) throw new Error('This PNG has no text chunks to repeat. Use “Add a text chunk” first.');
        for (let i = 0; i < Math.round(p.count); i++) { const c = texts[rng.int(texts.length)], list = rng() < 0.5 ? pre : post; list.splice(rng.int(list.length + 1), 0, c); }
      } else if (p.action === 'split') size = Math.max(16, Math.round(p.piece));
      tx.meta(() => { m.pre = pre; m.post = post; m.idatSize = size; }, () => { m.pre = oldPre; m.post = oldPost; m.idatSize = oldSize; }, 256);
    },
  };

  // PNG row filters got two more patterns
  const pf = OPS.pngFilter;
  pf.params[0].options = pf.params[0].options.concat([['cycle', 'Cycle 0–4 down the picture'], ['bands', 'Alternate None / Sub in bands']]);
  pf.run = function ({ tx, doc, L, sel, p, rng }) {
    const r = normSel(L, sel, true); if (!r) return;
    const pick = (y) => {
      if (rng() * 100 >= p.chance) return doc.meta.trueTypes[y];
      if (p.type === 'rand') return rng.int(5);
      if (p.type === 'cycle') return y % 5;
      if (p.type === 'bands') return (y >> 4) & 1 ? 1 : 0;
      return +p.type;
    };
    doc.h.setFilters(tx, doc, r.y, r.y + r.h, pick);
  };

  // =============================================================================================
  // Header: change what the file says about itself. The app re-reads the file afterwards and the preview
  // refuses anything that would stop it opening.
  // =============================================================================================
  const bad = (m) => { throw new Error(m); };
  const HEADER = {};
  DB.headerFormats = () => Object.keys(HEADER);

  HEADER.bmp = (tx, doc, p) => {
    const f = doc.buf.slice(), L = doc.layout;
    const off = u32(f, 10, true), dib = u32(f, 14, true), curBits = L.bpp * 8;
    const bits = p.bpp === 'keep' ? curBits : +p.bpp, w = clamp(Math.round(p.width), 1, 65535);
    const newOff = clamp(off + Math.round(p.offset || 0), 14 + dib, f.length - 4);
    const stride = ((w * bits + 31) >>> 5) << 2, avail = f.length - newOff;
    let h = p.fit ? Math.floor(avail / stride) : clamp(Math.round(p.height), 1, 65535);
    if (h < 1) bad('That width and colour depth need more data than the file has.');
    if (h * stride > avail) bad(`That needs ${DB.fmtBytes(h * stride)} of pixels but only ${DB.fmtBytes(avail)} are there. Turn on “Fit height” or use a smaller size.`);
    h = Math.min(h, 65535);
    put32(f, 10, newOff, true); put32(f, 18, w, true); put32(f, 22, L.flipY ? h : -h, true);
    put16(f, 28, bits, true); put32(f, 34, stride * h, true);
    if (bits === 8 && !u32(f, 46, true)) put32(f, 46, 256, true);
    return DB.handlers.bmp.open(f, doc.name);
  };

  HEADER.gif = (tx, doc, p) => {
    const m = doc.meta, L = doc.layout, bytes = DB.handlers.gif.exportSync(doc);
    const w = clamp(Math.round(p.width), 1, 65535), h = p.fit ? Math.max(1, Math.floor(doc.length / w)) : clamp(Math.round(p.height), 1, 65535);
    put16(bytes, 6, w, true); put16(bytes, 8, h, true);
    put16(bytes, m.pre.length + 5, w, true); put16(bytes, m.pre.length + 7, h, true);
    return DB.openGIF(bytes, doc.name);
  };

  const geomPNGish = (tx, doc, w, h) => { // PNG: same pixel bytes, other geometry
    const L = doc.layout, m = doc.meta, stride = w * L.bpp, maxH = Math.max(1, Math.floor(doc.length / stride));
    const newH = Math.min(h || maxH, maxH);
    const L2 = Object.assign({}, L, { width: w, height: newH, stride });
    const oT = m.trueTypes, oC = m.claimed, nT = new Uint8Array(newH), nC = new Uint8Array(newH);
    tx.meta(() => { doc.layout = L2; m.trueTypes = nT; m.claimed = nC; }, () => { doc.layout = L; m.trueTypes = oT; m.claimed = oC; }, 4096);
  };
  HEADER.png = (tx, doc, p) => { geomPNGish(tx, doc, clamp(Math.round(p.width), 1, 65535), p.fit ? 0 : Math.round(p.height)); return null; };

  HEADER.tiff = (tx, doc, p) => {
    if (doc.meta.nStrips !== 1) bad('This TIFF has several strips. Use Convert → TIFF first.');
    const L = doc.layout, T = DB.handlers.tiff, w = clamp(Math.round(p.width), 1, 65535), stride = w * L.bpp, maxH = Math.max(1, Math.floor(doc.length / stride));
    const h = p.fit ? maxH : Math.min(maxH, clamp(Math.round(p.height), 1, 65535));
    T._putTag(tx, doc, 256, w); T._putTag(tx, doc, 257, h); T._putTag(tx, doc, 278, h); T._putTag(tx, doc, 279, stride * h);
    doc.meta.rps = h;
    const L2 = Object.assign({}, L, { width: w, height: h, stride });
    tx.meta(() => { doc.layout = L2; }, () => { doc.layout = L; });
    return null;
  };

  HEADER.jpeg = (tx, doc, p) => {
    const sof = doc.meta.sof, w = clamp(Math.round(p.width), 1, 65535), h = p.fit ? doc.layout.height : clamp(Math.round(p.height), 1, 65535);
    const b = new Uint8Array(4); put16(b, 0, h, false); put16(b, 2, w, false);
    tx.raw(sof.off + 5, b);
    const L = doc.layout, L2 = Object.assign({}, L, { width: w, height: h });
    tx.meta(() => { doc.layout = L2; }, () => { doc.layout = L; });
    return null;
  };

  HEADER.ppm = (tx, doc, p) => {
    const L = doc.layout, m = doc.meta, w = clamp(Math.round(p.width), 1, 65535), stride = w * L.bpp, maxH = Math.max(1, Math.floor(doc.length / stride));
    const h = p.fit ? maxH : Math.min(maxH, clamp(Math.round(p.height), 1, 65535));
    const head = new TextEncoder().encode(`${m.kind}\n${w} ${h}\n${m.max}\n`), px = doc.view().subarray(0, stride * h);
    const out = new Uint8Array(head.length + px.length); out.set(head); out.set(px, head.length);
    return DB.handlers.ppm.open(out, doc.name);
  };

  OPS.header = {
    title: 'Edit header', group: 'File structure', needs: 'none', verify: true,
    available: (doc) => (HEADER[doc.format] ? null : 'This file type has no header to edit.'),
    blurb: 'Rewrite the width, height, and (for BMP) colour depth or where the pixels start, directly in the file’s header. Viewers will read the same bytes differently. After each change the file is re-read, and anything that would stop it opening is refused.',
    params: [
      { id: 'width', label: 'Width', type: 'range', min: 1, max: (d) => Math.max(256, d.layout.width * 4), step: 1, def: (d) => d.layout.width, unit: 'px' },
      { id: 'fit', label: 'Fit the height to the data', type: 'checkbox', def: true },
      { id: 'height', label: 'Height (when not fitting)', type: 'range', min: 1, max: (d) => Math.max(256, d.layout.height * 4), step: 1, def: (d) => d.layout.height, unit: 'px' },
      { id: 'bpp', label: 'Colour depth (BMP)', type: 'select', def: 'keep', options: [['keep', 'Keep'], ['8', '8-bit palette (colours come from the data)'], ['24', '24-bit'], ['32', '32-bit']] },
      { id: 'offset', label: 'Move pixel start (BMP)', type: 'range', min: -300, max: 300, step: 1, def: 0, unit: 'bytes', help: 'Shifts every pixel by this many bytes. A few bytes off tints and shears the picture.' },
    ],
    run({ tx, doc, p }) {
      const fn = HEADER[doc.format], L = doc.layout, isBmp = doc.format === 'bmp';
      const sameW = Math.round(p.width) === L.width, sameH = p.fit || Math.round(p.height) === L.height, plain = !isBmp || (p.bpp === 'keep' && !Math.round(p.offset || 0));
      if (sameW && sameH && plain) return; // nothing asked for
      let nd;
      try { nd = fn(tx, doc, p); } catch (e) { throw new Error(e instanceof DB.Unsupported ? 'This header can’t be read: ' + e.message : e.message); }
      if (nd) tx.reopen(nd);
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
