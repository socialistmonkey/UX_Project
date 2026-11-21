(function () {
  const DB = (globalThis.DB = globalThis.DB || {});

  // ---------------------------------------------------------------------------------------------
  // Shared raster renderer: logical bytes -> RGBA. Used for BMP, TIFF and PNG (JPEG/GIF are decoded
  // by the browser instead).
  //
  // layout = { kind:'raster', width, height, stride, bpp, cb, nch, flipY, ri, gi, bi, ai,
  //            indexed, palette, invert, hb }
  //   bpp  bytes per pixel      cb  bytes per channel (1 or 2)     nch  channels per pixel
  //   ri/gi/bi/ai  index of the red/green/blue/alpha channel inside a pixel (ai = -1: none)
  //   hb   index of the most significant byte inside a 16 bit sample
  // ---------------------------------------------------------------------------------------------
  DB.renderRaster = function (L, src, out, r0, r1) {
    const W = L.width, H = L.height;
    r0 = Math.max(0, r0 | 0); r1 = Math.min(H, r1 | 0);
    const { bpp, cb, ri, gi, bi, ai, stride } = L;
    const hb = cb === 2 ? L.hb : 0;
    const roff = ri * cb + hb, goff = gi * cb + hb, boff = bi * cb + hb, aoff = ai >= 0 ? ai * cb + hb : -1;
    for (let y = r0; y < r1; y++) {
      const sr = L.flipY ? H - 1 - y : y;
      let s = sr * stride;
      let o = y * W * 4;
      if (s + stride > src.length && s + W * bpp > src.length) { // not enough data: leave transparent black
        for (let x = 0; x < W; x++) { out[o++] = 0; out[o++] = 0; out[o++] = 0; out[o++] = 255; }
        continue;
      }
      if (L.indexed) {
        const pal = L.palette;
        for (let x = 0; x < W; x++, s += bpp) {
          const i3 = src[s] * 3;
          out[o++] = pal[i3]; out[o++] = pal[i3 + 1]; out[o++] = pal[i3 + 2]; out[o++] = src[s] === L.trans ? 0 : 255;
        }
      } else if (L.invert) {
        for (let x = 0; x < W; x++, s += bpp) {
          const v = 255 - src[s + roff];
          out[o++] = v; out[o++] = v; out[o++] = v; out[o++] = 255;
        }
      } else if (aoff < 0) {
        for (let x = 0; x < W; x++, s += bpp) {
          out[o++] = src[s + roff]; out[o++] = src[s + goff]; out[o++] = src[s + boff]; out[o++] = 255;
        }
      } else {
        for (let x = 0; x < W; x++, s += bpp) {
          out[o++] = src[s + roff]; out[o++] = src[s + goff]; out[o++] = src[s + boff]; out[o++] = src[s + aoff];
        }
      }
    }
  };

  // Palette images: an index past the end of the palette makes some decoders reject the file, so wrap it back in.
  DB.indexSanitizer = function (tx, doc, touched) {
    const L = doc.layout, n = L.nColors;
    if (!L.indexed || !n || n >= 256) return;
    for (const [a, b] of touched) {
      const buf = doc.read(a, b - a); let changed = false;
      for (let i = 0; i < buf.length; i++) if (buf[i] >= n) { buf[i] %= n; changed = true; }
      if (changed) tx.write(a, buf);
    }
  };

  // ---------------------------------------------------------------------------------------------
  // Builders: turn RGBA pixels into a corruptible file. Used by "Convert to BMP / TIFF" so any image
  // (WebP, JPEG, a screenshot ...) can be turned into something the safe-zone tools understand.
  // ---------------------------------------------------------------------------------------------
  DB.buildBMP = function (rgba, w, h) {
    const stride = ((w * 24 + 31) >>> 5) << 2;
    const size = 54 + stride * h;
    const f = new Uint8Array(size);
    f[0] = 0x42; f[1] = 0x4d;
    DB.put32(f, 2, size, true); DB.put32(f, 10, 54, true);
    DB.put32(f, 14, 40, true); DB.put32(f, 18, w, true); DB.put32(f, 22, h, true);
    DB.put16(f, 26, 1, true); DB.put16(f, 28, 24, true); DB.put32(f, 34, stride * h, true);
    DB.put32(f, 38, 2835, true); DB.put32(f, 42, 2835, true);
    for (let y = 0; y < h; y++) {
      let o = 54 + (h - 1 - y) * stride;
      let s = y * w * 4;
      for (let x = 0; x < w; x++, s += 4) {
        const a = rgba[s + 3] / 255, inv = 255 * (1 - a); // composite over white
        f[o++] = rgba[s + 2] * a + inv; f[o++] = rgba[s + 1] * a + inv; f[o++] = rgba[s] * a + inv;
      }
    }
    return f;
  };

  DB.buildTIFF = function (rgba, w, h) {
    const nEnt = 10, ifdOff = 8, ifdLen = 2 + nEnt * 12 + 4;
    const bpsOff = ifdOff + ifdLen, dataOff = bpsOff + 8, dataLen = w * h * 3;
    const f = new Uint8Array(dataOff + dataLen);
    f[0] = 0x49; f[1] = 0x49; DB.put16(f, 2, 42, true); DB.put32(f, 4, ifdOff, true);
    DB.put16(f, ifdOff, nEnt, true);
    let p = ifdOff + 2;
    const ent = (tag, type, count, val) => {
      DB.put16(f, p, tag, true); DB.put16(f, p + 2, type, true); DB.put32(f, p + 4, count, true);
      if (type === 3 && count === 1) DB.put16(f, p + 8, val, true); else DB.put32(f, p + 8, val, true);
      p += 12;
    };
    ent(256, 4, 1, w); ent(257, 4, 1, h); ent(258, 3, 3, bpsOff); ent(259, 3, 1, 1); ent(262, 3, 1, 2);
    ent(273, 4, 1, dataOff); ent(277, 3, 1, 3); ent(278, 4, 1, h); ent(279, 4, 1, dataLen); ent(284, 3, 1, 1);
    DB.put32(f, p, 0, true);
    DB.put16(f, bpsOff, 8, true); DB.put16(f, bpsOff + 2, 8, true); DB.put16(f, bpsOff + 4, 8, true);
    let o = dataOff;
    for (let i = 0, s = 0; i < w * h; i++, s += 4) {
      const a = rgba[s + 3] / 255, inv = 255 * (1 - a);
      f[o++] = rgba[s] * a + inv; f[o++] = rgba[s + 1] * a + inv; f[o++] = rgba[s + 2] * a + inv;
    }
    return f;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
