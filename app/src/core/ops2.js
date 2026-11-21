(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const OPS = DB.OPS, clamp = DB.clamp;
  const H = DB.opHelpers;
  const { rowStart, normSel, readRect, writeRect, colorIdx, hasColor, lum, isRaster, seedParam, rasterOnly } = H;

  // ---------------------------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------------------------
  // Hex text like "FF 00 ?? 1A" -> [255, 0, -1, 26]. -1 is a wildcard.
  function parseHex(text, allowWild) {
    const t = String(text || '').replace(/0x/gi, '').replace(/[\s,]+/g, '');
    if (!t.length) return [];
    if (t.length % 2) throw new Error('Type hex bytes in pairs, like FF 00 1A.');
    const out = [];
    for (let i = 0; i < t.length; i += 2) {
      const h = t.substr(i, 2);
      if (h === '??' && allowWild) { out.push(-1); continue; }
      if (!/^[0-9a-f]{2}$/i.test(h)) throw new Error('“' + h + '” is not a hex byte. Use 0-9 and A-F' + (allowWild ? ' (or ?? for any byte)' : '') + '.');
      out.push(parseInt(h, 16));
    }
    return out;
  }
  DB.parseHex = parseHex;

  // Contiguous logical byte range this tool should work on.
  function byteRange(ctx) {
    const { doc, L, sel } = ctx;
    if (!isRaster(doc)) return ctx.range;
    const r = normSel(L, sel, true);
    const s0 = L.flipY ? L.height - (r.y + r.h) : r.y;
    return { a: s0 * L.stride, b: Math.min(doc.length, (s0 + r.h) * L.stride) };
  }

  // Bytes of the pixels in the selection (rect for pictures, the data range for compressed files).
  function openRegion(ctx) {
    const { doc, L, tx, sel } = ctx;
    if (isRaster(doc)) {
      const r = normSel(L, sel, true), buf = readRect(doc, L, r);
      return { buf, bpp: L.bpp, save: () => writeRect(tx, L, r, buf) };
    }
    const rg = ctx.range, buf = doc.read(rg.a, rg.b - rg.a);
    return { buf, bpp: 1, save: () => tx.write(rg.a, buf) };
  }

  const CHAN_OPTS = [['all', 'Every byte'], ['0', 'Red only'], ['1', 'Green only'], ['2', 'Blue only']];
  // which byte positions inside one pixel a channel choice touches (null = all)
  function chanMask(doc, chan) {
    if (chan === 'all' || !isRaster(doc) || !hasColor(doc.layout)) return null;
    const L = doc.layout, c = +chan, m = new Uint8Array(L.bpp);
    for (let k = 0; k < L.cb; k++) m[colorIdx(L)[c] * L.cb + k] = 1;
    return m;
  }
  const targeted = (mask, bpp, i) => !mask || mask[i % bpp] === 1;

  const GROUP_BITS = 'Bits', GROUP_BYTES = 'Bytes', GROUP_AUDIO = 'Audio', GROUP_LAYOUT = 'Layout', GROUP_ROWS = 'Rows';

  // =============================================================================================
  // BITS
  // =============================================================================================
  OPS.bitOp = {
    title: 'Bit maths', group: GROUP_BITS, needs: 'rect', defaultAll: true, available: () => null,
    blurb: 'Combine every byte with a value or a repeating pattern: XOR, AND, OR, add, subtract or invert. The most basic way to scramble data.',
    params: [
      { id: 'mode', label: 'Operation', type: 'select', def: 'xor', options: [['xor', 'XOR'], ['and', 'AND (darkens, drops bits)'], ['or', 'OR (brightens)'], ['add', 'Add (wraps around)'], ['sub', 'Subtract (wraps around)'], ['not', 'Invert every bit']] },
      { id: 'pattern', label: 'Value or pattern (hex)', type: 'text', def: '55', help: 'One byte like 55, or a pattern like 12 34 56 that repeats.' },
      { id: 'chan', label: 'Apply to', type: 'select', def: 'all', options: CHAN_OPTS },
    ],
    run(ctx) {
      const p = ctx.p, pat = parseHex(p.pattern, false), R = openRegion(ctx), mask = chanMask(ctx.doc, p.chan);
      if (!pat.length && p.mode !== 'not') throw new Error('Type at least one hex byte.');
      const b = R.buf, n = pat.length;
      for (let i = 0; i < b.length; i++) {
        if (!targeted(mask, R.bpp, i)) continue;
        const v = n ? pat[i % n] : 0;
        switch (p.mode) {
          case 'xor': b[i] ^= v; break;
          case 'and': b[i] &= v; break;
          case 'or': b[i] |= v; break;
          case 'add': b[i] = (b[i] + v) & 255; break;
          case 'sub': b[i] = (b[i] - v) & 255; break;
          default: b[i] = ~b[i] & 255;
        }
      }
      R.save();
    },
  };

  OPS.bitShift = {
    title: 'Shift or rotate bits', group: GROUP_BITS, needs: 'rect', defaultAll: true, available: () => null,
    blurb: 'Slide the bits inside every byte. Shifting loses bits (dark, crushed). Rotating keeps them (colours scramble without losing detail).',
    params: [
      { id: 'mode', label: 'Move', type: 'select', def: 'rol', options: [['shl', 'Shift left (brighter, clips)'], ['shr', 'Shift right (darker)'], ['rol', 'Rotate left'], ['ror', 'Rotate right']] },
      { id: 'amount', label: 'By', type: 'range', min: 1, max: 7, step: 1, def: 1, unit: 'bits' },
      { id: 'chan', label: 'Apply to', type: 'select', def: 'all', options: CHAN_OPTS },
    ],
    run(ctx) {
      const p = ctx.p, a = Math.round(p.amount), R = openRegion(ctx), mask = chanMask(ctx.doc, p.chan), b = R.buf;
      for (let i = 0; i < b.length; i++) {
        if (!targeted(mask, R.bpp, i)) continue;
        const v = b[i];
        b[i] = p.mode === 'shl' ? (v << a) & 255 : p.mode === 'shr' ? v >> a : p.mode === 'rol' ? ((v << a) | (v >> (8 - a))) & 255 : ((v >> a) | (v << (8 - a))) & 255;
      }
      R.save();
    },
  };

  OPS.bitPlane = {
    title: 'Bit layers', group: GROUP_BITS, needs: 'rect', defaultAll: true, available: () => null,
    blurb: 'Every byte is eight stacked bit layers. Bit 7 carries the picture, bit 0 is almost noise. Clear, set, flip or swap single layers.',
    params: [
      { id: 'mode', label: 'Do this to the layer', type: 'select', def: 'flip', options: [['clear', 'Clear it (set to 0)'], ['set', 'Set it (to 1)'], ['flip', 'Flip it'], ['only', 'Keep only this layer'], ['swap', 'Swap with another layer']] },
      { id: 'plane', label: 'Bit layer', type: 'range', min: 0, max: 7, step: 1, def: 6, help: '7 = biggest change, 0 = tiny.' },
      { id: 'plane2', label: 'Swap with (for swap)', type: 'range', min: 0, max: 7, step: 1, def: 1 },
      { id: 'chan', label: 'Apply to', type: 'select', def: 'all', options: CHAN_OPTS },
    ],
    run(ctx) {
      const p = ctx.p, m = 1 << Math.round(p.plane), q = Math.round(p.plane2), R = openRegion(ctx), mask = chanMask(ctx.doc, p.chan), b = R.buf;
      const pl = Math.round(p.plane);
      for (let i = 0; i < b.length; i++) {
        if (!targeted(mask, R.bpp, i)) continue;
        const v = b[i];
        if (p.mode === 'clear') b[i] = v & ~m;
        else if (p.mode === 'set') b[i] = v | m;
        else if (p.mode === 'flip') b[i] = v ^ m;
        else if (p.mode === 'only') b[i] = (v & m) ? 255 : 0;
        else { const x = (v >> pl) & 1, y = (v >> q) & 1; b[i] = x === y ? v : v ^ m ^ (1 << q); }
      }
      R.save();
    },
  };

  // =============================================================================================
  // BYTES: find and replace
  // =============================================================================================
  OPS.findReplace = {
    title: 'Find and replace', group: GROUP_BYTES, needs: 'band', defaultAll: true, available: () => null,
    blurb: 'Search the safe bytes for a pattern and overwrite each match. Use ?? for “any byte” in the search. In the replacement, ?? keeps the byte that was there.',
    params: [
      { id: 'find', label: 'Find (hex)', type: 'text', def: 'FF ??', help: 'Example: FF 00, or 12 ?? ?? 34.' },
      { id: 'replace', label: 'Replace with (hex)', type: 'text', def: '00 ??' },
      { id: 'limit', label: 'Stop after', type: 'range', min: 0, max: 5000, step: 1, def: 0, help: '0 = replace every match.' },
      { id: 'skip', label: 'Skip the first', type: 'range', min: 0, max: 500, step: 1, def: 0, help: 'Leave this many matches alone.' },
    ],
    run(ctx) {
      const p = ctx.p, f = parseHex(p.find, true), r = parseHex(p.replace, true), rg = byteRange(ctx);
      if (!f.length) throw new Error('Type something to look for.');
      if (!r.length) throw new Error('Type the bytes to write over each match.');
      if (f.every((x) => x < 0)) throw new Error('The search needs at least one real byte.');
      const buf = ctx.doc.read(rg.a, rg.b - rg.a), n = buf.length, limit = Math.round(p.limit), skip = Math.round(p.skip);
      let hits = 0, done = 0;
      for (let i = 0; i + f.length <= n;) {
        let ok = true;
        for (let k = 0; k < f.length; k++) if (f[k] >= 0 && buf[i + k] !== f[k]) { ok = false; break; }
        if (!ok) { i++; continue; }
        hits++;
        if (hits <= skip) { i += f.length; continue; }
        for (let k = 0; k < r.length && i + k < n; k++) if (r[k] >= 0) buf[i + k] = r[k];
        done++; i += f.length;
        if (limit && done >= limit) break;
      }
      if (!done) throw new Error(hits ? 'Every match was skipped.' : 'Nothing matches that pattern.');
      ctx.tx.write(rg.a, buf);
    },
  };

  // =============================================================================================
  // AUDIO-STYLE EFFECTS (bytes treated like 8-bit samples)
  // =============================================================================================
  const audioPrefix = 'Treats the bytes like an 8-bit sound recording, the way Audacity does with raw data. ';
  const withBand = (ctx) => { const rg = byteRange(ctx); return { rg, buf: ctx.doc.read(rg.a, rg.b - rg.a) }; };

  OPS.echo = {
    title: 'Echo', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'A delayed copy is mixed back in, so shapes repeat with a ghost. Delay equal to one row gives a vertical ghost.',
    params: [
      { id: 'delay', label: 'Delay', type: 'range', min: 1, max: 40000, step: 1, def: (d) => (d.layout.kind === 'raster' ? Math.min(40000, d.layout.stride * 4 + 3) : 600), unit: 'bytes', help: 'A multiple of the row length lines the ghost up. Add a few bytes to slant it.' },
      { id: 'decay', label: 'Strength of each echo', type: 'range', min: 0, max: 95, step: 1, def: 55, unit: '%' },
      { id: 'count', label: 'Echoes', type: 'range', min: 1, max: 8, step: 1, def: 3 },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), src = buf.slice(), p = ctx.p, d = Math.round(p.delay), g = p.decay / 100;
      for (let i = 0; i < buf.length; i++) {
        let acc = src[i] - 128, k = 1, amp = g;
        for (; k <= p.count; k++, amp *= g) { const j = i - k * d; if (j < 0) break; acc += (src[j] - 128) * amp; }
        buf[i] = clamp(Math.round(128 + acc), 0, 255);
      }
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.reverseBytes = {
    title: 'Reverse', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'Plays the data backwards. Reversing the whole band flips the picture and also mirrors the colours.',
    params: [{ id: 'chunk', label: 'Reverse in pieces of', type: 'range', min: 0, max: 100000, step: 1, def: 0, unit: 'bytes', help: '0 = the whole selection at once. A small piece reverses short stretches in place.' }],
    run(ctx) {
      const { rg, buf } = withBand(ctx), c = Math.round(ctx.p.chunk) || buf.length;
      for (let s = 0; s < buf.length; s += c) buf.subarray(s, Math.min(buf.length, s + c)).reverse();
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.gain = {
    title: 'Amplify and distort', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'Turns the volume up. What goes past the limits is clipped, wrapped around, or folded back, which is how audio distortion works.',
    params: [
      { id: 'gain', label: 'Gain', type: 'range', min: 0.1, max: 8, step: 0.05, def: 2.2, unit: '×' },
      { id: 'over', label: 'When it overflows', type: 'select', def: 'wrap', options: [['clip', 'Clip (flat tops)'], ['wrap', 'Wrap around (colour bands)'], ['fold', 'Fold back (soft ripples)']] },
      { id: 'around', label: 'Scale around', type: 'select', def: '128', options: [['128', 'Middle grey (audio style)'], ['0', 'Zero (brightness)']] },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), p = ctx.p, c = +p.around;
      for (let i = 0; i < buf.length; i++) {
        let v = (buf[i] - c) * p.gain + c;
        if (p.over === 'clip') v = clamp(v, 0, 255);
        else if (p.over === 'wrap') v = ((Math.round(v) % 256) + 256) % 256;
        else { v = Math.abs(((v % 510) + 510) % 510); if (v > 255) v = 510 - v; }
        buf[i] = Math.round(v);
      }
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.speed = {
    title: 'Change speed', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'Re-reads the data faster or slower, like changing the speed on a tape. Details stretch or repeat and rows slide out of line.',
    params: [
      { id: 'factor', label: 'Speed', type: 'range', min: 0.25, max: 4, step: 0.01, def: 1.5, unit: '×', help: 'Above 1 skips ahead, below 1 repeats. It wraps at the end.' },
      { id: 'smooth', label: 'Smooth between samples', type: 'checkbox', def: false },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), src = buf.slice(), n = src.length, f = ctx.p.factor;
      for (let i = 0; i < n; i++) {
        const pos = i * f, j = Math.floor(pos) % n;
        if (ctx.p.smooth) { const t = pos - Math.floor(pos); buf[i] = Math.round(src[j] * (1 - t) + src[(j + 1) % n] * t); } else buf[i] = src[j];
      }
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.tremolo = {
    title: 'Tremolo', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'A slow wobble in volume. Picture: stripes that pulse through the image, tied to the period you choose.',
    params: [
      { id: 'period', label: 'Period', type: 'range', min: 2, max: 20000, step: 1, def: (d) => (d.layout.kind === 'raster' ? d.layout.stride * 6 : 900), unit: 'bytes' },
      { id: 'depth', label: 'Depth', type: 'range', min: 0, max: 100, step: 1, def: 75, unit: '%' },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), per = ctx.p.period, depth = ctx.p.depth / 100;
      for (let i = 0; i < buf.length; i++) {
        const m = 1 - depth * (0.5 + 0.5 * Math.sin((2 * Math.PI * i) / per));
        buf[i] = clamp(Math.round(128 + (buf[i] - 128) * m), 0, 255);
      }
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.holdSamples = {
    title: 'Sample hold', group: GROUP_AUDIO, needs: 'band', defaultAll: true, available: () => null,
    blurb: audioPrefix + 'Keeps one byte and repeats it, like a low sample rate. Pictures turn into smeared blocks.',
    params: [{ id: 'every', label: 'Hold for', type: 'range', min: 2, max: 512, step: 1, def: 6, unit: 'bytes' }],
    run(ctx) {
      const { rg, buf } = withBand(ctx), n = Math.round(ctx.p.every);
      for (let i = 0; i < buf.length; i++) buf[i] = buf[i - (i % n)];
      ctx.tx.write(rg.a, buf);
    },
  };

  // =============================================================================================
  // LAYOUT: wrong readings of the same bytes
  // =============================================================================================
  OPS.swapWords = {
    title: 'Flip byte order', group: GROUP_LAYOUT, needs: 'band', defaultAll: true, available: () => null,
    blurb: 'Reverse the bytes inside every word, as if the file had been written by a computer that stores numbers the other way round. Colours scramble in a regular way.',
    params: [
      { id: 'size', label: 'Word size', type: 'select', def: '3', options: [['2', '2 bytes'], ['3', '3 bytes (swaps R and B)'], ['4', '4 bytes'], ['8', '8 bytes']] },
      { id: 'offset', label: 'Start offset', type: 'range', min: 0, max: 7, step: 1, def: 0, unit: 'bytes', help: 'Starting off a word boundary swaps different bytes.' },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), n = +ctx.p.size, o = Math.round(ctx.p.offset) % n;
      for (let i = o; i + n <= buf.length; i += n) buf.subarray(i, i + n).reverse();
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.planar = {
    title: 'Regroup colour channels', group: GROUP_LAYOUT, needs: 'band', defaultAll: true, available: () => null,
    blurb: 'Pictures store R G B R G B … side by side. This regroups them as RRR… GGG… BBB… (or back), the way a different file layout would read the same data.',
    params: [
      { id: 'mode', label: 'Rearrange as', type: 'select', def: 'rowsplit', options: [['rowsplit', 'Planar, each row on its own'], ['rowjoin', 'Interleave, each row on its own'], ['split', 'Planar, the whole selection'], ['join', 'Interleave, the whole selection']] },
      { id: 'n', label: 'Values per pixel', type: 'range', min: 2, max: 8, step: 1, def: (d) => (isRaster(d) && d.layout.bpp > 1 ? Math.min(8, d.layout.bpp) : 3) },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), n = Math.round(ctx.p.n), doc = ctx.doc;
      const split = (b) => { const m = Math.floor(b.length / n), src = b.slice(); for (let c = 0; c < n; c++) for (let i = 0; i < m; i++) b[c * m + i] = src[i * n + c]; };
      const join = (b) => { const m = Math.floor(b.length / n), src = b.slice(); for (let c = 0; c < n; c++) for (let i = 0; i < m; i++) b[i * n + c] = src[c * m + i]; };
      const f = ctx.p.mode.endsWith('split') || ctx.p.mode === 'split' ? split : join;
      if (ctx.p.mode.startsWith('row') && isRaster(doc)) { const st = doc.layout.stride; for (let s = 0; s + st <= buf.length; s += st) f(buf.subarray(s, s + st)); }
      else f(buf);
      ctx.tx.write(rg.a, buf);
    },
  };

  OPS.rePixel = {
    title: 'Wrong pixel size', group: GROUP_LAYOUT, needs: 'band', defaultAll: true, available: () => null,
    blurb: 'Read the data as if every pixel had a different number of bytes. Parts of the picture get stretched, repeated and re-coloured.',
    params: [
      { id: 'size', label: 'Read pixels as', type: 'range', min: 1, max: 8, step: 1, def: (d) => (isRaster(d) ? Math.min(8, d.layout.bpp + 1) : 4), unit: 'bytes' },
      { id: 'unit', label: 'Real pixel size', type: 'range', min: 1, max: 8, step: 1, def: (d) => (isRaster(d) ? Math.min(8, d.layout.bpp) : 3), unit: 'bytes', help: 'Normally the picture’s own pixel size.' },
    ],
    run(ctx) {
      const { rg, buf } = withBand(ctx), src = buf.slice(), N = Math.round(ctx.p.size), B = Math.round(ctx.p.unit), n = src.length;
      const px = Math.floor(n / B);
      for (let k = 0; k < px; k++) for (let c = 0; c < B; c++) buf[k * B + c] = src[(k * N + (c % N)) % n];
      ctx.tx.write(rg.a, buf);
    },
  };

  // =============================================================================================
  // ROWS
  // =============================================================================================
  OPS.rows = {
    title: 'Row tricks', group: GROUP_ROWS, needs: 'band', defaultAll: true, available: rasterOnly,
    blurb: 'Work on whole rows: hold, drop, duplicate, shuffle, reverse, sort by brightness, or weave the top and bottom halves together.',
    params: [
      { id: 'mode', label: 'Do this', type: 'select', def: 'hold', options: [['hold', 'Hold: repeat the first row of every group'], ['drop', 'Drop: remove one row in every group'], ['dup', 'Duplicate one row in every group'], ['shuffle', 'Shuffle rows inside blocks'], ['reverse', 'Reverse the order of rows'], ['sort', 'Sort rows dark to light'], ['weave', 'Weave top and bottom halves']] },
      { id: 'n', label: 'Group / block size', type: 'range', min: 1, max: 200, step: 1, def: 8, unit: 'rows', help: 'For shuffle: 1 means the whole selection.' },
      seedParam,
    ],
    run(ctx) {
      const { doc, L, tx, sel, p, rng } = ctx, r = normSel(L, sel, true); if (!r) return;
      const rows = []; for (let j = 0; j < r.h; j++) rows.push(doc.read(rowStart(L, r.y + j), L.stride));
      const n = Math.max(1, Math.round(p.n)); let out;
      if (p.mode === 'hold') out = rows.map((_, i) => rows[i - (i % n)]);
      else if (p.mode === 'drop') { const keep = rows.filter((_, i) => i % Math.max(2, n) !== Math.max(2, n) - 1); out = keep.slice(); while (out.length < rows.length) out.push(keep[keep.length - 1] || rows[rows.length - 1]); }
      else if (p.mode === 'dup') { out = []; rows.forEach((row, i) => { out.push(row); if (i % Math.max(2, n) === Math.max(2, n) - 1) out.push(row); }); out = out.slice(0, rows.length); }
      else if (p.mode === 'shuffle') {
        const bs = n === 1 ? rows.length : n; out = [];
        for (let s = 0; s < rows.length; s += bs) { const blk = rows.slice(s, s + bs); for (let i = blk.length - 1; i > 0; i--) { const j = rng.int(i + 1); [blk[i], blk[j]] = [blk[j], blk[i]]; } out.push(...blk); }
      }
      else if (p.mode === 'reverse') out = rows.slice().reverse();
      else if (p.mode === 'sort') {
        const avg = (row) => { let s = 0, c = 0; for (let i = 0; i + L.bpp <= Math.min(row.length, L.width * L.bpp); i += L.bpp) { s += lum(row, i, L); c++; } return s / Math.max(1, c); };
        out = rows.map((row) => [avg(row), row]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
      }
      else { const half = Math.floor(rows.length / 2); out = []; for (let i = 0; i < half; i++) { out.push(rows[i], rows[half + i]); } if (rows.length % 2) out.push(rows[rows.length - 1]); }
      for (let j = 0; j < out.length; j++) tx.write(rowStart(L, r.y + j), out[j]);
    },
  };

  // =============================================================================================
  // JPEG
  // =============================================================================================
  const restartAvail = (doc) => {
    if (doc.format !== 'jpeg') return 'Only works on JPEG files (this one is ' + doc.format.toUpperCase() + ').';
    if (!(doc.meta.restartCount > 1)) return 'This JPEG is not split into blocks yet. Use Convert → “JPEG made of blocks” first.';
    return null;
  };

  // Splits one scan into restart blocks. Returns [{a,b}] bodies (logical offsets) and the marker bytes between them.
  function restartBlocks(doc, seg) {
    const bytes = doc.read(seg.lstart, seg.len), bodies = [], markers = [];
    let start = 0;
    for (let i = 0; i < bytes.length - 1; i++) {
      if (bytes[i] === 0xff && bytes[i + 1] >= 0xd0 && bytes[i + 1] <= 0xd7) { bodies.push([start, i]); markers.push(bytes[i + 1]); start = i + 2; i++; }
    }
    bodies.push([start, bytes.length]);
    return { bytes, bodies, markers };
  }

  OPS.restartBlocks = {
    title: 'Shuffle JPEG blocks', group: 'JPEG', needs: 'band', defaultAll: true, available: restartAvail,
    blurb: 'A JPEG with restart markers is made of independent blocks. Reordering them gives clean, blocky, valid glitches that a normal edit never would.',
    params: [
      { id: 'mode', label: 'Do this', type: 'select', def: 'shuffle', options: [['shuffle', 'Shuffle the blocks'], ['reverse', 'Reverse their order'], ['repeat', 'Repeat the previous block'], ['drop', 'Empty some blocks (grey)'], ['swap', 'Swap neighbours']] },
      { id: 'chance', label: 'Share of blocks', type: 'range', min: 1, max: 100, step: 1, def: 40, unit: '%', help: 'Used by repeat, empty and swap.' },
      seedParam,
    ],
    run(ctx) {
      const { doc, tx, p, rng, range } = ctx;
      for (const seg of doc.segments) {
        const { bytes, bodies, markers } = restartBlocks(doc, seg);
        if (bodies.length < 2) continue;
        // blocks that start inside the selected stretch
        const idx = []; bodies.forEach((b, i) => { const lo = seg.lstart + b[0], hi = seg.lstart + b[1]; if (hi > range.a && lo < range.b) idx.push(i); });
        if (idx.length < 2) continue;
        const bodyOf = (i) => bytes.slice(bodies[i][0], bodies[i][1]);
        let order = idx.slice();
        if (p.mode === 'shuffle') for (let i = order.length - 1; i > 0; i--) { const j = rng.int(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        else if (p.mode === 'reverse') order.reverse();
        else if (p.mode === 'swap') { for (let i = 0; i + 1 < order.length; i += 2) if (rng() * 100 < p.chance) [order[i], order[i + 1]] = [order[i + 1], order[i]]; }
        const out = [];
        order.forEach((src, k) => {
          let body = bodyOf(src);
          if (p.mode === 'repeat' && k > 0 && rng() * 100 < p.chance) body = bodyOf(order[k - 1]);
          if (p.mode === 'drop' && rng() * 100 < p.chance) body = new Uint8Array(0);
          out.push(body);
        });
        // put the blocks back between the original markers, keeping the span the same length
        const first = idx[0], last = idx[idx.length - 1], a = bodies[first][0], b = bodies[last][1];
        const parts = [];
        out.forEach((body, k) => { parts.push(body); if (k < out.length - 1) parts.push(Uint8Array.of(0xff, markers[first + k])); });
        let total = 0; for (const x of parts) total += x.length;
        const span = new Uint8Array(b - a); let o = 0;
        for (const x of parts) { if (!x.length) continue; const n = Math.min(x.length, span.length - o); if (n <= 0) break; span.set(x.subarray(0, n), o); o += n; }
        tx.write(seg.lstart + a, span);
      }
    },
  };

  OPS.sampling = {
    title: 'JPEG colour detail', group: 'JPEG', needs: 'none', available: (doc) => (doc.format === 'jpeg' ? null : 'Only works on JPEG files (this one is ' + doc.format.toUpperCase() + ').'),
    blurb: 'JPEG stores colour at a lower resolution than brightness. Lying about that in the header makes the decoder cut the data into the wrong blocks, so colours shear and shift.',
    params: [
      { id: 'yh', label: 'Brightness: across', type: 'range', min: 1, max: 4, step: 1, def: (d) => (d.buf[d.meta.sof.off + 11] >> 4) || 2 },
      { id: 'yv', label: 'Brightness: down', type: 'range', min: 1, max: 4, step: 1, def: (d) => (d.buf[d.meta.sof.off + 11] & 15) || 2 },
      { id: 'ch', label: 'Colour: across', type: 'range', min: 1, max: 4, step: 1, def: 1 },
      { id: 'cv', label: 'Colour: down', type: 'range', min: 1, max: 4, step: 1, def: 3 },
    ],
    run({ tx, doc, p }) {
      const sof = doc.meta.sof;
      for (let i = 0; i < sof.ncomp; i++) {
        const h = i === 0 ? p.yh : p.ch, v = i === 0 ? p.yv : p.cv;
        tx.raw(sof.off + 11 + 3 * i, Uint8Array.of(((Math.round(h) & 15) << 4) | (Math.round(v) & 15)));
      }
      tx.full = true;
    },
  };

  // =============================================================================================
  // MIX: use another image's pixels or bytes
  // =============================================================================================
  const PICTURE_MODES = ['replace', 'xor', 'add', 'difference', 'average', 'lighten', 'darken', 'channels'];
  OPS.mash = {
    title: 'Mix with another image', group: 'Mix', needs: 'rect', defaultAll: true, available: () => null,
    blurb: 'Pull a second image into this one: paste, XOR, blend, take its colour channels, or interleave its raw bytes with yours.',
    params: [
      { id: 'src', label: 'Other image', type: 'file', def: null },
      { id: 'mode', label: 'Combine by', type: 'select', def: 'xor', options: [['replace', 'Pasting its picture'], ['xor', 'XOR with its picture'], ['add', 'Adding its picture (wraps)'], ['difference', 'Difference'], ['average', 'Blending (crossfade)'], ['lighten', 'Keeping the lighter pixel'], ['darken', 'Keeping the darker pixel'], ['channels', 'Taking colour channels from it'], ['interleave', 'Interleaving raw bytes'], ['rawxor', 'XOR with its raw bytes']] },
      { id: 'amount', label: 'Blend amount', type: 'range', min: 0, max: 100, step: 1, def: 50, unit: '%', help: 'For blending.' },
      { id: 'ramp', label: 'Blend across', type: 'select', def: 'flat', options: [['flat', 'Evenly (uses the amount)'], ['x', 'Left to right, 0 to 100%'], ['y', 'Top to bottom, 0 to 100%']] },
      { id: 'which', label: 'Channels to take', type: 'select', def: 'r', options: [['r', 'Red'], ['g', 'Green'], ['b', 'Blue'], ['rg', 'Red + green'], ['gb', 'Green + blue'], ['rb', 'Red + blue']] },
      { id: 'chunk', label: 'Piece size (interleave)', type: 'range', min: 1, max: 8192, step: 1, def: 96, unit: 'bytes', help: 'Alternates this many of your bytes, then this many of theirs.' },
    ],
    run(ctx) {
      const { doc, L, tx, sel, p } = ctx, src = p.src;
      if (!src) throw new Error('Choose the other image first.');
      if (p.mode === 'interleave' || p.mode === 'rawxor') {
        const rg = byteRange(ctx), buf = doc.read(rg.a, rg.b - rg.a), raw = src.raw, c = Math.max(1, Math.round(p.chunk));
        if (!raw || !raw.length) throw new Error('That file has no bytes to use.');
        if (p.mode === 'rawxor') for (let i = 0; i < buf.length; i++) buf[i] ^= raw[(rg.a + i) % raw.length];
        else for (let i = 0; i < buf.length; i++) if (Math.floor(i / c) % 2) buf[i] = raw[(rg.a + i) % raw.length];
        tx.write(rg.a, buf); return;
      }
      if (!isRaster(doc)) throw new Error('Mixing pictures needs a BMP, TIFF, PNG or GIF. For a JPEG use the raw byte modes.');
      if (!hasColor(L)) throw new Error('Mixing pictures needs an RGB image.');
      const r = normSel(L, sel, true), buf = readRect(doc, L, r), P = colorIdx(L), hb = L.cb === 2 ? L.hb : 0, bpp = L.bpp;
      const allow = p.mode === 'channels' ? [0, 1, 2].filter((c) => p.which.includes('rgb'[c])) : [0, 1, 2];
      const amt = p.amount / 100;
      for (let y = 0; y < r.h; y++) {
        const sy = Math.min(src.h - 1, Math.floor(((r.y + y) / L.height) * src.h));
        for (let x = 0; x < r.w; x++) {
          const sx = Math.min(src.w - 1, Math.floor(((r.x + x) / L.width) * src.w)), si = (sy * src.w + sx) * 4;
          let a = amt; if (p.ramp === 'x') a = (r.x + x) / L.width; else if (p.ramp === 'y') a = (r.y + y) / L.height;
          for (const c of allow) {
            const o = (y * r.w + x) * bpp + P[c] * L.cb + hb, v = buf[o], s = src.rgba[si + c];
            let n;
            switch (p.mode) {
              case 'replace': case 'channels': n = s; break;
              case 'xor': n = v ^ s; break;
              case 'add': n = (v + s) & 255; break;
              case 'difference': n = Math.abs(v - s); break;
              case 'average': n = Math.round(v + (s - v) * a); break;
              case 'lighten': n = Math.max(v, s); break;
              default: n = Math.min(v, s);
            }
            buf[o] = n;
          }
        }
      }
      writeRect(tx, L, r, buf);
    },
  };
  // Build the object the Mix tool wants. rgba is the other picture's pixels (any size), raw its bytes.
  DB.makeSource = (rgba, w, h, raw, name) => ({ rgba, w, h, raw, name });

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
