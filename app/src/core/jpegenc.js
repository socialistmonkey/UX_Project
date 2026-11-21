(function () {
  const DB = (globalThis.DB = globalThis.DB || {});

  // A small baseline JPEG encoder. Its one special trick: it can write restart markers, which cut the
  // picture into independent blocks so the "Shuffle JPEG blocks" tool has something to shuffle.
  // Huffman tables are deliberately simple (fixed-length codes). Files are larger than a camera's, but always valid.

  const ZZ = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
  const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
  const COS = []; for (let u = 0; u < 8; u++) { COS.push([]); for (let x = 0; x < 8; x++) COS[u].push(Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1) / 2); }

  // symbols of the AC table: EOB, ZRL, and every run/size pair
  const AC_SYMS = [0x00, 0xf0]; for (let r = 0; r < 16; r++) for (let s = 1; s <= 10; s++) AC_SYMS.push((r << 4) | s);
  const AC_CODE = new Map(); AC_SYMS.forEach((s, i) => AC_CODE.set(s, i));

  function scaleTable(base, q) {
    const sc = q < 50 ? 5000 / q : 200 - 2 * q;
    return base.map((v) => DB.clamp(Math.floor((v * sc + 50) / 100), 1, 255));
  }

  DB.encodeJPEG = function (rgba, w, h, opt) {
    opt = opt || {};
    const q = DB.clamp(Math.round(opt.quality || 85), 1, 100), restart = Math.max(0, Math.round(opt.restart || 0)), sub = opt.subsample ? 2 : 1;
    const ql = scaleTable(QL, q), qc = scaleTable(QC, q);
    const mw = 8 * sub, mcusX = Math.ceil(w / mw), mcusY = Math.ceil(h / mw), W = mcusX * mw, Hh = mcusY * mw;
    // planes, padded by repeating the edge
    const Y = new Float32Array(W * Hh), Cb = new Float32Array(W * Hh), Cr = new Float32Array(W * Hh);
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      const i = (Math.min(y, h - 1) * w + Math.min(x, w - 1)) * 4, a = rgba[i + 3] / 255, inv = 255 * (1 - a);
      const r = rgba[i] * a + inv, g = rgba[i + 1] * a + inv, b = rgba[i + 2] * a + inv, o = y * W + x;
      Y[o] = 0.299 * r + 0.587 * g + 0.114 * b; Cb[o] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128; Cr[o] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
    const down = (P) => {
      if (sub === 1) return { p: P, w: W };
      const cw = W / 2, ch = Hh / 2, o = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) o[y * cw + x] = (P[2 * y * W + 2 * x] + P[2 * y * W + 2 * x + 1] + P[(2 * y + 1) * W + 2 * x] + P[(2 * y + 1) * W + 2 * x + 1]) / 4;
      return { p: o, w: cw };
    };
    const cb = down(Cb), cr = down(Cr);

    // output
    let out = new Uint8Array(1 << 16), n = 0;
    const put = (b) => { if (n === out.length) { const o2 = new Uint8Array(out.length * 2); o2.set(out); out = o2; } out[n++] = b; };
    const put16 = (v) => { put(v >> 8); put(v & 255); };
    const marker = (m, data) => { put(0xff); put(m); put16(data.length + 2); for (const b of data) put(b); };

    put(0xff); put(0xd8);
    marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    marker(0xdb, [0, ...ZZ.map((z) => ql[z])]);
    marker(0xdb, [1, ...ZZ.map((z) => qc[z])]);
    marker(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, (sub << 4) | sub, 0, 2, 0x11, 1, 3, 0x11, 1]);
    const dcBits = new Array(16).fill(0); dcBits[3] = 12;           // twelve 4-bit codes
    marker(0xc4, [0x00, ...dcBits, ...Array.from({ length: 12 }, (_, i) => i)]);
    const acBits = new Array(16).fill(0); acBits[7] = AC_SYMS.length; // all 8-bit codes
    marker(0xc4, [0x10, ...acBits, ...AC_SYMS]);
    if (restart) marker(0xdd, [restart >> 8, restart & 255]);
    marker(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);

    let bitBuf = 0, bits = 0;
    const emit = (code, len) => {
      bitBuf = (bitBuf << len) | code; bits += len;
      while (bits >= 8) { const b = (bitBuf >> (bits - 8)) & 255; put(b); if (b === 0xff) put(0); bits -= 8; }
      bitBuf &= (1 << bits) - 1;
    };
    const flush = () => { if (bits) emit((1 << (8 - bits)) - 1, 8 - bits); bitBuf = 0; bits = 0; };
    const cat = (v) => { v = Math.abs(v); let s = 0; while (v) { s++; v >>= 1; } return s; };
    const putVal = (v, s) => emit(v < 0 ? (v + (1 << s) - 1) & ((1 << s) - 1) : v, s);

    const blk = new Float32Array(64), tmp = new Float32Array(64), co = new Int32Array(64);
    const block = (P, pw, bx, by, qt, pred) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = P[(by + y) * pw + bx + x] - 128;
      for (let y = 0; y < 8; y++) for (let u = 0; u < 8; u++) { let s = 0; for (let x = 0; x < 8; x++) s += blk[y * 8 + x] * COS[u][x]; tmp[y * 8 + u] = s; }
      for (let u = 0; u < 8; u++) for (let v = 0; v < 8; v++) { let s = 0; for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v][y]; co[v * 8 + u] = Math.round(s / qt[v * 8 + u]); }
      const dc = co[0], diff = dc - pred.v; pred.v = dc;
      const s = cat(diff); emit(s, 4); if (s) putVal(diff, s);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = co[ZZ[k]];
        if (!v) { run++; continue; }
        while (run > 15) { emit(AC_CODE.get(0xf0), 8); run -= 16; }
        const sz = cat(v); emit(AC_CODE.get((run << 4) | sz), 8); putVal(v, sz); run = 0;
      }
      if (run) emit(AC_CODE.get(0x00), 8);
    };

    const pY = { v: 0 }, pCb = { v: 0 }, pCr = { v: 0 };
    let mcu = 0, rn = 0;
    for (let my = 0; my < mcusY; my++) for (let mx = 0; mx < mcusX; mx++) {
      if (restart && mcu > 0 && mcu % restart === 0) { flush(); put(0xff); put(0xd0 + (rn++ & 7)); pY.v = pCb.v = pCr.v = 0; }
      for (let j = 0; j < sub; j++) for (let i = 0; i < sub; i++) block(Y, W, mx * mw + i * 8, my * mw + j * 8, ql, pY);
      block(cb.p, cb.w, mx * 8, my * 8, qc, pCb); block(cr.p, cr.w, mx * 8, my * 8, qc, pCr);
      mcu++;
    }
    flush(); put(0xff); put(0xd9);
    return out.slice(0, n);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
