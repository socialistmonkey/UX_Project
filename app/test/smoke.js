// Runs inside the renderer. Exercises the real UI end to end and saves screenshots.
try { localStorage.setItem('ib.tour', '1'); } catch (e) {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message));
window.addEventListener('unhandledrejection', (e) => errors.push('unhandled: ' + (e.reason && e.reason.stack || e.reason)));
const origErr = console.error; console.error = (...a) => { errors.push('console.error: ' + a.map(String).join(' ')); origErr(...a); };
const shot = (n) => api.smokeShot('/home/claude/databender/test/shots/' + n + '.png');
const FIX = '/home/claude/databender/test/fixtures/';
const log = [];
async function open(name) { const f = await api.readFile(FIX + name); await App.openFiles([f]); await wait(400); }

await open('rgb24.bmp');
log.push('opened bmp: ' + App.tab.doc.layout.width + 'x' + App.tab.doc.layout.height);
await shot('01-opened');

Visual.setSelection({ x: 120, y: 150, w: 300, h: 100 });
Tools.select('stamp'); await wait(500);
await shot('02-stamp-preview');
log.push('pending after select: ' + !!App.tab.pending);
Tools.setDest(200, 40); await wait(400);
await Tools.apply(); await wait(200);
log.push('undo stack: ' + App.tab.doc.undoStack.length);

Tools.select('shear'); await wait(600);
await shot('03-shear-preview');
await Tools.apply(); await wait(200);

await Tools.recipe('acid'); await wait(500);
log.push('after recipe stack: ' + App.tab.doc.undoStack.length);

App.setMode('hex'); await wait(500);
await shot('04-hex');
// typing in locked area should be refused, typing in pixel area should work
Hex.jumpTo(10); await wait(100);
const before = App.tab.doc.undoStack.length;
await Hex.typeDigit('A'); await Hex.typeDigit('B'); await wait(200);
log.push('typing in header changed history: ' + (App.tab.doc.undoStack.length !== before));
Hex.jumpTo(App.tab.doc.segments[0].start + 5000); await wait(100);
await Hex.typeDigit('A'); await Hex.typeDigit('B'); await wait(300);
log.push('typing in pixels changed history: ' + (App.tab.doc.undoStack.length === before + 1) + ' byte=' + App.tab.doc.buf[App.tab.doc.segments[0].start + 5000].toString(16));
await shot('05-hex-edit');

App.setMode('visual'); await wait(300);
await App.undo(); await App.undo(); await wait(300);
log.push('after 2 undos: ' + App.tab.doc.undoStack.length);

// JPEG + PNG + GIF + TIFF through the UI
for (const f of ['base.jpg', 'rgb.png', 'rgb.gif', 'rgb.tif']) {
  await open(f);
  Visual.setSelection({ x: 0, y: 100, w: 641, h: 150 });
  if (f === 'rgb.png') Tools.select('pngFilter'); else if (f === 'rgb.tif') Tools.select('wrongWidth'); else if (f === 'rgb.gif') Tools.select('indexShift'); else Tools.select('tweak');
  await wait(900);
  log.push(f + ' pending=' + !!App.tab.pending);
  await shot('10-' + f.replace('.', '_'));
  await Tools.apply(); await wait(300);
  log.push(f + ' stack=' + App.tab.doc.undoStack.length);
}
// convert a JPEG copy to BMP
App.tab = App.tabs.find((t) => t.name === 'base.jpg'); await App.activate(App.tab); await wait(300);
await App.convert('bmp'); await wait(600);
log.push('convert -> ' + App.tab.name + ' format=' + App.tab.doc.format);
await shot('20-converted');
log.push('tabs=' + App.tabs.length);

// ---- new things: hex editor, history, macros, mix, restart blocks ----
await open('rgb24.bmp');
const T = App.tab;
Visual.setSelection({ x: 40, y: 60, w: 400, h: 120 });
Tools.select('bitOp'); await wait(400); await Tools.apply(); await wait(200);
Tools.select('echo'); await wait(500); await Tools.apply(); await wait(200);
Tools.select('rows'); await wait(500); await Tools.apply(); await wait(200);
log.push('steps recorded: ' + T.doc.undoStack.filter((p) => p.step).length + ' labels: ' + T.doc.undoStack.map((p) => p.label).join(' | '));
await shot('30-tools-groups');

