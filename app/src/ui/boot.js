/* Wire everything together once the DOM is ready. */
(function () {
  Visual.init(); Hex.init(); Panels.init(); Recipes.init();

  // ---- toolbar buttons
  $('#btnOpen').onclick = () => App.openDialog();
  $('#emptyOpen').onclick = () => App.openDialog();
  $('#btnUndo').onclick = () => App.undo();
  $('#btnRedo').onclick = () => App.redo();
  $$('#modeSeg button').forEach((b) => (b.onclick = () => App.setMode(b.dataset.mode)));
  $('#notesX').onclick = () => { const t = App.tab; if (!t) return; t.notesSeen = new Set(t.doc.notes); App.chrome(); };
  $('#btnSplit').onclick = () => { if (App.tab) Visual.setSplit(!Visual.split.on); };
  $('#emptyTour').onclick = (e) => { e.preventDefault(); try { localStorage.removeItem('ib.tour'); } catch (x) { /* ignore */ } App.status('The tour starts when you open a picture.'); };
  $('#emptyKeys').onclick = (e) => { e.preventDefault(); Tour.showKeys(); };
  const cmp = $('#btnCompare');
  cmp.onmousedown = () => Visual.showCompare();
  window.addEventListener('mouseup', () => Visual.hideCompare());

  // ---- popover menus
  const menus = [['#btnConvert', '#convertMenu'], ['#btnExport', '#exportMenu']];
  for (const [b, m] of menus) {
    $(b).onclick = (e) => { e.stopPropagation(); const open = $(m).classList.contains('open'); $$('.menu').forEach((x) => x.classList.remove('open')); if (!open) $(m).classList.add('open'); };
  }
  document.addEventListener('click', () => $$('.menu').forEach((x) => x.classList.remove('open')));
  $('#convertMenu').onclick = (e) => { const b = e.target.closest('button'); if (b) App.convert(b.dataset.conv); };
  $('#exportMenu').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.exp === 'file') App.exportFile(); else App.exportPicture(b.dataset.exp); };

  // ---- file map
  const mp = $('#mapcv');
  mp.addEventListener('mousemove', FileMap.hover);
  mp.addEventListener('mouseleave', () => FileMap.draw());
  mp.addEventListener('click', FileMap.click);

  // ---- drag & drop
  const empty = $('#empty');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((ev) => window.addEventListener(ev, (e) => { stop(e); empty.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => window.addEventListener(ev, (e) => { stop(e); empty.classList.remove('over'); }));
  window.addEventListener('drop', async (e) => {
    for (const f of e.dataTransfer.files) {
      const data = new Uint8Array(await f.arrayBuffer());
      if (/\.json$/i.test(f.name)) { await Recipes.addBytes(f.name, data); continue; } // a dropped recipe file
      await App.openBytes(data, f.name, window.api.pathForFile(f));
    }
  });

  // ---- native menu commands
  const inText = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' && !['range', 'checkbox', 'color'].includes(a.type) || a.tagName === 'TEXTAREA'); };
  window.api.onMenu((cmd) => {
    switch (cmd) {
      case 'open': return App.openDialog();
      case 'export-file': return App.exportFile();
      case 'close-tab': return App.closeTab();
      case 'undo': return inText() ? document.execCommand('undo') : App.undo();
      case 'redo': return inText() ? document.execCommand('redo') : App.redo();
      case 'goto': return Hex.goto();
      case 'find': return App.tab && Hex.openFind();
      case 'mode-visual': return App.tab && App.setMode('visual');
      case 'mode-hex': return App.tab && App.setMode('hex');
      case 'zoom-in': return Visual.setZoom(Visual.zoom() * 1.25);
      case 'zoom-out': return Visual.setZoom(Visual.zoom() / 1.25);
      case 'zoom-fit': return Visual.fit();
      case 'open-raw': return App.openRawDialog();
      case 'shortcuts': return Tour.showKeys();
      case 'tour': return Tour.start();
    }
  });
  window.api.onOpenPath(async (p) => { const f = await window.api.readFile(p); App.openFiles([f]); });

  // ---- copy / paste of bytes in hex mode (native Edit-menu roles fire these events)
  document.addEventListener('copy', (e) => { if (App.mode === 'hex' && App.tab && document.activeElement === Hex.body) Hex.onCopy(e); });
  document.addEventListener('paste', (e) => { if (App.mode === 'hex' && App.tab && document.activeElement === Hex.body) Hex.onPaste(e); });

  // ---- keyboard
  document.addEventListener('keydown', (e) => {
    if ($('#modal').classList.contains('open')) return;
    const typing = inText();
    if (e.key === '\\' && !typing && App.tab) { Visual.showCompare(); return; }
    if (!typing && App.tab && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if ((e.key === 'c' || e.key === 'C') && App.mode === 'visual') { e.preventDefault(); Visual.setSplit(!Visual.split.on); return; }
    }
    // selection by keyboard: ⌘ + arrows = the band right next to the selection; plain arrows = nudge it (⇧ = 10 px)
    if (App.tab && App.tab.sel && App.mode === 'visual' && e.key.startsWith('Arrow') && !e.altKey && !e.ctrlKey && document.activeElement !== Hex.body) {
      const a = document.activeElement, form = a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.tagName === 'INPUT' && !['checkbox', 'color', 'button'].includes(a.type));
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
      if (e.metaKey && !e.shiftKey && !(a && a.tagName === 'TEXTAREA' || a && a.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(a.type))) { e.preventDefault(); e.stopPropagation(); Visual.nextBand(dir); return; }
      if (!e.metaKey && !form && true) {
        const n = e.shiftKey ? 10 : 1; e.preventDefault();
        Visual.nudgeSel(dir === 'left' ? -n : dir === 'right' ? n : 0, dir === 'up' ? -n : dir === 'down' ? n : 0); return;
      }
    }
    if (e.key === 'Escape' && !typing) {
      const t = App.tab; if (!t) return;
      if (t.pending) { App.clearPending(); Tools.afterCancel(); }
      else if (t.tool) Tools.deselect();
      else if (t.sel) Visual.setSelection(null);
      return;
    }
    if (e.key === 'Enter' && !typing && App.tab && App.tab.pending && document.activeElement !== Hex.body) { e.preventDefault(); Tools.apply(); }
  });
  document.addEventListener('keyup', (e) => { if (e.key === '\\') Visual.hideCompare(); });

  App.chrome();
  App.status('Ready. Drop an image to begin.');
})();
