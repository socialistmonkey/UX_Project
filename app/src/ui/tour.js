/* Keyboard shortcuts sheet and the short first-run tour. */
const Tour = {
  i: 0, steps: null, el: null,

  KEYS: [
    ['Files', [['Open…', '⌘O'], ['Open any file as raw pixels…', '⇧⌘O'], ['Save file', '⌘S'], ['Close tab', '⌘W']]],
    ['Editing', [['Undo / Redo', '⌘Z · ⇧⌘Z'], ['Apply the previewed tool', 'Enter'], ['Cancel the preview / drop selection', 'Esc'], ['Tiny steps on a slider', '⌥ + arrows'], ['Select the band above / below (same size)', '⌘↑ · ⌘↓'], ['Select the band left / right', '⌘← · ⌘→'], ['Nudge the selection 1 px (10 with ⇧)', 'arrow keys']]],
    ['Looking', [['Hold to see the original', '\\'], ['Split view (original | edited)', 'C'], ['Visual / Hex mode', '⌘1 · ⌘2'], ['Zoom in / out / fit', '⌘= · ⌘- · ⌘0'], ['Zoom with the trackpad', '⌘ + scroll']]],
    ['Hex', [['Find and replace', '⌘F'], ['Go to offset, row or pixel', '⌘G'], ['Overwrite a byte', 'type hex digits'], ['Select a range', 'shift + click / drag']]],
    ['Help', [['This sheet', '⌘/'], ['Welcome tour', 'Help menu']]],
  ],

  showKeys() {
    let h = '<div class="keys">';
    for (const [g, list] of Tour.KEYS) {
      h += `<h4>${g}</h4>`;
      for (const [a, k] of list) h += `<div><span>${esc(a)}</span><kbd>${esc(k)}</kbd></div>`;
    }
    h += '</div>';
    const m = $('#modal');
    m.innerHTML = `<div class="box wide"><h3>Keyboard shortcuts</h3>${h}<div class="btnrow"><button id="mOk" class="primary">Close</button></div></div>`;
    m.classList.add('open');
    const done = () => { m.classList.remove('open'); m.innerHTML = ''; document.removeEventListener('keydown', key, true); };
    const key = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); done(); } e.stopPropagation(); };
    document.addEventListener('keydown', key, true);
    $('#mOk').onclick = done; $('#mOk').focus();
  },

  // ------------------------------------------------------------------ tour
  STEPS: [
    { sel: '#left', h: 'Start with a recipe or a tool', p: 'One-click recipes break the picture in a known style. Tools below them do one thing each, with every setting visible. Press a recipe twice for a new roll of the dice. Tools this file can’t use are folded under “Not for this file”.' },
    { sel: '#visual', h: 'Drag to choose where', p: 'Draw a box on the picture to limit a tool to that area. With nothing selected most tools use the whole image. Changes preview live; Enter keeps them.' },
    { sel: '#rbody', h: 'Settings, and “Fine control”', p: 'Each tool shows its settings here. If an effect is too much, open Fine control and lower Strength or Coverage.' },
    { sel: '#rtabs', h: 'History and Macros live here', p: 'History shows every step and lets you jump back to any of them. Macros turn those steps into something you can replay on other images, whole folders, or share as a recipe.' },
    { sel: '#modeSeg', h: 'Visual or Hex', p: 'Hex shows the raw bytes. Locked ones (headers, sizes) are greyed out so the file can’t be broken by accident.' },
    { sel: '#btnSplit', h: 'Compare as you go', p: 'Split view puts the original on the left of a slider and your edit on the right. Hold the \\ key for a quick flash of the original.' },
    { sel: '#btnExport', h: 'Save it', p: 'Save the file in its own format, or export a picture. Help → Keyboard Shortcuts lists everything else.' },
  ],

  seen() { try { return !!localStorage.getItem('ib.tour'); } catch (e) { return false; } },
  mark() { try { localStorage.setItem('ib.tour', '1'); } catch (e) { /* ignore */ } },
  maybeStart() { if (!Tour.seen() && App.tab && !Tour.el) setTimeout(() => { if (!Tour.seen() && App.tab && !Tour.el) Tour.start(); }, 600); },

  start() {
    if (Tour.el) return;
    if (!App.tab) { App.toast('Open a picture first, then the tour can point at things.'); return; }
    Tour.mark();
    Tour.i = 0;
    const el = Tour.el = document.createElement('div');
    el.id = 'tour'; el.className = 'open';
    el.innerHTML = '<div class="hole"></div><div class="card"><h3></h3><p></p><div class="row"><span class="n"></span><button id="tkSkip">Skip</button><button id="tkBack">Back</button><button id="tkNext" class="primary">Next</button></div></div>';
    document.body.appendChild(el);
    $('#tkSkip', el).onclick = Tour.end;
    $('#tkBack', el).onclick = () => Tour.go(Tour.i - 1);
    $('#tkNext', el).onclick = () => (Tour.i >= Tour.STEPS.length - 1 ? Tour.end() : Tour.go(Tour.i + 1));
    Tour.key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); Tour.end(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); $('#tkNext', el).click(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); $('#tkBack', el).click(); }
      e.stopPropagation();
    };
    document.addEventListener('keydown', Tour.key, true);
    window.addEventListener('resize', Tour.place);
    Tour.go(0);
  },
  end() {
    if (!Tour.el) return;
    document.removeEventListener('keydown', Tour.key, true); window.removeEventListener('resize', Tour.place);
    Tour.el.remove(); Tour.el = null;
  },
  go(i) {
    if (!Tour.el) return;
    Tour.i = DB.clamp(i, 0, Tour.STEPS.length - 1);
    const s = Tour.STEPS[Tour.i];
    $('h3', Tour.el).textContent = s.h; $('p', Tour.el).textContent = s.p;
    $('.n', Tour.el).textContent = `${Tour.i + 1} / ${Tour.STEPS.length}`;
    $('#tkBack', Tour.el).style.visibility = Tour.i ? 'visible' : 'hidden';
    $('#tkNext', Tour.el).textContent = Tour.i === Tour.STEPS.length - 1 ? 'Done' : 'Next';
    if (s.sel === '#rbody' && App.rtab !== 'tool') Panels.setTab('tool');
    Tour.place();
  },
  place() {
    if (!Tour.el) return;
    const s = Tour.STEPS[Tour.i], t = $(s.sel), hole = $('.hole', Tour.el), card = $('.card', Tour.el);
    const W = window.innerWidth, H = window.innerHeight;
    let r = t && t.getBoundingClientRect();
    if (!r || !r.width) r = { left: W / 2 - 100, top: H / 2 - 40, width: 200, height: 80, right: W / 2 + 100, bottom: H / 2 + 40 };
    const pad = 4;
    Object.assign(hole.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    const cw = 320, ch = card.offsetHeight || 150;
    let x = r.right + 14, y = r.top;
    if (x + cw > W - 10) x = r.left - cw - 14;
    if (r.width > W * 0.4 && r.height > H * 0.4) { x = r.left + (r.width - cw) / 2; y = r.top + 40; }
    else if (x < 10) { x = DB.clamp(r.left, 10, W - cw - 10); y = r.bottom + 14; if (y + ch > H - 10) y = Math.max(10, r.top - ch - 14); }
    y = DB.clamp(y, 10, Math.max(10, H - ch - 10));
    Object.assign(card.style, { left: x + 'px', top: y + 'px' });
  },
};