Panels.setTab('history'); await wait(300);
await shot('31-history');
await Panels.jumpTo(1); await wait(300);
log.push('jumped to step 1: undo=' + T.doc.undoStack.length + ' redo=' + T.doc.redoStack.length);
await Panels.jumpTo(3); await wait(300);
log.push('jumped to step 3: undo=' + T.doc.undoStack.length);

Panels.setTab('macros'); await wait(300);
Panels.macros.length = 0;
Panels.macros.push({ id: 1, name: 'Test macro', steps: Panels.stepsFromHistory(T) }); Panels.save(); Panels.render(); await wait(200);
await shot('32-macros');
await open('rgb.png');
const before2 = App.tab.doc.undoStack.length;
await Panels.runHere(Panels.macros[0]); await wait(500);
log.push('macro on png: stack ' + before2 + ' -> ' + App.tab.doc.undoStack.length + ' label=' + App.tab.doc.undoStack.slice(-1)[0].label);

// batch pieces: list a folder, run the macro checked, encode both ways, write
const list = await api.listDir(FIX.slice(0, -1));
log.push('listDir images: ' + list.length);
{
  const f = await api.readFile(FIX + 'base.jpg');
  const { doc } = await App.docFromBytes(new Uint8Array(f.data), 'base.jpg');
  const res = await Panels.runChecked(doc, Panels.macros[0], new Map(), 3);
  const png = await Panels.encode(doc, 'png'), jpg = await Panels.encode(doc, 'file');
  const out = await api.writeInDir({ dir: '/tmp/ib-smoke-out', name: 'x-bent.png', data: png });
  log.push('batch on jpeg: ran=' + (res ? res.ran : 'null') + ' png=' + png.length + ' jpg decodes=' + (await App.decodes(jpg)) + ' wrote=' + out);
}

// hex editor
await open('rgb24.bmp'); App.setMode('hex'); await wait(400);
log.push('columns auto = ' + Hex.eff());
Hex.jumpTo(App.tab.doc.segments[0].start + 3000); await wait(100);
$('#hxCols').value = '16'; $('#hxCols').dispatchEvent(new Event('change')); await wait(200);
log.push('columns 16 = ' + Hex.eff());
$('#hxCols').value = 'auto'; $('#hxCols').dispatchEvent(new Event('change')); await wait(200);
// find
Hex.openFind(); $('#hfQ').value = 'FF 00'; $('#hfQ').dispatchEvent(new Event('input')); await wait(300);
log.push('find "FF 00": ' + Hex.find.hits.length + ' hits, label=' + $('#hfCount').textContent);
Hex.findStep(1); await wait(100); const h1 = Hex.t.hexSel.a; Hex.findStep(1); await wait(100);
log.push('find next moves: ' + (Hex.t.hexSel.a > h1));
$('#hfQ').value = 'FF ??'; $('#hfQ').dispatchEvent(new Event('input')); await wait(200);
log.push('wildcard hits: ' + Hex.find.hits.length);
$('#hfQ').value = ''; $('#hfMode').value = 'text'; $('#hfMode').dispatchEvent(new Event('change'));
$('#hfQ').value = 'BM'; $('#hfQ').dispatchEvent(new Event('input')); await wait(200);
log.push('text find BM: ' + Hex.find.hits.length);
// replace respects locked bytes: the BM at offset 0 is locked
await Hex.replaceBytes([0]).catch(() => {});
log.push('locked match replaced? ' + (App.tab.doc.buf[0] === 0x42));
$('#hfMode').value = 'hex'; $('#hfMode').dispatchEvent(new Event('change'));
$('#hfQ').value = 'FF 00'; $('#hfQ').dispatchEvent(new Event('input')); await wait(200);
$('#hfRep').value = '00 ??'; const nHits = Hex.find.hits.length;
const stack0 = App.tab.doc.undoStack.length; await Hex.replaceAll(); await wait(300);
log.push('replace all: stack ' + stack0 + ' -> ' + App.tab.doc.undoStack.length + ' label=' + App.tab.doc.undoStack.slice(-1)[0].label);
await shot('40-hex-find');
Hex.closeFind();
// ascii typing
Hex.jumpTo(App.tab.doc.segments[0].start + 100); Hex.col = 'ascii'; await Hex.typeByte('Z'.charCodeAt(0)); Hex.col = 'hex';
log.push('ascii typing wrote Z: ' + (App.tab.doc.buf[App.tab.doc.segments[0].start + 100] === 90));
// inspector number box
Hex.jumpTo(App.tab.doc.segments[0].start + 200); await wait(100);
const box = $('#inspector input[data-kind="u16"]'); box.value = '4660'; await Hex.writeNumber(box); await wait(200);
{ const o = App.tab.doc.segments[0].start + 200; log.push('u16 box wrote 0x1234 little-endian: ' + (App.tab.doc.buf[o] === 0x34 && App.tab.doc.buf[o + 1] === 0x12)); }
Hex.jumpTo(30); await wait(100);
const bx2 = $('#inspector input[data-kind="u8"]'); bx2.value = '99'; const st1 = App.tab.doc.undoStack.length; await Hex.writeNumber(bx2); await wait(200);
log.push('inspector refuses locked bytes: ' + (App.tab.doc.undoStack.length === st1));
// nudge + revert
Hex.jumpTo(App.tab.doc.segments[0].start + 300); Hex.setSel(App.tab.doc.segments[0].start + 300, App.tab.doc.segments[0].start + 310);
const orig300 = App.tab.doc.buf[App.tab.doc.segments[0].start + 300];
await Hex.nudge(5); await wait(150);
log.push('nudge +5: ' + (App.tab.doc.buf[App.tab.doc.segments[0].start + 300] === ((orig300 + 5) & 255)));
await Hex.fill('revert'); await wait(150);
log.push('revert: ' + (App.tab.doc.buf[App.tab.doc.segments[0].start + 300] === App.tab.doc.orig[App.tab.doc.segments[0].start + 300]));
// bookmarks
$('#hxMarks').click(); await wait(100); $('#marksMenu [data-add]').click(); await wait(100);
log.push('bookmarks: ' + App.tab.marks.length);
Hex.jumpTo(App.tab.doc.segments[0].start + 1000); await wait(150);
await shot('41-hex-editor');
Panels.setTab('history'); await wait(200); await shot('42-history-hex');
Panels.setTab('tool');

