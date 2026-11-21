(function () {
  const DB = (globalThis.DB = globalThis.DB || {});
  const clamp = DB.clamp;

  // =============================================================================================
  // Helpers
  // =============================================================================================
  const rowStart = (L, y) => (L.flipY ? L.height - 1 - y : y) * L.stride;

  // Normalise a selection to the image. `whole` => use the full image when nothing is selected.
  function normSel(L, sel, whole) {
    if (!sel || !(sel.w > 0 && sel.h > 0)) return whole ? { x: 0, y: 0, w: L.width, h: L.height } : null;
    let x = Math.round(sel.x), y = Math.round(sel.y), x2 = Math.round(sel.x + sel.w), y2 = Math.round(sel.y + sel.h);
    x = clamp(x, 0, L.width); x2 = clamp(x2, 0, L.width); y = clamp(y, 0, L.height); y2 = clamp(y2, 0, L.height);
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
  }
  DB.normSel = normSel;

  function readRect(doc, L, r) {
    const rb = r.w * L.bpp, out = new Uint8Array(rb * r.h);
    for (let j = 0; j < r.h; j++) out.set(doc.read(rowStart(L, r.y + j) + r.x * L.bpp, rb), j * rb);
    return out;
  }
  function writeRect(tx, L, r, buf) {
    const rb = r.w * L.bpp;
    for (let j = 0; j < r.h; j++) tx.write(rowStart(L, r.y + j) + r.x * L.bpp, buf.subarray(j * rb, (j + 1) * rb));
  }
  const colorIdx = (L) => [L.ri, L.gi, L.bi];
  const hasColor = (L) => !L.indexed && L.ri !== L.gi && L.gi !== L.bi && L.nch >= 3;

  // permute / rotate / invert the colour channels of every pixel in `buf` (in place). perm[c] = which source channel feeds c.
  function permuteChannels(buf, L, perm, invert) {
    const P = colorIdx(L), cb = L.cb, bpp = L.bpp, tmp = new Uint8Array(bpp);
    for (let s = 0; s + bpp <= buf.length; s += bpp) {
      for (let i = 0; i < bpp; i++) tmp[i] = buf[s + i];
      for (let c = 0; c < 3; c++) {
        const from = P[perm[c]] * cb, to = P[c] * cb;
        for (let k = 0; k < cb; k++) buf[s + to + k] = invert && invert[c] ? 255 - tmp[from + k] : tmp[from + k];
      }
    }
  }

  function lum(buf, s, L) {
    if (L.indexed) { const i3 = buf[s] * 3, p = L.palette; return (p[i3] * 299 + p[i3 + 1] * 587 + p[i3 + 2] * 114) / 1000; }
    const o = L.cb === 2 ? L.hb : 0;
    return (buf[s + L.ri * L.cb + o] * 299 + buf[s + L.gi * L.cb + o] * 587 + buf[s + L.bi * L.cb + o] * 114) / 1000;
  }

  function parseColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '#ff00ff');
    const n = parseInt(m ? m[1] : 'ff00ff', 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // bytes of ONE pixel of colour rgb in this image's layout
  function pixelBytes(L, rgb) {
    const px = new Uint8Array(L.bpp);
    if (L.indexed) {
      let best = 0, bd = 1e9;
      for (let i = 0; i < 256; i++) {
        const d = (L.palette[i * 3] - rgb[0]) ** 2 + (L.palette[i * 3 + 1] - rgb[1]) ** 2 + (L.palette[i * 3 + 2] - rgb[2]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      px[0] = best; return px;
    }
    const P = colorIdx(L);
    for (let c = 0; c < 3; c++) for (let k = 0; k < L.cb; k++) px[P[c] * L.cb + k] = rgb[c];
    if (L.ai >= 0) for (let k = 0; k < L.cb; k++) px[L.ai * L.cb + k] = 255;
    if (L.invert) { for (let k = 0; k < px.length; k++) px[k] = 255 - px[k]; }
    return px;
  }

  // Selection -> logical byte range for compressed (stream) formats. Vertical position ~ position in the data.
  function streamRange(doc, sel) {
    const L = doc.layout, n = doc.length;
    if (!sel || !(sel.h > 0)) return { a: 0, b: n };
    const a = Math.floor(clamp(sel.y / L.height, 0, 1) * n), b = Math.ceil(clamp((sel.y + sel.h) / L.height, 0, 1) * n);
    return { a: clamp(a, 0, n - 1), b: clamp(Math.max(b, a + 1), 1, n) };
  }
  DB.streamRange = streamRange;

  const isRaster = (doc) => doc.layout.kind === 'raster';
  const fmtName = (doc) => doc.format.toUpperCase();
  const only = (...fmts) => (doc) => (fmts.includes(doc.format) ? null : 'Only works on ' + fmts.map((f) => f.toUpperCase()).join(' or ') + ' files (this one is ' + fmtName(doc) + ').');
  const rasterOnly = (doc) => (isRaster(doc) ? null : 'Needs raw pixels. This is a ' + fmtName(doc) + ': use Convert → Copy as BMP first.');
  const streamOnly = (doc) => (!isRaster(doc) ? null : 'Only works on JPEG and WebP files (this one is ' + fmtName(doc) + ').');
  const indexedOnly = (doc) => (isRaster(doc) && doc.layout.indexed ? null : 'Needs an image with a colour palette, such as a GIF or 8-bit PNG.');
  const colorOnly = (doc) => (isRaster(doc) ? (hasColor(doc.layout) ? null : 'Needs a full-colour image (this one is greyscale or palette-based).') : 'Needs raw pixels. This is a ' + fmtName(doc) + ': use Convert → Copy as BMP first.');
  const seedParam = { id: 'seed', label: 'Seed', type: 'seed', def: 1, help: 'Same seed = same result. Change it to roll the dice again.' };

  const OPS = {};

  // =============================================================================================
  // RASTER TOOLS (BMP, TIFF, PNG)
  // =============================================================================================
  OPS.stamp = {
    title: 'Duplicate & stamp', group: 'Move', needs: 'rect', available: rasterOnly, ghost: 'dest',
    blurb: 'Copy the selected area somewhere else. Repeat it with a step for stutters and drags.',
    params: [
      { id: 'dest', label: 'Paste at', type: 'point', def: (d, s) => ({ x: s ? s.x : 0, y: s ? Math.min(s.y + s.h, d.layout.height - 1) : 0 }), help: 'Drag the dashed box on the image, or type numbers.' },
      { id: 'repeat', label: 'Repeat', type: 'range', min: 1, max: 60, step: 1, def: 1 },
      { id: 'stepX', label: 'Step across', type: 'range', min: -400, max: 400, step: 1, def: 0, unit: 'px', help: 'Each repeat moves this far right (or left).' },
      { id: 'stepY', label: 'Step down', type: 'range', min: -400, max: 400, step: 1, def: 0, unit: 'px' },
      { id: 'chRot', label: 'Colours', type: 'select', def: '0', options: [['0', 'Keep'], ['1', 'Rotate →'], ['2', 'Rotate ←']], help: 'Rotating swaps which channel is which: green sky, purple building.' },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, false); if (!r) return;
      const rb = r.w * L.bpp, rows = [];
      for (let j = 0; j < r.h; j++) rows.push(doc.read(rowStart(L, r.y + j) + r.x * L.bpp, rb));
      const rot = +p.chRot;
      if (rot && hasColor(L)) { const perm = rot === 1 ? [1, 2, 0] : [2, 0, 1]; for (const row of rows) permuteChannels(row, L, perm); }
      for (let n = 0; n < p.repeat; n++) {
        const ox = Math.round(p.dest.x + n * p.stepX), oy = Math.round(p.dest.y + n * p.stepY);
        const x0 = Math.max(0, ox), x1 = Math.min(L.width, ox + r.w);
        if (x1 <= x0) continue;
        for (let j = 0; j < r.h; j++) {
          const ty = oy + j; if (ty < 0 || ty >= L.height) continue;
          tx.write(rowStart(L, ty) + x0 * L.bpp, rows[j].subarray((x0 - ox) * L.bpp, (x1 - ox) * L.bpp));
        }
      }
    },
  };

  OPS.slide = {
    title: 'Slide rows (wraps)', group: 'Move', needs: 'band', available: rasterOnly,
    blurb: 'Shift the selected rows sideways. What slides off one edge spills into the next row, like pasting in a hex editor at an offset.',
    params: [
      { id: 'shift', label: 'Shift', type: 'range', min: (d) => -d.layout.width, max: (d) => d.layout.width, step: 1, def: 100, unit: 'px', help: 'Positive = right, negative = left.' },
      { id: 'byteOff', label: 'Colour offset', type: 'select', def: '0', options: [['0', 'Aligned (keeps colours)'], ['1', '+1 byte (shifts colours)'], ['2', '+2 bytes (shifts colours)']], help: 'Pasting off a pixel boundary makes the channels land in the wrong place.' },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, false); if (!r) return;
      const lo = Math.min(rowStart(L, r.y), rowStart(L, r.y + r.h - 1)), len = r.h * L.stride;
      const src = doc.read(lo, len);
      const dest = lo + Math.round(p.shift) * L.bpp + (+p.byteOff);
      tx.write(dest, src);
    },
  };

  OPS.shear = {
    title: 'Diagonal shear', group: 'Move', needs: 'rect', available: rasterOnly, defaultAll: true,
    blurb: 'Every row slides a little further than the one above it, making a smooth diagonal slant. The thing you cannot do by hand.',
    params: [
      { id: 'perRow', label: 'Slant', type: 'range', min: -12, max: 12, step: 0.05, def: 1.5, unit: 'px/row', help: 'How far each row moves relative to the previous one.' },
      { id: 'start', label: 'Starting shift', type: 'range', min: -400, max: 400, step: 1, def: 0, unit: 'px' },
      { id: 'wave', label: 'Wobble', type: 'range', min: 0, max: 100, step: 1, def: 0, unit: 'px', help: 'Adds a sine wave on top of the slant.' },
      { id: 'waveLen', label: 'Wobble length', type: 'range', min: 10, max: 2000, step: 10, def: 300, unit: 'rows' },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), rb = r.w * L.bpp, out = new Uint8Array(buf.length);
      for (let j = 0; j < r.h; j++) {
        let s = Math.round(p.start + j * p.perRow + (p.wave ? Math.sin((j / p.waveLen) * 6.2832) * p.wave : 0));
        s = ((s % r.w) + r.w) % r.w;
        const row = buf.subarray(j * rb, (j + 1) * rb), o = out.subarray(j * rb, (j + 1) * rb);
        o.set(row.subarray(0, (r.w - s) * L.bpp), s * L.bpp);
        o.set(row.subarray((r.w - s) * L.bpp), 0);
      }
      writeRect(tx, L, r, out);
    },
  };

  OPS.mirror = {
    title: 'Mirror & flip', group: 'Move', needs: 'rect', available: rasterOnly, defaultAll: true,
    blurb: 'Flip the selection, or mirror one half over the other (either way round).',
    params: [{ id: 'mode', label: 'Mode', type: 'select', def: 'hFlip', options: [['hFlip', 'Flip left ↔ right'], ['vFlip', 'Flip top ↔ bottom'], ['lr', 'Mirror left half onto right'], ['rl', 'Mirror right half onto left'], ['tb', 'Mirror top half onto bottom'], ['bt', 'Mirror bottom half onto top']] }],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), bpp = L.bpp, rb = r.w * bpp, out = buf.slice();
      for (let j = 0; j < r.h; j++) {
        for (let i = 0; i < r.w; i++) {
          let sj = j, si = i;
          if (p.mode === 'hFlip') si = r.w - 1 - i;
          else if (p.mode === 'vFlip') sj = r.h - 1 - j;
          else if (p.mode === 'lr') { if (i >= r.w / 2) si = r.w - 1 - i; }
          else if (p.mode === 'rl') { if (i < r.w / 2) si = r.w - 1 - i; }
          else if (p.mode === 'tb') { if (j >= r.h / 2) sj = r.h - 1 - j; }
          else if (p.mode === 'bt') { if (j < r.h / 2) sj = r.h - 1 - j; }
          if (si === i && sj === j) continue;
          const d = j * rb + i * bpp, s = sj * rb + si * bpp;
          for (let k = 0; k < bpp; k++) out[d + k] = buf[s + k];
        }
      }
      writeRect(tx, L, r, out);
    },
  };

  OPS.smear = {
    title: 'Pixel smear', group: 'Destroy', needs: 'rect', available: rasterOnly,
    blurb: 'Stretch the edge pixels across the selection, like a scanner dragging. Jitter makes every row stop at a different place.',
    params: [
      { id: 'dir', label: 'Direction', type: 'select', def: 'right', options: [['right', 'Right'], ['left', 'Left'], ['down', 'Down'], ['up', 'Up']] },
      { id: 'jitter', label: 'Jitter', type: 'range', min: 0, max: 100, step: 1, def: 60, unit: '%', help: '0 = the smear always fills the whole selection. Higher = ragged lengths.' },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, false); if (!r) return;
      const buf = readRect(doc, L, r), bpp = L.bpp, rb = r.w * bpp, j = p.jitter / 100;
      const horiz = p.dir === 'right' || p.dir === 'left';
      const lines = horiz ? r.h : r.w, span = horiz ? r.w : r.h;
      for (let n = 0; n < lines; n++) {
        const len = Math.max(1, Math.round(span * (1 - j * rng())));
        for (let k = 1; k < len; k++) {
          let sx, sy, dx, dy;
          if (p.dir === 'right') { sx = 0; sy = n; dx = k; dy = n; }
          else if (p.dir === 'left') { sx = r.w - 1; sy = n; dx = r.w - 1 - k; dy = n; }
          else if (p.dir === 'down') { sx = n; sy = 0; dx = n; dy = k; }
          else { sx = n; sy = r.h - 1; dx = n; dy = r.h - 1 - k; }
          for (let b = 0; b < bpp; b++) buf[dy * rb + dx * bpp + b] = buf[sy * rb + sx * bpp + b];
        }
      }
      writeRect(tx, L, r, buf);
    },
  };

  OPS.shatter = {
    title: 'Shatter', group: 'Destroy', needs: 'rect', available: rasterOnly, defaultAll: true,
    blurb: 'Copy random chunks of the image onto random places inside the selection.',
    params: [
      { id: 'pieces', label: 'Pieces', type: 'range', min: 1, max: 600, step: 1, def: 60 },
      { id: 'maxW', label: 'Longest piece', type: 'range', min: 4, max: (d) => d.layout.width, step: 1, def: (d) => Math.round(d.layout.width / 6), unit: 'px' },
      { id: 'maxH', label: 'Tallest piece', type: 'range', min: 1, max: 400, step: 1, def: 12, unit: 'px' },
      { id: 'colour', label: 'Rotate colours randomly', type: 'checkbox', def: false },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), bpp = L.bpp, rb = r.w * bpp, out = buf.slice();
      for (let n = 0; n < p.pieces; n++) {
        const w = rng.range(2, Math.max(2, Math.min(p.maxW, r.w))), h = rng.range(1, Math.max(1, Math.min(p.maxH, r.h)));
        const sx = rng.int(r.w - w + 1), sy = rng.int(r.h - h + 1), dx = rng.int(r.w - w + 1), dy = rng.int(r.h - h + 1);
        const rot = p.colour && hasColor(L) ? rng.int(3) : 0;
        for (let j = 0; j < h; j++) {
          const src = buf.subarray((sy + j) * rb + sx * bpp, (sy + j) * rb + (sx + w) * bpp).slice();
          if (rot) permuteChannels(src, L, rot === 1 ? [1, 2, 0] : [2, 0, 1]);
          out.set(src, (dy + j) * rb + dx * bpp);
        }
      }
      writeRect(tx, L, r, out);
    },
  };

  OPS.noise = {
    title: 'Byte noise', group: 'Destroy', needs: 'rect', available: rasterOnly, defaultAll: true,
    blurb: 'Overwrite random bytes with random values: static, speckle, dust.',
    params: [
      { id: 'amount', label: 'Amount', type: 'range', min: 0.01, max: 100, step: 0.01, def: 2, unit: '%', help: 'Share of all bytes in the selection that get overwritten.' },
      { id: 'mode', label: 'Style', type: 'select', def: 'random', options: [['random', 'Random values'], ['nudge', 'Small nudges (±24)'], ['bright', 'Bright specks'], ['dark', 'Dark specks']] },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), n = Math.floor(buf.length * p.amount / 100);
      for (let i = 0; i < n; i++) {
        const o = rng.int(buf.length);
        buf[o] = p.mode === 'nudge' ? clamp(buf[o] + rng.range(-24, 24), 0, 255) : p.mode === 'bright' ? 255 : p.mode === 'dark' ? 0 : rng.int(256);
      }
      writeRect(tx, L, r, buf);
    },
  };

  OPS.fill = {
    title: 'Fill', group: 'Destroy', needs: 'rect', available: rasterOnly,
    blurb: 'Paint the selection with a solid colour, or with static.',
    params: [
      { id: 'mode', label: 'Fill with', type: 'select', def: 'solid', options: [['solid', 'Solid colour'], ['static', 'TV static'], ['bars', 'Colour bars']] },
      { id: 'color', label: 'Colour', type: 'color', def: '#ff00ff' },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, false); if (!r) return;
      const bpp = L.bpp, buf = new Uint8Array(r.w * r.h * bpp);
      if (p.mode === 'solid') {
        const px = pixelBytes(L, parseColor(p.color));
        for (let i = 0; i < r.w * r.h; i++) buf.set(px, i * bpp);
      } else if (p.mode === 'static') {
        for (let i = 0; i < buf.length; i++) buf[i] = rng.int(256);
      } else {
        const cols = [[255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0], [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0]].map((c) => pixelBytes(L, c));
        for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w; i++) buf.set(cols[Math.floor((i / r.w) * 8)], (j * r.w + i) * bpp);
      }
      writeRect(tx, L, r, buf);
    },
  };

  OPS.rgbSplit = {
    title: 'Colour split', group: 'Colour', needs: 'rect', available: colorOnly, defaultAll: true,
    blurb: 'Push the red, green and blue channels apart, like a misregistered print.',
    params: [
      { id: 'rx', label: 'Red across', type: 'range', min: -150, max: 150, step: 1, def: -12, unit: 'px' },
      { id: 'ry', label: 'Red down', type: 'range', min: -150, max: 150, step: 1, def: 0, unit: 'px' },
      { id: 'gx', label: 'Green across', type: 'range', min: -150, max: 150, step: 1, def: 0, unit: 'px' },
      { id: 'gy', label: 'Green down', type: 'range', min: -150, max: 150, step: 1, def: 0, unit: 'px' },
      { id: 'bx', label: 'Blue across', type: 'range', min: -150, max: 150, step: 1, def: 12, unit: 'px' },
      { id: 'by', label: 'Blue down', type: 'range', min: -150, max: 150, step: 1, def: 0, unit: 'px' },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), out = buf.slice(), bpp = L.bpp, rb = r.w * bpp, cb = L.cb, P = colorIdx(L);
      const off = [[p.rx, p.ry], [p.gx, p.gy], [p.bx, p.by]];
      for (let c = 0; c < 3; c++) {
        const [dx, dy] = off[c].map(Math.round);
        if (!dx && !dy) continue;
        for (let j = 0; j < r.h; j++) {
          const sj = clamp(j - dy, 0, r.h - 1);
          for (let i = 0; i < r.w; i++) {
            const si = clamp(i - dx, 0, r.w - 1);
            for (let k = 0; k < cb; k++) out[j * rb + i * bpp + P[c] * cb + k] = buf[sj * rb + si * bpp + P[c] * cb + k];
          }
        }
      }
      writeRect(tx, L, r, out);
    },
  };

  const PERMS = { RGB: [0, 1, 2], RBG: [0, 2, 1], GRB: [1, 0, 2], GBR: [1, 2, 0], BRG: [2, 0, 1], BGR: [2, 1, 0] };
  OPS.channels = {
    title: 'Swap & invert colours', group: 'Colour', needs: 'rect', available: colorOnly, defaultAll: true,
    blurb: 'Re-wire the colour channels, and invert any of them.',
    params: [
      { id: 'perm', label: 'Wiring', type: 'select', def: 'GBR', options: Object.keys(PERMS).map((k) => [k, k === 'RGB' ? 'RGB (unchanged)' : k]), help: 'GBR means red shows what was green, green shows blue, blue shows red.' },
      { id: 'invR', label: 'Invert red', type: 'checkbox', def: false },
      { id: 'invG', label: 'Invert green', type: 'checkbox', def: false },
      { id: 'invB', label: 'Invert blue', type: 'checkbox', def: false },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r);
      permuteChannels(buf, L, PERMS[p.perm] || PERMS.RGB, [p.invR, p.invG, p.invB]);
      writeRect(tx, L, r, buf);
    },
  };

  OPS.indexShift = {
    title: 'Shift palette', group: 'Colour', needs: 'rect', available: indexedOnly, defaultAll: true,
    blurb: 'Palette images store a colour number per pixel. Adding to every number re-colours the picture in jumps.',
    params: [{ id: 'offset', label: 'Shift by', type: 'range', min: -64, max: 64, step: 1, def: 5, help: 'Wraps around the end of the palette.' }],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), n = L.nColors || 256;
      for (let i = 0; i < buf.length; i++) buf[i] = (((buf[i] + Math.round(p.offset)) % n) + n) % n;
      writeRect(tx, L, r, buf);
    },
  };

  OPS.sort = {
    title: 'Pixel sort', group: 'Colour', needs: 'rect', available: rasterOnly, defaultAll: true,
    blurb: 'Sort pixels by brightness along rows or columns. Only pixels between the two thresholds move.',
    params: [
      { id: 'dir', label: 'Direction', type: 'select', def: 'h', options: [['h', 'Along rows'], ['v', 'Down columns']] },
      { id: 'lo', label: 'From brightness', type: 'range', min: 0, max: 255, step: 1, def: 60 },
      { id: 'hi', label: 'To brightness', type: 'range', min: 0, max: 255, step: 1, def: 200 },
      { id: 'desc', label: 'Brightest first', type: 'checkbox', def: false },
    ],
    run({ tx, doc, L, sel, p }) {
      const r = normSel(L, sel, true); if (!r) return;
      const buf = readRect(doc, L, r), out = buf.slice(), bpp = L.bpp, rb = r.w * bpp;
      const horiz = p.dir === 'h', lines = horiz ? r.h : r.w, span = horiz ? r.w : r.h;
      const at = (line, k) => (horiz ? line * rb + k * bpp : k * rb + line * bpp);
      const keys = new Float32Array(span);
      for (let line = 0; line < lines; line++) {
        for (let k = 0; k < span; k++) keys[k] = lum(buf, at(line, k), L);
        let k = 0;
        while (k < span) {
          if (keys[k] < p.lo || keys[k] > p.hi) { k++; continue; }
          let e = k; while (e < span && keys[e] >= p.lo && keys[e] <= p.hi) e++;
          if (e - k > 1) {
            const idx = Array.from({ length: e - k }, (_, i) => k + i);
            idx.sort((a, b) => (p.desc ? keys[b] - keys[a] : keys[a] - keys[b]));
            for (let i = 0; i < idx.length; i++) { const d = at(line, k + i), s = at(line, idx[i]); for (let b = 0; b < bpp; b++) out[d + b] = buf[s + b]; }
          }
          k = e;
        }
      }
      writeRect(tx, L, r, out);
    },
  };

  OPS.levels = {
    title: 'Crush values', group: 'Colour', needs: 'rect', available: () => null, defaultAll: true,
    blurb: 'Find bytes in a value range and replace them (the hex editor “replace FF with 00”, but with a range).',
    params: [
      { id: 'mode', label: 'Do this', type: 'select', def: 'replace', options: [['replace', 'Replace the range with one value'], ['posterize', 'Posterize'], ['invert', 'Invert values in the range'], ['threshold', 'Threshold (black/white split)']] },
      { id: 'lo', label: 'Range from', type: 'range', min: 0, max: 255, step: 1, def: 240 },
      { id: 'hi', label: 'Range to', type: 'range', min: 0, max: 255, step: 1, def: 255 },
      { id: 'to', label: 'Replace with', type: 'range', min: 0, max: 255, step: 1, def: 0 },
      { id: 'levels', label: 'Levels (posterize)', type: 'range', min: 2, max: 16, step: 1, def: 4 },
    ],
    run({ tx, doc, L, sel, range, p }) {
      const apply = (buf) => {
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          if (p.mode === 'posterize') { const st = 255 / (p.levels - 1); buf[i] = Math.round(Math.round(v / st) * st); continue; }
          if (p.mode === 'threshold') { buf[i] = v >= p.lo ? 255 : 0; continue; }
          if (v < p.lo || v > p.hi) continue;
          buf[i] = p.mode === 'invert' ? p.lo + p.hi - v : p.to;
        }
      };
      if (isRaster(doc)) { const r = normSel(L, sel, true); const buf = readRect(doc, L, r); apply(buf); writeRect(tx, L, r, buf); }
      else { const buf = doc.read(range.a, range.b - range.a); apply(buf); tx.write(range.a, buf); }
    },
  };

  OPS.wrongWidth = {
    title: 'Wrong width', group: 'Move', needs: 'none',
    blurb: 'Re-read the same data as if the picture were a few pixels wider or narrower. Rows stop lining up and the image shears into diagonals. The header is rewritten so the file stays valid.',
    available(doc) {
      if (!doc.h.setWidth) return 'This file type has no width setting to change.';
      if (doc.format === 'tiff' && doc.meta.nStrips !== 1) return 'This TIFF has several strips. Use Convert → TIFF first.';
      return null;
    },
    params: [
      { id: 'width', label: 'New width', type: 'range', min: (d) => Math.max(8, d.layout.width - 400), max: (d) => d.layout.width + 400, step: 1, def: (d) => d.layout.width + 3, unit: 'px', help: 'Try ±1 to ±10 for a gentle slant, larger for heavy tearing. For JPEG, use steps of 16 for a clean shear.' },
    ],
    run({ tx, doc, p }) {
      const w = clamp(Math.round(p.width), 1, 65535);
      if (w === doc.layout.width) return;
      doc.h.setWidth(tx, doc, w);
    },
  };

  OPS.pngFilter = {
    title: 'PNG row filters', group: 'Destroy', needs: 'band', available: only('png'), defaultAll: true,
    blurb: 'PNG stores each row with a filter type. Lying about the type makes viewers decode the row wrongly, which smears the colour downward from that row.',
    params: [
      { id: 'type', label: 'Announce rows as', type: 'select', def: 'rand', options: [['0', 'None'], ['1', 'Sub (smears right)'], ['2', 'Up (smears down)'], ['3', 'Average'], ['4', 'Paeth'], ['rand', 'Random per row']] },
      { id: 'chance', label: 'Share of rows', type: 'range', min: 1, max: 100, step: 1, def: 30, unit: '%' },
      seedParam,
    ],
    run({ tx, doc, L, sel, p, rng }) {
      const r = normSel(L, sel, true); if (!r) return;
      const pick = (y) => { if (rng() * 100 >= p.chance) return doc.meta.trueTypes[y]; return p.type === 'rand' ? rng.int(5) : +p.type; };
      doc.h.setFilters(tx, doc, r.y, r.y + r.h, pick);
    },
  };

  // =============================================================================================
  // COMPRESSED-FILE TOOLS (JPEG) — positions are approximate: higher on the picture = earlier in the data
  // =============================================================================================
  OPS.tweak = {
    title: 'Tweak bytes', group: 'Destroy', needs: 'band', available: streamOnly, defaultAll: true,
    blurb: 'Change a few bytes in the compressed data. In a JPEG one change tints or shifts everything after it, so the position matters: higher up = bigger effect.',
    params: [
      { id: 'count', label: 'How many bytes', type: 'range', min: 1, max: 500, step: 1, def: 4 },
      { id: 'mode', label: 'Change them by', type: 'select', def: 'nudge', options: [['nudge', 'A small amount (gentle)'], ['random', 'To random values (harsh)'], ['bit', 'Flip one bit']] },
      seedParam,
    ],
    run({ tx, doc, range, p, rng }) {
      for (let i = 0; i < p.count; i++) {
        const l = range.a + rng.int(range.b - range.a), v = doc.read(l, 1)[0];
        const nv = p.mode === 'nudge' ? clamp(v + rng.range(-12, 12), 0, 255) : p.mode === 'bit' ? v ^ (1 << rng.int(8)) : rng.int(256);
        tx.write(l, Uint8Array.of(nv));
      }
    },
  };

  OPS.copyChunk = {
    title: 'Copy a chunk', group: 'Move', needs: 'band', available: streamOnly,
    blurb: 'Copy the selected stretch of data over another place. You get blocky smears with a compression look.',
    params: [
      { id: 'dest', label: 'Paste at', type: 'range', min: 0, max: 100, step: 0.1, def: 60, unit: '% down', help: 'Position in the data (approximately down the picture).' },
      { id: 'repeat', label: 'Repeat', type: 'range', min: 1, max: 30, step: 1, def: 1 },
      { id: 'max', label: 'Maximum chunk', type: 'range', min: 100, max: 200000, step: 100, def: 20000, unit: 'bytes' },
    ],
    run({ tx, doc, range, p }) {
      const len = Math.min(range.b - range.a, p.max), src = doc.read(range.a, len);
      let at = Math.floor((p.dest / 100) * doc.length);
      for (let n = 0; n < p.repeat; n++) { tx.write(at, src); at += len; }
    },
  };

  OPS.scatterChunks = {
    title: 'Scatter chunks', group: 'Destroy', needs: 'band', available: streamOnly, defaultAll: true,
    blurb: 'Copy many small chunks of data to random places.',
    params: [
      { id: 'pieces', label: 'Pieces', type: 'range', min: 1, max: 300, step: 1, def: 12 },
      { id: 'max', label: 'Longest piece', type: 'range', min: 4, max: 20000, step: 4, def: 400, unit: 'bytes' },
      seedParam,
    ],
    run({ tx, doc, range, p, rng }) {
      for (let i = 0; i < p.pieces; i++) {
        const len = rng.range(4, p.max), a = range.a + rng.int(Math.max(1, range.b - range.a - len)), dst = range.a + rng.int(Math.max(1, range.b - range.a - len));
        tx.write(dst, doc.read(a, len));
      }
    },
  };

  OPS.cut = {
    title: 'Cut or insert bytes', group: 'Move', needs: 'band', available: streamOnly,
    blurb: 'Delete bytes (everything after slides back) or insert copies. The file keeps its size: the end is padded or trimmed so it can never become unreadable.',
    params: [{ id: 'n', label: 'Bytes', type: 'range', min: -3000, max: 3000, step: 1, def: -40, help: 'Negative = delete, positive = insert.' }],
    run({ tx, doc, range, p }) {
      const a = range.a, n = Math.round(p.n), tail = doc.read(a, doc.length - a);
      if (n < 0) { const k = -n; const out = new Uint8Array(tail.length); out.set(tail.subarray(Math.min(k, tail.length))); tx.write(a, out); }
      else if (n > 0) { const out = new Uint8Array(tail.length); out.set(tail.subarray(0, Math.min(n, tail.length)), 0); out.set(tail.subarray(0, tail.length - Math.min(n, tail.length)), Math.min(n, tail.length)); tx.write(a, out); }
    },
  };

  OPS.quant = {
    title: 'JPEG detail tables', group: 'Colour', needs: 'none', available: only('jpeg'),
    blurb: 'Rewrite the table that decides how coarsely detail is stored. Big values give harsh blocks and crushed colour.',
    params: [
      { id: 'mult', label: 'Scale', type: 'range', min: 0.2, max: 12, step: 0.1, def: 4, unit: '×' },
      { id: 'rand', label: 'Randomness', type: 'range', min: 0, max: 60, step: 1, def: 0 },
      { id: 'flat', label: 'Make every value equal', type: 'checkbox', def: false },
      seedParam,
    ],
    run({ tx, doc, p, rng }) {
      for (const t of doc.meta.dqts) {
        const cur = doc.buf.slice(t.off, t.off + t.n), nxt = new Uint8Array(t.n);
        for (let i = 0; i < t.n; i++) nxt[i] = clamp(Math.round((p.flat ? 8 : cur[i]) * p.mult + (p.rand ? rng.range(-p.rand, p.rand) : 0)), 1, 255);
        tx.raw(t.off, nxt);
      }
      tx.full = true;
    },
  };

  DB.opHelpers = { rowStart, normSel, readRect, writeRect, colorIdx, hasColor, lum, isRaster, streamRange, seedParam, parseColor, pixelBytes, permuteChannels, rasterOnly, colorOnly, only };
  DB.OPS = OPS;

  // =============================================================================================
  // Running a tool
  // =============================================================================================
  const resolve = (v, doc, sel) => (typeof v === 'function' ? v(doc, sel) : v);
  DB.defaultParams = function (op, doc, sel) {
    const p = {};
    for (const q of op.params) p[q.id] = resolve(q.def, doc, sel);
    return p;
  };
  DB.paramBounds = (q, doc) => ({ min: resolve(q.min, doc), max: resolve(q.max, doc) });

  DB.toolsFor = function (doc) {
    return Object.entries(OPS).map(([id, op]) => ({ id, op, why: op.available ? op.available(doc) : null }));
  };

  // Apply a tool inside `tx`. Returns nothing. Selection is in display pixels.
  DB.runOpIn = function (tx, doc, id, sel, params) {
    const op = OPS[id];
    const p = Object.assign(DB.defaultParams(op, doc, sel), params || {});
    const ctx = { tx, doc, L: doc.layout, sel, p, rng: DB.rng(p.seed || 1) };
    if (!isRaster(doc)) ctx.range = sel && sel.range ? sel.range : streamRange(doc, sel);
    op.run(ctx);
    // Fine control: every tool can be made gentler after the fact
    if ((p.strength != null && p.strength < 100) || (p.coverage != null && p.coverage < 100)) tx.fade(p.strength, p.coverage, (p.seed || 1) + 77);
  };
  DB.runOp = function (doc, id, sel, params) {
    const tx = doc.begin();
    DB.runOpIn(tx, doc, id, sel, params);
    return tx.finish();
  };

  // =============================================================================================
  // One-click recipes
  // =============================================================================================
  const R = {};
  const rndRect = (rng, L, minH, maxH, fullWidth) => {
    const h = rng.range(minH, Math.max(minH, maxH)), y = rng.int(Math.max(1, L.height - h));
    if (fullWidth) return { x: 0, y, w: L.width, h };
    const w = rng.range(Math.round(L.width * 0.2), Math.round(L.width * 0.9)), x = rng.int(Math.max(1, L.width - w));
    return { x, y, w, h };
  };
  R.stutter = { title: 'Stutter', blurb: 'A few bands repeat down the picture.', raster: true, build(doc, rng) {
    const L = doc.layout, steps = [];
    for (let i = 0; i < 3; i++) {
      const s = rndRect(rng, L, Math.round(L.height * 0.01), Math.round(L.height * 0.05), true);
      steps.push({ op: 'stamp', sel: s, params: { dest: { x: 0, y: rng.int(L.height - s.h) }, repeat: rng.range(2, 8), stepY: s.h } });
    }
    return steps;
  } };
  R.ledges = { title: 'Torn ledges', blurb: 'Rows slide sideways in stepped blocks.', raster: true, build(doc, rng) {
    const L = doc.layout, steps = [];
    for (let i = 0; i < 6; i++) steps.push({ op: 'slide', sel: rndRect(rng, L, Math.round(L.height * 0.01), Math.round(L.height * 0.06), true), params: { shift: rng.range(-Math.round(L.width * 0.3), Math.round(L.width * 0.3)), byteOff: '0' } });
    return steps;
  } };
  R.acid = { title: 'Acid colours', blurb: 'Colour channels rotate in bands.', raster: true, available: colorOnly, build(doc, rng) {
    const L = doc.layout, steps = [];
    for (let i = 0; i < 4; i++) { const s = rndRect(rng, L, Math.round(L.height * 0.05), Math.round(L.height * 0.3), true); steps.push({ op: 'stamp', sel: s, params: { dest: { x: 0, y: s.y }, chRot: String(rng.range(1, 2)) } }); }
    return steps;
  } };
  R.scanner = { title: 'Scanner failure', blurb: 'Smears, a slant and a split.', raster: true, build(doc, rng) {
    const L = doc.layout, steps = [{ op: 'shear', sel: rndRect(rng, L, Math.round(L.height * 0.2), Math.round(L.height * 0.5), true), params: { perRow: rng.range(-30, 30) / 10, wave: rng.range(0, 40) } }];
    steps.push({ op: 'smear', sel: rndRect(rng, L, Math.round(L.height * 0.05), Math.round(L.height * 0.15), false), params: { dir: 'right', jitter: 70, seed: rng.int(9999) } });
    if (hasColor(L)) steps.push({ op: 'rgbSplit', sel: null, params: { rx: -rng.range(4, 20), bx: rng.range(4, 20) } });
    return steps;
  } };
  R.shattered = { title: 'Shattered', blurb: 'Random chunks swap places.', raster: true, build(doc, rng) { return [{ op: 'shatter', sel: null, params: { pieces: rng.range(60, 240), seed: rng.int(9999), colour: true } }]; } };
  R.melt = { title: 'Melt', blurb: 'Pixel-sorted drips in the midtones.', raster: true, build(doc, rng) { return [{ op: 'sort', sel: rndRect(rng, doc.layout, Math.round(doc.layout.height * 0.3), Math.round(doc.layout.height * 0.7), true), params: { dir: rng.int(2) ? 'h' : 'v', lo: rng.range(30, 90), hi: rng.range(150, 230) } }]; } };
  R.bitrot = { title: 'Bit rot', blurb: 'A handful of damaged bytes in the data.', stream: true, build(doc, rng) { return [{ op: 'tweak', sel: { y: 0, h: doc.layout.height * rng.range(40, 100) / 100 }, params: { count: rng.range(2, 10), mode: 'nudge', seed: rng.int(9999) } }]; } };
  R.collapse = { title: 'Collapse', blurb: 'Chunks are copied over each other.', stream: true, build(doc, rng) { return [{ op: 'scatterChunks', sel: null, params: { pieces: rng.range(6, 30), max: rng.range(200, 3000), seed: rng.int(9999) } }]; } };
  DB.RECIPES = R;

  DB.recipesFor = (doc) => Object.entries(R).filter(([, r]) => (isRaster(doc) ? r.raster : r.stream) && (!r.available || !r.available(doc))).map(([id, r]) => ({ id, title: r.title, blurb: r.blurb }));
  DB.runRecipe = function (doc, id, seed) {
    const rng = DB.rng(seed || 1), tx = doc.begin();
    for (const s of R[id].build(doc, rng)) DB.runOpIn(tx, doc, s.op, s.sel, s.params);
    return tx.finish();
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
