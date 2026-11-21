(function () {
  const DB = (globalThis.DB = globalThis.DB || {});

  // A macro is a list of steps: { op, params, sel } or { recipe, seed }.
  // Selections and positions are stored as fractions of the picture, so a macro made on one image
  // lands in the same place on an image of a different size.

  DB.relSel = function (doc, sel) {
    const L = doc.layout;
    if (!sel) return null;
    if (sel.range) return { kind: 'range', fa: sel.range.a / Math.max(1, doc.length), fb: sel.range.b / Math.max(1, doc.length) };
    if (!(sel.h > 0)) return null;
    if (L.kind === 'raster') return sel.w > 0 ? { kind: 'rect', fx: sel.x / L.width, fy: sel.y / L.height, fw: sel.w / L.width, fh: sel.h / L.height } : null;
    return { kind: 'band', fy: sel.y / L.height, fh: sel.h / L.height };
  };
  DB.absSel = function (doc, rel) {
    const L = doc.layout;
    if (!rel) return null;
    if (rel.kind === 'range') return { range: { a: Math.floor(rel.fa * doc.length), b: Math.max(Math.floor(rel.fa * doc.length) + 1, Math.ceil(rel.fb * doc.length)) }, x: 0, y: 0, w: 0, h: 0 };
    const fy = rel.fy, fh = rel.fh;
    if (L.kind === 'raster') {
      const fx = rel.kind === 'rect' ? rel.fx : 0, fw = rel.kind === 'rect' ? rel.fw : 1;
      return { x: Math.round(fx * L.width), y: Math.round(fy * L.height), w: Math.max(1, Math.round(fw * L.width)), h: Math.max(1, Math.round(fh * L.height)) };
    }
    return { x: 0, y: fy * L.height, w: L.width, h: Math.max(1, fh * L.height) };
  };

  DB.stepFromTool = function (doc, id, sel, params) {
    const L = doc.layout, p = {};
    for (const [k, v] of Object.entries(params || {})) {
      if (typeof v === 'function') continue;
      if (v && typeof v === 'object' && v.rgba) p[k] = { __file: v.path || '', name: v.name || '' };
      else if (k === 'dest' && v && v.x !== undefined && L.kind === 'raster') p.destRel = { fx: v.x / L.width, fy: v.y / L.height };
      else p[k] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
    return { op: id, params: p, sel: DB.relSel(doc, sel) };
  };
  DB.stepFromRecipe = (id, seed) => ({ recipe: id, seed });

  DB.deriveSeed = (base, i) => ((((base | 0) * 1103515245 + (i + 1) * 12345) >>> 0) % 999983) + 1;
  DB.stepTitle = function (s) {
    if (s.recipe) return 'Recipe: ' + ((DB.RECIPES[s.recipe] || {}).title || s.recipe);
    return (DB.OPS[s.op] || {}).title || s.op;
  };
  DB.stepFiles = (steps) => [...new Set(steps.flatMap((s) => Object.values(s.params || {}).filter((v) => v && v.__file).map((v) => v.__file)))];

  // Run steps inside a transaction. opts: { seed, keepSeeds, files: Map(path -> source) }
  DB.runMacroIn = function (tx, doc, steps, opts) {
    opts = opts || {};
    const skipped = []; let ran = 0;
    steps.forEach((s, i) => {
      try {
        if (s.recipe) {
          const r = DB.RECIPES[s.recipe];
          if (!r || !DB.recipesFor(doc).some((x) => x.id === s.recipe)) { skipped.push({ i, why: 'recipe not available for this file' }); return; }
          const seed = opts.keepSeeds ? s.seed : DB.deriveSeed(opts.seed || 1, i);
          for (const st of r.build(doc, DB.rng(seed))) DB.runOpIn(tx, doc, st.op, st.sel, st.params);
          ran++; return;
        }
        const op = DB.OPS[s.op];
        if (!op) { skipped.push({ i, why: 'unknown tool' }); return; }
        const why = op.available(doc);
        if (why) { skipped.push({ i, why }); return; }
        const L = doc.layout, p = Object.assign({}, s.params);
        if (p.destRel && L.kind === 'raster') { p.dest = { x: Math.round(p.destRel.fx * L.width), y: Math.round(p.destRel.fy * L.height) }; delete p.destRel; }
        for (const k of Object.keys(p)) if (p[k] && p[k].__file !== undefined) p[k] = (opts.files && opts.files.get(p[k].__file)) || null;
        if ('seed' in p && !opts.keepSeeds) p.seed = DB.deriveSeed(opts.seed || 1, i);
        DB.runOpIn(tx, doc, s.op, DB.absSel(doc, s.sel), p);
        ran++;
      } catch (e) { skipped.push({ i, why: e.message }); }
    });
    return { ran, skipped };
  };
  DB.runMacro = function (doc, steps, opts) {
    const tx = doc.begin(), res = DB.runMacroIn(tx, doc, steps, opts);
    return Object.assign({ patch: tx.finish() }, res);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DB;
})();