// mix tool with a second image
App.setMode('visual'); await wait(200);
Visual.setSelection(null);
Tools.select('mash'); await wait(200);
const f2 = await api.readFile(FIX + 'rgb.png'); const src = await App.loadSource(f2);
App.tab.tool.params.src = src; Tools.renderPanel(); Tools.schedule(true); await wait(700);
log.push('mix preview pending=' + !!App.tab.pending);
await shot('50-mix');
await Tools.apply(); await wait(200);
// JPEG restart blocks via Convert
App.tab = App.tabs.find((t) => t.name === 'rgb24.bmp'); await App.activate(App.tab); await wait(200);
{ const px = await App.currentPixels(App.tab); const b = DB.encodeJPEG(px.data, px.w, px.h, { quality: 80, restart: 4 }); await App.openBytes(b, 'blocks.jpg'); await wait(600); }
log.push('restart tool available: ' + !DB.OPS.restartBlocks.available(App.tab.doc));
Tools.select('restartBlocks'); await wait(900);
log.push('restart preview pending=' + !!App.tab.pending);
await shot('51-restart-blocks');
await Tools.apply(); await wait(300);
// generation loss (few passes)
{ const px = await App.currentPixels(App.tab); const gl = await App.generationLoss(px, 4, 0.5, true); log.push('generation loss bytes: ' + (gl && gl.length)); }

// =============================================================================================
// v1.1 features
// =============================================================================================
const clickOk = async (ms) => { await wait(ms || 250); const b = $('#mOk'); if (b) b.click(); };
const setF = (id, v) => { const el = $(`[data-f="${id}"]`); if (el) el.value = v; };
const diffCount = (d) => { let n = 0; const a = d.buf, o = d.orig; if (a.length !== o.length) return -1; for (let i = 0; i < a.length; i++) if (a[i] !== o[i]) n++; return n; };

// ---- fine control: strength / coverage
await open('rgb24.bmp');
Visual.setSelection({ x: 40, y: 60, w: 400, h: 200 });
Tools.select('noise'); await wait(700);
{ const full = DB.runOp(App.tab.doc, 'noise', DB.relSel ? App.selectionForOps() : null, { seed: 5 }); const nFull = full.entries.reduce((a, e) => a + (e.n || (e.b ? e.b.length : 0) || 1), 0); App.tab.doc.revertPatch(full);
  const half = DB.runOp(App.tab.doc, 'noise', App.selectionForOps(), { seed: 5, strength: 40, coverage: 50 }); const nHalf = half.entries.reduce((a, e) => a + (e.n || (e.b ? e.b.length : 0) || 1), 0); App.tab.doc.revertPatch(half);
  log.push('fine control: full=' + nFull + ' vs gentle=' + nHalf); }
