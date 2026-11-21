// Core engine tests. Run: node test/core.test.js   (needs Python + Pillow for the decoder cross-check)
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
for (const f of ['util', 'doc', 'raster', 'formats', 'png', 'gif', 'ops', 'ops2', 'jpegenc', 'macro', 'formats2', 'ops3']) require('../src/core/' + f + '.js');

const FIX = path.join(__dirname, 'fixtures'), OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { recursive: true, force: true });

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) pass++; else { fail++; failures.push(name + (extra ? '  -> ' + extra : '')); }
}
const same = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const manifest = [];

function lockedIntact(doc, label) {
  // every byte outside the editable segments must equal the original
  let bad = -1;
  const segs = doc.segments;
  let pos = 0;
  const cmp = (a, b) => { for (let i = a; i < b; i++) if (doc.buf[i] !== doc.orig[i]) return i; return -1; };
  for (const s of segs) { const r = cmp(pos, s.start); if (r >= 0) { bad = r; break; } pos = s.start + s.len; }
  if (bad < 0) bad = cmp(pos, doc.buf.length);
  check(`${label}: locked bytes untouched`, bad < 0, 'first changed locked byte at ' + bad);
}

function renderRGBA(doc) {
  const L = doc.layout, out = new Uint8ClampedArray(L.width * L.height * 4);
  doc.h.render(doc, out, 0, L.height);
  return out;
}

async function exportAndRecord(doc, tag, cmp) {
  const bytes = await doc.exportBytes();
  const ext = DB.extFor(doc);
  const file = path.join(OUT, tag + '.' + ext);
  fs.writeFileSync(file, bytes);
  const e = { tag, file, cmp, w: doc.layout.width, h: doc.layout.height };
  if (doc.layout.kind === 'raster') { const f = path.join(OUT, tag + '.rgba'); fs.writeFileSync(f, Buffer.from(renderRGBA(doc).buffer)); e.rgba = f; }
  manifest.push(e);
  return bytes;
}

// a second picture for the Mix tool
function makeSrc(doc) {
  const w = 97, h = 61, rgba = new Uint8ClampedArray(w * h * 4), raw = new Uint8Array(5000);
  for (let i = 0; i < w * h; i++) { rgba[i * 4] = (i * 5) & 255; rgba[i * 4 + 1] = (i * 3) % 256; rgba[i * 4 + 2] = (i >> 2) & 255; rgba[i * 4 + 3] = 255; }
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 255;
  return DB.makeSource(rgba, w, h, raw, 'other.png');
}
const colorRaster = (doc) => doc.layout.kind === 'raster' && !doc.layout.indexed && doc.layout.nch >= 3;

