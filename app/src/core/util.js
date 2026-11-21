(function () {
  const DB = (globalThis.DB = globalThis.DB || {});

  // Seeded RNG so every glitch is repeatable ("seed 4821" always gives the same result)
  DB.rng = function (seed) {
    let a = (seed >>> 0) || 1;
    const next = function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    next.int = (n) => Math.floor(next() * n);              // 0..n-1
    next.range = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)); // lo..hi inclusive
    return next;
  };

  DB.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  // CRC32 (PNG chunks)
  let CRC_TABLE = null;
  DB.crc32 = function (bytes, start, end) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = start || 0; i < (end === undefined ? bytes.length : end); i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  DB.u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
  DB.u32 = (b, o, le) =>
    le
      ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
      : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  DB.i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  DB.put16 = (b, o, v, le) => {
    if (le) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; } else { b[o] = (v >> 8) & 255; b[o + 1] = v & 255; }
  };
  DB.put32 = (b, o, v, le) => {
    if (le) { b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255; }
    else { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  };

  DB.hex = (n, pad) => n.toString(16).toUpperCase().padStart(pad || 2, '0');

  // Find the runs where two equal-length byte arrays differ. Gaps shorter than `gap` are merged.
  // Returns [{off, a: Uint8Array(old), b: Uint8Array(new)}]. Keeps undo memory proportional to what really changed.
  DB.diffRuns = function (oldB, newB, gap) {
    gap = gap || 24;
    const runs = [];
    const n = oldB.length;
    let i = 0;
    while (i < n) {
      if (oldB[i] === newB[i]) { i++; continue; }
      let start = i, last = i;
      i++;
      while (i < n && i - last <= gap) { if (oldB[i] !== newB[i]) last = i; i++; }
      const end = last + 1;
      runs.push({ off: start, a: oldB.slice(start, end), b: newB.slice(start, end) });
      i = end;
    }
    return runs;
  };

  DB.fmtBytes = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