App.tab.tool.params.strength = 35; App.tab.tool.params.coverage = 60; Tools.renderPanel(); Tools.schedule(true); await wait(800);
log.push('fine panel present: ' + !!$('details.fine') + ' open=' + ($('details.fine') || {}).open + ' sum="' + ($('#fineSum') || {}).textContent + '"');
await shot('60-fine-control');
await Tools.apply(); await wait(200);
{ const st = App.tab.doc.undoStack.slice(-1)[0].step; log.push('macro step records strength: ' + (st && st.params.strength)); }
// Alt+arrow nudge
{ const r = $('input[type=range][data-p="strength"]'); r.focus(); r.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true })); log.push('alt nudge strength -> ' + App.tab.tool.params.strength); }
Tools.deselect();

// ---- split compare
await Visual.setSplit(true); await wait(400);
log.push('split shown: cmp=' + $('#cmp').style.display + ' line=' + $('#splitLine').style.display + ' clip=' + $('#cmp').style.clipPath);
await shot('61-split');
Visual.split.pos = 0.25; Visual.placeSplit();
await Visual.showCompare(); await wait(150);
log.push('hold shows whole original: ' + $('#cmp').style.clipPath);
Visual.hideCompare(); await wait(150);
log.push('after hold split restored: ' + $('#cmp').style.clipPath + ' line=' + $('#splitLine').style.display);
await Visual.setSplit(false); await wait(100);
log.push('split off: ' + $('#cmp').style.display);

// ---- raw pixels
{ const f = await api.readFile('/home/claude/databender/package.json'); const bytes = new Uint8Array(f.data);
  const p = App.openRaw(bytes, 'package.json'); await wait(300); await shot('69-raw-dialog'); $('#mOk').click(); await p; await wait(600);
  const t = App.tab; log.push('raw open: ' + t.name + ' ' + t.doc.layout.width + 'x' + t.doc.layout.height + ' format=' + t.doc.format);
  Visual.setSelection({ x: 0, y: 0, w: t.doc.layout.width, h: 10 }); Tools.select('shear'); await wait(500); log.push('raw tool pending=' + !!t.pending); await Tools.apply(); await wait(200);
  const out = await t.doc.exportBytes(); log.push('raw export length same as source: ' + (out.length === bytes.length) + ' ext=' + DB.extFor(t.doc));
  await shot('70-raw'); }
// unknown file offers raw
{ const p = App.openBytes(new Uint8Array(2000).map((_, i) => (i * 7) & 255), 'mystery.dat'); await wait(400); log.push('unknown file offers raw: ' + !!$('#mOk') + ' title=' + (($('#modal h3') || {}).textContent)); await clickOk(0); await wait(300); await clickOk(0); await p; await wait(400); log.push('mystery opened: ' + App.tab.name); }

// ---- new formats through the UI
for (const f of ['rgb.ppm', 'gray.pgm', 'lossy.webp', 'lossless.webp', 'icon_png.ico', 'icon_dib.ico', 'text.png']) {
  await open(f); const d = App.tab.doc;
  log.push(f + ': ' + d.format + ' ' + d.layout.width + 'x' + d.layout.height + ' tools=' + DB.toolsFor(d).filter((x) => !x.why).length);
}
// header tool with safety net
await open('rgb24.bmp');
Tools.select('header'); await wait(300);
App.tab.tool.params.width = 333; App.tab.tool.params.bpp = '24'; Tools.renderPanel(); Tools.schedule(true); await wait(700);
log.push('header bmp w=333 pending=' + !!App.tab.pending + ' width now ' + App.tab.doc.layout.width);
await shot('71-header');
await Tools.apply(); await wait(300);
log.push('after apply: ' + App.tab.doc.layout.width + 'x' + App.tab.doc.layout.height + ' stack=' + App.tab.doc.undoStack.length);
await App.undo(); await wait(300);
log.push('undo header: ' + App.tab.doc.layout.width + 'x' + App.tab.doc.layout.height);
App.tab.tool.params.bpp = '8'; App.tab.tool.params.width = 641; Tools.renderPanel(); Tools.schedule(true); await wait(700);
log.push('header bpp 8: pending=' + !!App.tab.pending + ' hint="' + ($('#hintbox') || {}).textContent + '"');
Tools.deselect();
await open('rgb.png');
Tools.select('header'); await wait(300);
App.tab.tool.params.width = 7; App.tab.tool.params.fit = true; Tools.renderPanel(); Tools.schedule(true); await wait(800);
log.push('header png w=7: pending=' + !!App.tab.pending + ' hint="' + ($('#hintbox') || {}).textContent + '"');
Tools.deselect();
// compression glitch + png chunks via UI
await open('rgb.png'); Visual.setSelection(null);
Tools.select('compGlitch'); await wait(800); log.push('compGlitch png pending=' + !!App.tab.pending); await shot('72-compglitch'); await Tools.apply(); await wait(300);
Tools.select('pngChunks'); await wait(300); await shot('73-pngchunks-panel'); Tools.deselect();
await open('text.png'); Tools.select('pngChunks'); await wait(800); log.push('pngChunks pending=' + !!App.tab.pending); await Tools.apply(); await wait(300);
{ const b = await App.tab.doc.exportBytes(); log.push('pngChunks result decodes=' + (await App.decodes(b))); }