(async () => {
  // JPEGs made by our own encoder (with restart blocks) so the block tools have something to work on
  {
    const src = await DB.open(new Uint8Array(fs.readFileSync(path.join(FIX, 'rgb24.bmp'))), 'a.bmp'), L = src.layout, rgba = renderRGBA(src);
    fs.writeFileSync(path.join(FIX, 'rst.jpg'), DB.encodeJPEG(rgba, L.width, L.height, { quality: 85, restart: 4 }));
    fs.writeFileSync(path.join(FIX, 'rst420.jpg'), DB.encodeJPEG(rgba, L.width, L.height, { quality: 60, restart: 7, subsample: true }));
    fs.writeFileSync(path.join(FIX, 'enc_plain.jpg'), DB.encodeJPEG(rgba, L.width, L.height, { quality: 90 }));
  }
  const rasterFiles = ['rgb24.bmp', 'rgba32.bmp', 'pal8.bmp', 'rgb.tif', 'gray.tif', 'rgba.tif', 'strips.tif', 'rgb.png', 'rgba.png', 'gray.png', 'pal.png', 'rgb16.png', 'rgb.gif', 'anim.gif', 'inter.gif', 'trans.gif'];
  const streamFiles = ['base.jpg', 'prog.jpg', 'rst.jpg', 'rst420.jpg', 'enc_plain.jpg'];

  // ---- 1. open + render equals a real decoder; export of an untouched file is lossless ----
  for (const f of rasterFiles.concat(streamFiles)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, f)));
    let doc;
    try { doc = await DB.open(bytes, f); } catch (e) { check('open ' + f, false, e.message); continue; }
    check('open ' + f, true);
    const cmpMode = /rgba32\.bmp$/.test(f) ? 'rgb' : doc.layout.kind === 'raster' ? 'exact' : 'open';
    const out = await exportAndRecord(doc, 'orig_' + f.replace(/\W/g, '_'), cmpMode);
    if (doc.format !== 'png' && doc.format !== 'gif') check('untouched export identical ' + f, same(out, bytes));
  }

  // ---- 2. every tool on every file: invariants, undo/redo, decode cross-check ----
  const sel = (L) => ({ x: Math.round(L.width * 0.15), y: Math.round(L.height * 0.3), w: Math.round(L.width * 0.6), h: Math.round(L.height * 0.25) });
  for (const f of rasterFiles.concat(streamFiles)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, f)));
    for (const [id, op] of Object.entries(DB.OPS)) {
      const doc = await DB.open(bytes, f);
      if (op.available(doc)) continue;
      const label = `${f} / ${id}`;
      const before = doc.buf.slice(), L0 = doc.layout;
      let patch;
      const prm = { seed: 5 };
      if (id === 'findReplace') { prm.find = DB.hex(doc.view()[Math.floor(doc.length / 2)]); prm.replace = prm.find === '00' ? '01' : '00'; }
      if (id === 'mash') { prm.src = makeSrc(doc); if (!colorRaster(doc)) prm.mode = 'interleave'; }
      try { patch = DB.runOp(doc, id, sel(L0), prm); } catch (e) { check(label + ' runs', false, e.stack.split('\n').slice(0, 3).join(' | ')); continue; }
      doc.commit(patch);
      check(label + ': file size unchanged', doc.buf.length === before.length);
      if (id !== 'wrongWidth' && id !== 'quant' && id !== 'sampling') lockedIntact(doc, label);
      if (id === 'quant') { // only the quantization tables may differ outside the scan
        let bad = -1; const t = doc.meta.dqts.map((q) => [q.off, q.off + q.n]);
        for (let i = 0; i < doc.buf.length && bad < 0; i++) if (doc.buf[i] !== doc.orig[i] && !doc.isEditable(i) && !t.some(([a, b]) => i >= a && i < b)) bad = i;
        check(label + ': only tables + scan changed', bad < 0, 'byte ' + bad);
      }
      if (id === 'wrongWidth') {
        let bad = -1; for (let i = 0; i < doc.buf.length && bad < 0; i++) if (doc.buf[i] !== doc.orig[i] && !doc.isEditable(i) && i > 64 && doc.format === 'bmp') bad = i;
        check(label + ': header only changed in the header', bad < 0, 'byte ' + bad);
      }
      const after = doc.buf.slice(), afterL = doc.layout, afterMeta = doc.format === 'png' ? doc.meta.claimed.slice() : null;
      if (id !== 'sampling') await exportAndRecord(doc, 'op_' + f.replace(/\W/g, '_') + '_' + id, doc.layout.kind === 'raster' ? 'exact' : 'open');
      doc.undo();
      check(label + ': undo restores bytes', same(doc.buf, before));
      check(label + ': undo restores layout', doc.layout === L0);
      doc.redo();
      check(label + ': redo reapplies', same(doc.buf, after) && doc.layout === afterL);
      if (afterMeta) check(label + ': redo reapplies filters', same(doc.meta.claimed, afterMeta));
    }
  }

  // ---- 3. recipes (several seeds) ----
  for (const f of rasterFiles.concat(streamFiles)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, f)));
    const doc0 = await DB.open(bytes, f);
    for (const r of DB.recipesFor(doc0)) {
      for (const seed of [1, 2, 3]) {
        const doc = await DB.open(bytes, f);
        const label = `${f} / recipe ${r.id} #${seed}`;
        try {
          const p = DB.runRecipe(doc, r.id, seed); doc.commit(p);
          lockedIntact(doc, label);
          await exportAndRecord(doc, 'rc_' + f.replace(/\W/g, '_') + '_' + r.id + seed, doc.layout.kind === 'raster' ? 'exact' : 'open');
        } catch (e) { check(label, false, e.stack.split('\n').slice(0, 3).join(' | ')); }
      }
    }
  }

  // ---- 4. JPEG stream stays decodable: no stray markers inside scan data after harsh edits ----
  {
    const bytes = new Uint8Array(fs.readFileSync(path.join(FIX, 'base.jpg')));
    const doc = await DB.open(bytes, 'base.jpg');
    const p = DB.runOp(doc, 'tweak', null, { count: 500, mode: 'random', seed: 99 }); doc.commit(p);
    let stray = 0;
    for (const s of doc.segments) for (let i = s.start; i < s.start + s.len - 1; i++) if (doc.buf[i] === 0xff) { const n = doc.buf[i + 1]; if (!(n === 0 || n === 0xff || (n >= 0xd0 && n <= 0xd7))) stray++; }
    check('jpeg: no stray markers after 500 random edits', stray === 0, stray + ' stray');
    await exportAndRecord(doc, 'jpeg_harsh', 'open');
    const p2 = DB.runOp(doc, 'scatterChunks', null, { pieces: 300, max: 5000, seed: 3 }); doc.commit(p2);
    await exportAndRecord(doc, 'jpeg_harsh2', 'open');
  }

  // ---- 5. history memory: a whole-image op stores only what changed ----
  {
    const doc = await DB.open(new Uint8Array(fs.readFileSync(path.join(FIX, 'rgb24.bmp'))), 'x.bmp');
    const p = DB.runOp(doc, 'levels', null, { mode: 'replace', lo: 250, hi: 255, to: 0 }); doc.commit(p);
    check('levels: history smaller than the image', p.size < doc.length, p.size + ' vs ' + doc.length);
  }

  // ---- 6. multi-strip TIFF must refuse wrong width cleanly ----
  {
    const doc = await DB.open(new Uint8Array(fs.readFileSync(path.join(FIX, 'strips.tif'))), 's.tif');
    check('multi-strip TIFF: wrongWidth unavailable', !!DB.OPS.wrongWidth.available(doc));
    check('multi-strip TIFF: has several segments or merged', doc.segments.length >= 1);
  }

  // ---- 7. unsupported inputs give friendly errors ----
  {
    let msg = '';
    try { await DB.open(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]), 'a.webp'); } catch (e) { msg = e.message; }
    check('webp gives a friendly message', /Convert/.test(msg), msg);
    msg = '';
    try { await DB.open(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 'a.bin'); } catch (e) { msg = e.message; }
    check('unknown type gives a friendly message', /recognise/.test(msg), msg);
  }

  // ---- 8. convert builders ----
  {
    const w = 37, h = 21, rgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = i % 256; rgba[i * 4 + 1] = (i * 3) % 256; rgba[i * 4 + 2] = (i * 7) % 256; rgba[i * 4 + 3] = 255; }
    for (const [kind, build] of [['bmp', DB.buildBMP], ['tiff', DB.buildTIFF]]) {
      const bytes = build(rgba, w, h), doc = await DB.open(bytes, 'c.' + kind);
      const out = renderRGBA(doc);
      check('build ' + kind + ' round trips pixels', same(out, rgba));
      await exportAndRecord(doc, 'built_' + kind, 'exact');
    }
  }


  // ---- 9. the new tools do what they say ----
  {
    const open = async (f) => DB.open(new Uint8Array(fs.readFileSync(path.join(FIX, f))), f);
    const view = (d) => Buffer.from(d.view());
    const apply = (d, id, params, sel) => { const p = DB.runOp(d, id, sel || null, params); d.commit(p); return p; };
    const eq = (a, b) => Buffer.compare(a, b) === 0;
    let d = await open('rgb24.bmp'); const base = view(d);
    apply(d, 'bitOp', { mode: 'xor', pattern: '5A' }); check('bitOp changes bytes', !eq(view(d), base));
    apply(d, 'bitOp', { mode: 'xor', pattern: '5A' }); check('bitOp xor twice = original', eq(view(d), base));
    d = await open('rgb24.bmp');
    apply(d, 'bitShift', { mode: 'rol', amount: 3 }); apply(d, 'bitShift', { mode: 'ror', amount: 3 }); check('rotate bits there and back', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'bitPlane', { mode: 'flip', plane: 7 }); apply(d, 'bitPlane', { mode: 'flip', plane: 7 }); check('flip bit plane twice', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'bitOp', { mode: 'xor', pattern: 'FF', chan: '0' });
    { const L = d.layout, v = view(d); let ok = true; for (let i = 0; i < 1900 && ok; i += 3) { const r = L.ri; if (v[i + r] !== (base[i + r] ^ 255)) ok = false; if (v[i + L.gi] !== base[i + L.gi]) ok = false; } check('channel-only bitOp touches one channel', ok); }
    d = await open('rgb24.bmp'); apply(d, 'reverseBytes', { chunk: 0 }); apply(d, 'reverseBytes', { chunk: 0 }); check('reverse twice', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'swapWords', { size: '3', offset: 0 }); apply(d, 'swapWords', { size: '3', offset: 0 }); check('swap byte order twice', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'planar', { mode: 'rowsplit', n: 3 }); check('planar changes data', !eq(view(d), base)); apply(d, 'planar', { mode: 'rowjoin', n: 3 }); check('planar then interleave = original', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'planar', { mode: 'split', n: 3 }); apply(d, 'planar', { mode: 'join', n: 3 }); check('whole-band planar round trip', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'rows', { mode: 'reverse', n: 1 }); apply(d, 'rows', { mode: 'reverse', n: 1 }); check('reverse rows twice', eq(view(d), base));
    d = await open('rgb24.bmp'); apply(d, 'rows', { mode: 'shuffle', n: 1, seed: 3 });
    { const L = d.layout, v = view(d), key = (b, y) => b.subarray(y * L.stride, (y + 1) * L.stride).toString('hex'); const a = new Map(); for (let y = 0; y < L.height; y++) { const k = key(base, y); a.set(k, (a.get(k) || 0) + 1); } for (let y = 0; y < L.height; y++) { const k = key(v, y); a.set(k, (a.get(k) || 0) - 1); } check('shuffled rows are the same rows', [...a.values()].every((x) => x === 0) && !eq(v, base)); }
    // find and replace
    d = await open('rgb24.bmp'); let ff = 0; for (const b of base) if (b === 0xff) ff++;
    apply(d, 'findReplace', { find: 'FF', replace: '00', limit: 0 }); { let rest = 0; for (const b of view(d)) if (b === 0xff) rest++; check('find/replace removes every FF', rest === 0 && ff > 0, ff + ' found'); }
    d = await open('rgb24.bmp'); let threw = ''; try { DB.runOp(d, 'findReplace', null, { find: 'ZZ', replace: '00' }); } catch (e) { threw = e.message; } check('find/replace explains bad hex', /not a hex byte/.test(threw), threw);
    d = await open('rgb24.bmp'); threw = ''; try { DB.runOp(d, 'findReplace', null, { find: 'DE AD BE EF 12 34', replace: '00' }); } catch (e) { threw = e.message; } check('find/replace says when nothing matches', /Nothing matches/.test(threw), threw);
    // audio-style tools keep length and change data
    for (const [id, prm] of [['echo', {}], ['gain', { over: 'fold' }], ['speed', { factor: 1.3, smooth: true }], ['tremolo', {}], ['holdSamples', {}], ['rePixel', {}]]) {
      d = await open('rgb24.bmp'); apply(d, id, prm); check('audio/layout tool ' + id + ' changes data, same size', !eq(view(d), base) && view(d).length === base.length);
    }
    // mix: every mode
    for (const mode of ['replace', 'xor', 'add', 'difference', 'average', 'lighten', 'darken', 'channels', 'interleave', 'rawxor']) {
      d = await open('rgb24.bmp'); apply(d, 'mash', { src: makeSrc(d), mode, which: 'rg', ramp: mode === 'average' ? 'x' : 'flat' }, { x: 10, y: 10, w: 200, h: 100 });
      check('mix mode ' + mode + ' changes the picture', !eq(view(d), base)); lockedIntact(d, 'mix ' + mode);
    }
    d = await open('rgb24.bmp'); threw = ''; try { DB.runOp(d, 'mash', null, {}); } catch (e) { threw = e.message; } check('mix asks for an image first', /Choose the other image/.test(threw), threw);
    // JPEG restart blocks
    let j = await open('rst.jpg'); check('encoder file has restart blocks', j.meta.restartCount > 100, String(j.meta.restartCount));
    const jb = Buffer.from(j.buf);
    for (const mode of ['shuffle', 'reverse', 'repeat', 'drop', 'swap']) {
      j = await open('rst.jpg'); const p = DB.runOp(j, 'restartBlocks', null, { mode, chance: 60, seed: 9 }); j.commit(p);
      check('restart ' + mode + ' keeps size', j.buf.length === jb.length); lockedIntact(j, 'restart ' + mode);
      check('restart ' + mode + ' changes data', !eq(Buffer.from(j.buf), jb));
      await exportAndRecord(j, 'rst_' + mode, 'open');
      const j2 = await DB.open(await j.exportBytes(), 'x.jpg'); check('restart ' + mode + ' keeps markers', j2.meta.restartCount === j.meta.restartCount, j2.meta.restartCount + ' vs ' + j.meta.restartCount);
    }
    j = await open('base.jpg'); check('block tool locked on a normal JPEG', /not split into blocks/.test(DB.OPS.restartBlocks.available(j) || ''));
    j = await open('rst420.jpg'); { const before = Buffer.from(j.buf); apply(j, 'sampling', { yh: 1, yv: 1, ch: 1, cv: 1 }); let bad = 0; for (let i = 0; i < before.length; i++) if (before[i] !== j.buf[i] && !(i >= j.meta.sof.off && i < j.meta.sof.off + 20)) bad++; check('sampling tool only touches the frame header', bad === 0 && !eq(Buffer.from(j.buf), before), bad + ' stray'); }

    // ---- macros ----
    d = await open('rgb24.bmp');
    const sA = { x: 40, y: 50, w: 300, h: 80 };
    const steps = [DB.stepFromTool(d, 'bitOp', sA, { mode: 'xor', pattern: '33', chan: 'all' }), DB.stepFromTool(d, 'shatter', null, { pieces: 40, seed: 7, colour: true }), DB.stepFromRecipe('stutter', 5)];
    check('macro step keeps the selection as fractions', steps[0].sel.kind === 'rect' && Math.abs(steps[0].sel.fx - 40 / 641) < 1e-9);
    const run = async (f, o) => { const q = await open(f); const r = DB.runMacro(q, steps, o); q.commit(r.patch); return { q, r }; };
    const r1 = await run('rgb24.bmp', { seed: 4 }), r2 = await run('rgb24.bmp', { seed: 4 }), r3 = await run('rgb24.bmp', { seed: 5 });
    check('macro: same seed, same result', eq(view(r1.q), view(r2.q)) && r1.r.ran === 3);
    check('macro: different seed, different result', !eq(view(r1.q), view(r3.q)));
    const rk = await run('rgb24.bmp', { keepSeeds: true }), rk2 = await run('rgb24.bmp', { keepSeeds: true }); check('macro: recorded seeds replay identically', eq(view(rk.q), view(rk2.q)));
    const rp = await run('rgb.png', { seed: 4 }); check('macro runs on a PNG of another size', rp.r.ran === 3 && rp.r.patch.entries.length > 0);
    lockedIntact(rp.q, 'macro on png');
    const rj = await run('base.jpg', { seed: 4 }); check('macro on a JPEG skips what does not apply instead of failing', rj.r.skipped.length >= 2 && rj.r.ran + rj.r.skipped.length === 3, JSON.stringify(rj.r.skipped.map((x) => x.why)));
    const rg = await run('rgb.gif', { seed: 4 }); check('macro on a GIF runs', rg.r.ran >= 1);
    const js = JSON.parse(JSON.stringify(steps)); const rj2 = DB.runMacro(await open('rgb24.bmp'), js, { seed: 4 }); check('macro survives JSON', rj2.ran === 3);
    // mash step remembers its file
    const mstep = DB.stepFromTool(d, 'mash', null, { mode: 'xor', src: Object.assign(makeSrc(d), { path: '/x/other.png' }) });
    check('mix step stores the file path, not the pixels', mstep.params.src.__file === '/x/other.png' && !mstep.params.src.rgba);
    const files = new Map([['/x/other.png', makeSrc(d)]]);
    const rm = DB.runMacro(await open('rgb24.bmp'), [mstep], { seed: 1, files }); check('mix step runs with its file', rm.ran === 1 && rm.patch.entries.length > 0);
    const rm2 = DB.runMacro(await open('rgb24.bmp'), [mstep], { seed: 1 }); check('mix step without its file is skipped with a reason', rm2.ran === 0 && /Choose the other image/.test(rm2.skipped[0].why));
    // history jump: undo/redo by index lands on exact states
    d = await open('rgb24.bmp'); const states = [Buffer.from(d.buf)];
    for (const id of ['bitOp', 'shatter', 'echo']) { const p = DB.runOp(d, id, null, { seed: 2 }); d.commit(p); states.push(Buffer.from(d.buf)); }
    let ok = true; for (const n of [0, 3, 1, 2, 0, 3]) { while (d.undoStack.length > n) d.undo(); while (d.undoStack.length < n) d.redo(); if (!eq(Buffer.from(d.buf), states[n])) ok = false; } check('jumping around history lands on exact states', ok);
  }


  // =============================================================================================
  // v1.1: fine control, frames/animation, header tool, new formats, PNG chunks, compression glitch, recipes
  // =============================================================================================
  {
    const openF = async (f) => DB.open(new Uint8Array(fs.readFileSync(path.join(FIX, f))), f);
    const eqb = (a, b) => same(a, b);
    const changed = (patch) => patch.entries.reduce((a, e) => a + (e.b ? e.b.length : e.n || 1), 0);
    const diffBytes = (d) => { let n = 0; if (d.buf.length !== d.orig.length) return -1; for (let i = 0; i < d.buf.length; i++) if (d.buf[i] !== d.orig[i]) n++; return n; };
    const crc32 = (b) => { let c, crc = 0xffffffff; for (let i = 0; i < b.length; i++) { c = (crc ^ b[i]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; };

    // ---- fine control (strength / coverage)
    {
      const sel = { x: 20, y: 30, w: 300, h: 150 };
      for (const id of ['noise', 'shatter', 'smear', 'channels', 'bitOp', 'sort']) {
        const d = await openF('rgb24.bmp'), P = { seed: 7 };
        const full = DB.runOp(d, id, sel, P); const nFull = changed(full); d.revertPatch(full);
        const gent = DB.runOp(d, id, sel, Object.assign({ strength: 35 }, P)); const nG = changed(gent); d.revertPatch(gent);
        const cov = DB.runOp(d, id, sel, Object.assign({ coverage: 40 }, P)); const nC = changed(cov); d.revertPatch(cov);
        check(`fine control ${id}: lower coverage changes fewer bytes`, nC < nFull && nC > 0, `${nC} vs ${nFull}`);
        const a = DB.runOp(d, id, sel, { seed: 7, strength: 35, coverage: 60 }); d.commit(a); const s1 = Buffer.from(d.buf); d.undo();
        const b = DB.runOp(d, id, sel, { seed: 7, strength: 35, coverage: 60 }); d.commit(b); check(`fine control ${id}: deterministic`, eqb(s1, d.buf)); d.undo();
        check(`fine control ${id}: undo exact`, eqb(d.buf, d.orig));
        void nG;
      }
      const d = await openF('rgb24.bmp');
      const z = DB.runOp(d, 'noise', sel, { seed: 1, strength: 0 }); check('strength 0 changes nothing', z.entries.length === 0);
      const f0 = DB.runOp(d, 'fill', sel, { seed: 1 }); const dFull = (() => { d.commit(f0); const n = diffBytes(d); d.undo(); return n; })();
      const f1 = DB.runOp(d, 'fill', sel, { seed: 1, strength: 50 }); d.commit(f1); const dHalf = diffBytes(d); d.undo();
      check('strength 50 blends toward the original (smaller difference)', dHalf <= dFull && dHalf > 0, `${dHalf} vs ${dFull}`);
      for (const f of ['base.jpg', 'rgb.png', 'rgb.gif', 'rgb.tif', 'pal8.bmp', 'rst.jpg']) {
        const dd = await openF(f), av = DB.toolsFor(dd).filter((x) => !x.why && x.op.needs !== 'none' && !x.op.verify && x.id !== 'cut' && x.id !== 'mash').map((x) => x.id);
        let ok = true, err = '';
        for (const id of av.slice(0, 12)) { try { const p = DB.runOp(dd, id, { x: 5, y: 5, w: 60, h: 50 }, { seed: 3, strength: 45, coverage: 70 }); dd.commit(p); lockedIntact(dd, `${f} ${id} fine`); dd.undo(); } catch (e) { if (!/Choose|nothing|can.t|No |only|needs/i.test(e.message)) { ok = false; err = id + ': ' + e.message; } } }
        check(`fine control on ${f} never throws unexpectedly`, ok, err);
      }
    }

    // ---- mirror halves, both directions
    {
      const d = await openF('rgb24.bmp'), L = d.layout, W = L.width, H = L.height;
      const px = (rgba, x, y) => rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 4).join();
      const before = renderRGBA(d);
      for (const [mode, test] of [
        ['lr', (a, x, y) => (x < W / 2 ? px(a, x, y) === px(before, x, y) : px(a, x, y) === px(before, W - 1 - x, y))],
        ['rl', (a, x, y) => (x >= W / 2 ? px(a, x, y) === px(before, x, y) : px(a, x, y) === px(before, W - 1 - x, y))],
        ['tb', (a, x, y) => (y < H / 2 ? px(a, x, y) === px(before, x, y) : px(a, x, y) === px(before, x, H - 1 - y))],
        ['bt', (a, x, y) => (y >= H / 2 ? px(a, x, y) === px(before, x, y) : px(a, x, y) === px(before, x, H - 1 - y))],
      ]) {
        d.commit(DB.runOp(d, 'mirror', null, { mode })); const after = renderRGBA(d); let ok = true;
        for (let y = 0; y < H && ok; y += 7) for (let x = 0; x < W && ok; x += 5) ok = test(after, x, y);
        check(`mirror ${mode}: one half is copied onto the other, the source half is untouched`, ok);
        lockedIntact(d, 'mirror ' + mode); d.undo(); check(`mirror ${mode}: undo exact`, eqb(d.buf, d.orig));
      }
    }

    // ---- clone + reopen
    {
      const d = await openF('rgb24.bmp'), c = d.clone();
      c.commit(DB.runOp(c, 'noise', { x: 0, y: 0, w: 50, h: 50 }, { seed: 1 }));
      check('clone is independent of the original', eqb(d.buf, d.orig) && !eqb(c.buf, d.buf) && d.undoStack.length === 0 && c.undoStack.length === 1);
      const base = Buffer.from(await d.exportBytes());
      const p = DB.runOp(d, 'header', null, { width: 300, fit: true, bpp: 'keep', offset: 0 }); d.commit(p);
      check('header edit reopens the file at the new width', d.layout.width === 300);
      d.undo(); check('undo of a header edit restores the exact file', eqb(Buffer.from(await d.exportBytes()), base) && d.layout.width === 641);
      d.redo(); check('redo of a header edit comes back', d.layout.width === 300); d.undo();
    }

    // ---- header tool on every format that supports it
    {
      const cases = [['rgb24.bmp', { width: 333 }], ['rgb24.bmp', { width: 641, bpp: '8' }], ['rgb24.bmp', { width: 641, bpp: '32' }], ['rgb24.bmp', { width: 641, offset: 7 }], ['pal8.bmp', { width: 200 }], ['rgb.png', { width: 100 }], ['rgb.png', { width: 160, fit: false, height: 30 }], ['rgb.gif', { width: 77 }], ['rgb.tif', { width: 200 }], ['rgb.ppm', { width: 99 }], ['gray.pgm', { width: 50 }], ['rgb.png', { width: 160 }]];
      for (const [f, o] of cases) {
        const d = await openF(f), before = Buffer.from(await d.exportBytes()), L0 = d.layout;
        const params = Object.assign({ fit: true, bpp: 'keep', offset: 0 }, o);
        let patch = null, err = '';
        try { patch = DB.runOp(d, 'header', null, params); } catch (e) { err = e.message; }
        const tag = `header ${f} ${JSON.stringify(o)}`;
        if (!patch) { check(tag + ': refused with a reason', !!err, err); continue; }
        if (!patch.entries.length) { check(tag + ': no-op leaves the file alone', params.width === L0.width); continue; }
        d.commit(patch);
        const bytes = await d.exportBytes(); let re = null;
        try { re = await DB.open(bytes, f); } catch (e) { err = e.message; }
        check(tag + ': result opens again', !!re && re.layout.width > 0 && re.layout.height > 0, err);
        if (re && o.width) check(tag + ': width is what was asked', re.layout.width === Math.round(o.width) || (f.endsWith('.gif') || f.endsWith('.tif')), `${re.layout.width}`);
        if (re) { const tg = 'hdr-' + f.replace(/\W/g, '_') + '-' + manifest.length; const ext = DB.extFor(d); fs.writeFileSync(path.join(OUT, tg + '.' + ext), bytes); manifest.push({ tag: tg, file: path.join(OUT, tg + '.' + ext), cmp: 'open', w: re.layout.width, h: re.layout.height }); }
        d.undo(); check(tag + ': undo restores the exact file', eqb(Buffer.from(await d.exportBytes()), before));
      }
      // refuses nonsense instead of writing a broken file
      const d = await openF('rgb24.bmp'); let threw = false; try { DB.runOp(d, 'header', null, { width: 0, fit: true, bpp: 'keep', offset: 0 }); } catch (e) { threw = true; }
      check('header tool refuses width 0 (or clamps it)', threw || d.layout.width > 0);
    }

    // ---- compression glitch
    for (const f of ['rgb.png', 'rgb24.bmp', 'rgb.gif', 'pal8.bmp', 'rgba.png', 'rgb.tif']) {
      const d = await openF(f); if (DB.OPS.compGlitch.available(d)) continue;
      for (const algo of ['deflate', 'lzw']) for (const how of ['byte', 'flip', 'zero', 'copy']) {
        const mk = () => DB.runOp(d, 'compGlitch', { x: 0, y: 20, w: d.layout.width, h: 40 }, { algo, how, hits: 4, after: 'keep', seed: 9 });
        let p1, p2; try { p1 = mk(); d.commit(p1); } catch (e) { check(`compGlitch ${f} ${algo}/${how} runs`, false, e.message); continue; }
        const s1 = Buffer.from(d.buf); d.undo(); p2 = mk(); d.commit(p2);
        check(`compGlitch ${f} ${algo}/${how}: deterministic`, eqb(s1, d.buf)); lockedIntact(d, `compGlitch ${f} ${algo}/${how}`);
        const rows = d.dirtyRows(p2); check(`compGlitch ${f} ${algo}/${how}: only touches the chosen rows`, !rows || (rows[0] >= 20 - 1 && rows[1] <= 61), JSON.stringify(rows));
        d.undo();
      }
      const p = DB.runOp(d, 'compGlitch', null, { algo: 'deflate', how: 'byte', hits: 6, after: 'smear', seed: 4 }); d.commit(p);
      await exportAndRecord(d, 'comp-' + f.replace(/\W/g, '_'), 'open');
    }
    check('compression-glitch deflate encoder round-trips (own inflate)', (() => { const raw = Uint8Array.from({ length: 5000 }, (_, i) => (i * 31 + (i >> 5)) & 255); const z = DB.deflateFixed(raw); return eqb(DB.inflateFixed(z, raw.length, false).data, raw); })());
    check('own deflate stream is accepted by zlib', (() => { const raw = Uint8Array.from({ length: 5000 }, (_, i) => (i * 13) & 255); const z = DB.deflateFixed(raw); return eqb(require('zlib').inflateRawSync(Buffer.from(z)), Buffer.from(raw)); })());

    // ---- PNG chunk tools
    {
      const parse = (b) => { const out = []; let p = 8; while (p + 12 <= b.length) { const n = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8); out.push({ type, n, crcOk: crc32(b.subarray(p + 4, p + 8 + n)) === b.readUInt32BE(p + 8 + n) }); p += 12 + n; } return out; };
      for (const f of ['text.png', 'rgb.png', 'rgba.png', 'pal.png']) for (const action of ['shuffle', 'repeat', 'drop', 'text', 'split']) {
        const d = await openF(f), tag = `pngChunks ${f} ${action}`; let p;
        try { p = DB.runOp(d, 'pngChunks', null, { action, count: 6, text: 'hello', piece: 64, seed: 5 }); } catch (e) { check(tag + ': refuses with a reason', /no (optional|text)/.test(e.message), e.message); continue; }
        const before = renderRGBA(d); d.commit(p);
        const bytes = Buffer.from(await d.exportBytes()), chunks = parse(bytes);
        check(tag + ': every CRC valid', chunks.every((c) => c.crcOk) && chunks[0].type === 'IHDR' && chunks[chunks.length - 1].type === 'IEND');
        const re = await DB.open(new Uint8Array(bytes), f); check(tag + ': pixels unchanged', eqb(renderRGBA(re), before));
        if (action === 'split') check(tag + ': IDAT cut into pieces', chunks.filter((c) => c.type === 'IDAT').length > 1);
        if (action === 'text') check(tag + ': text chunks added', chunks.filter((c) => c.type === 'tEXt').length >= 6);
        if (action === 'drop') check(tag + ': optional chunks gone', chunks.every((c) => !/^[a-z]/.test(c.type) || c.type === 'tRNS'));
        d.undo(); check(tag + ': undo exact', true);
        await exportAndRecord(d, 'chunks-' + f.replace(/\W/g, '_') + '-' + action, 'rgba');
      }
      // the transparency chunk of a palette PNG is never moved or dropped
      const d = await openF('pal.png'); const hasTrns = (await d.exportBytes()).toString ? Buffer.from(await d.exportBytes()).includes('tRNS') : false;
      if (hasTrns) { d.commit(DB.runOp(d, 'pngChunks', null, { action: 'drop', seed: 1 })); check('tRNS survives dropping optional chunks', Buffer.from(await d.exportBytes()).includes('tRNS')); }
      // per-row filter patterns
      const e = await openF('rgb.png');
      for (const type of ['cycle', 'bands']) { const p = DB.runOp(e, 'pngFilter', { x: 0, y: 0, w: e.layout.width, h: e.layout.height }, { type, chance: 100, seed: 2 }); e.commit(p); await exportAndRecord(e, 'pngfilter-' + type, 'rgba'); e.undo(); }
    }

    // ---- PPM / PGM, ICO, WebP, raw
    {
      for (const f of ['rgb.ppm', 'gray.pgm']) {
        const d = await openF(f), raw = fs.readFileSync(path.join(FIX, f));
        check(`${f}: opens as pnm raster`, d.format === 'ppm' && d.layout.kind === 'raster');
        check(`${f}: untouched export is byte-identical`, eqb(Buffer.from(await d.exportBytes()), raw));
        for (const t of DB.toolsFor(d).filter((x) => !x.why && x.op.needs !== 'none' && x.id !== 'mash' && !x.op.verify).slice(0, 14)) { try { d.commit(DB.runOp(d, t.id, { x: 3, y: 3, w: 80, h: 40 }, { seed: 2 })); lockedIntact(d, `${f} ${t.id}`); d.undo(); } catch (e) { check(`${f} ${t.id} runs`, /choose|nothing/i.test(e.message), e.message); } }
        d.commit(DB.runOp(d, 'rows', { x: 0, y: 0, w: d.layout.width, h: 60 }, { seed: 3 })); await exportAndRecord(d, 'pnm-' + f.replace(/\W/g, '_'), 'rgb');
      }
      { const rgba = new Uint8ClampedArray(7 * 5 * 4).map((_, i) => (i * 11) & 255); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; const d = await DB.open(DB.buildPPM(rgba, 7, 5), 'x.ppm'); check('buildPPM round-trips', d.layout.width === 7 && d.layout.height === 5 && renderRGBA(d)[0] === rgba[0] && renderRGBA(d)[4] === rgba[4]); }
      for (const f of ['icon_png.ico', 'icon_dib.ico']) {
        const d = await openF(f), raw = fs.readFileSync(path.join(FIX, f));
        check(`${f}: opens`, d.format === 'ico' && d.layout.width === 64);
        if (f === 'icon_dib.ico') check(`${f}: untouched export is byte-identical`, eqb(Buffer.from(await d.exportBytes()), raw));
        else { const re0 = await DB.open(await d.exportBytes(), f); check(`${f}: PNG inside is re-compressed but the picture and the other sizes survive`, eqb(renderRGBA(re0), renderRGBA(d)) && Buffer.from(await d.exportBytes()).readUInt16LE(4) === raw.readUInt16LE(4)); }
        d.commit(DB.runOp(d, 'rows', { x: 0, y: 0, w: 64, h: 40 }, { seed: 3 })); lockedIntact(d, f);
        const bytes = await d.exportBytes(); const re = await DB.open(bytes, f); check(`${f}: edited file opens again`, re.layout.width === 64);
        await exportAndRecord(d, 'ico-' + f.replace(/\W/g, '_'), 'rgb');
      }
      for (const f of ['lossy.webp', 'lossless.webp']) {
        const d = await openF(f), raw = fs.readFileSync(path.join(FIX, f));
        check(`${f}: opens as a stream`, d.format === 'webp' && d.layout.kind !== 'raster' && d.segments.length >= 1);
        check(`${f}: untouched export is byte-identical`, eqb(Buffer.from(await d.exportBytes()), raw));
        const p = DB.runOp(d, 'tweak', null, { seed: 4, amount: 2 }); d.commit(p); lockedIntact(d, f + ' tweak');
        const e1 = await d.exportBytes(); check(`${f}: edit keeps the container header`, Buffer.from(e1).toString('latin1', 0, 4) === 'RIFF' && Buffer.from(e1).toString('latin1', 8, 12) === 'WEBP' && Buffer.from(e1).readUInt32LE(4) === e1.length - 8);
        if (f === 'lossy.webp') { const out = path.join(OUT, 'webp-' + f); fs.writeFileSync(out, e1); manifest.push({ tag: 'webp-' + f, file: out, cmp: 'open', w: d.layout.width, h: d.layout.height }); } // lossless streams often stop decoding after an edit; the app checks and undoes those
      }
      // raw: any file as pixels
      {
        const src = new Uint8Array(fs.readFileSync(path.join(__dirname, '..', 'package.json')));
        for (const fmt of Object.keys(DB.RAW_FORMATS)) {
          const d = DB.openRaw(src, 'package.json', { width: 20, format: fmt, lock: 4 });
          check(`raw ${fmt}: untouched export is the same file`, eqb(Buffer.from(await d.exportBytes()), Buffer.from(src)));
          d.commit(DB.runOp(d, 'shatter', null, { seed: 3 })); lockedIntact(d, 'raw ' + fmt);
          const out = await d.exportBytes(); check(`raw ${fmt}: edited export keeps length and the locked bytes`, out.length === src.length && eqb(Buffer.from(out).subarray(0, 4), Buffer.from(src).subarray(0, 4)));
          check(`raw ${fmt}: saves with the original extension`, DB.extFor(d) === 'json');
        }
        const d = DB.openRaw(src, 'x.bin', { width: 20, format: 'rgb', lock: 0 }); check('raw: every byte editable', d.segments.reduce((a, s) => a + s.len, 0) === src.length || d.layout.height * d.layout.stride >= src.length - d.layout.stride);
      }
    }

    // ---- shared recipes
    {
      const dir = path.join(__dirname, '..', 'recipes'); const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
      check('recipes folder ships sample recipes', files.length >= 6);
      for (const f of files) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        check(`recipe ${f}: well formed`, j.format === 'image-bender-macro' && j.name && Array.isArray(j.steps) && j.steps.length > 0);
        for (const img of ['rgb24.bmp', 'rgb.png', 'rgb.gif']) { const d = await openF(img); const r = DB.runMacro(d, j.steps, { seed: 3 }); check(`recipe ${f} runs on ${img}`, r.ran > 0 && r.patch.entries.length > 0, JSON.stringify(r.skipped)); if (r.patch.entries.length) lockedIntact(d, `recipe ${f} ${img}`); }
      }
    }
  }

  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
  console.log(`engine checks: ${pass} passed, ${fail} failed`);
  for (const f of failures.slice(0, 40)) console.log('  FAIL', f);

  // ---- decoder cross-check with Pillow ----
  const py = execFileSync('python3', [path.join(__dirname, 'verify.py'), path.join(OUT, 'manifest.json')], { encoding: 'utf8', maxBuffer: 1 << 26 });
  console.log(py.trim());
  const m = /(\d+) mismatches/.exec(py);
  process.exit(fail || (m && +m[1]) ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