// ---- recipes folder
await wait(300);
log.push('user recipes loaded: ' + Recipes.list.length + ' names=' + Recipes.list.map((r) => r.name).join(', '));
await open('rgb24.bmp');
await shot('74-left-recipes');
await Recipes.run(0); await wait(500);
log.push('recipe run label: ' + App.tab.doc.undoStack.slice(-1)[0].label);
Panels.setTab('macros'); await wait(200); await shot('75-macros-share'); Panels.setTab('tool');


// ---- bands by keyboard: the selection right next to this one, exactly
{
  Tools.deselect(); const H = Visual.imgH(), W = Visual.imgW();
  const key = (k, o) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, o || {})));
  Visual.setSelection({ x: 0, y: 200, w: W, h: 90 });
  key('ArrowUp', { metaKey: true }); const up = Object.assign({}, App.tab.sel);
  key('ArrowUp', { metaKey: true }); const up2 = Object.assign({}, App.tab.sel);
  log.push('band above: ' + JSON.stringify(up) + ' then ' + JSON.stringify(up2) + ' (touching: ' + (up.y + up.h === 200 && up2.y + up2.h === up.y) + ', last one is the leftover ' + up2.h + 'px)');
  key('ArrowUp', { metaKey: true }); log.push('at the top stays: y=' + App.tab.sel.y);
  Visual.setSelection({ x: 10, y: 100, w: 50, h: 40 });
  key('ArrowDown', { metaKey: true }); log.push('band below: ' + JSON.stringify(App.tab.sel));
  key('ArrowRight', { metaKey: true }); log.push('band right: ' + JSON.stringify(App.tab.sel));
  key('ArrowLeft', { metaKey: true }); key('ArrowLeft', { metaKey: true });
  log.push('band left twice: ' + JSON.stringify(App.tab.sel));
  Visual.setSelection({ x: 10, y: 100, w: 50, h: 40 });
  key('ArrowDown'); key('ArrowDown'); key('ArrowRight', { shiftKey: true });
  log.push('nudge: ' + JSON.stringify(App.tab.sel));
  Visual.setSelection({ x: 0, y: H - 30, w: W, h: 30 }); key('ArrowDown', { metaKey: true }); log.push('at the bottom stays: y=' + App.tab.sel.y);
  // with a tool open the panel offers the buttons
  Visual.setSelection({ x: 0, y: 150, w: W, h: 60 }); Tools.select('slide'); await wait(300);
  log.push('band buttons in the panel: ' + !!$('#tBandUp') + '/' + !!$('#tBandDown'));
  $('#tBandUp').click(); await wait(200); log.push('button selects band above: y=' + App.tab.sel.y + ' h=' + App.tab.sel.h + ' preview pending: ' + !!App.tab.pending);
  Tools.deselect(); Visual.setSelection(null);
}

// ---- shortcuts + tour
Tour.showKeys(); await wait(200); await shot('76-shortcuts'); $('#mOk').click(); await wait(100);
try { localStorage.removeItem('ib.tour'); } catch (e) {}
Tour.start(); await wait(300);
for (let i = 0; i < Tour.STEPS.length; i++) { await shot('77-tour-' + i); Tour.go(i + 1); await wait(150); if (i >= Tour.STEPS.length - 1) break; }
log.push('tour open: ' + !!Tour.el); Tour.end(); log.push('tour closed: ' + !Tour.el);
try { localStorage.setItem('ib.tour', '1'); } catch (e) {}
return { log, errors };
