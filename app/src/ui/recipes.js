/* Shared recipes: macro files in one folder show up in the app. Drop a file in, it appears. */
const Recipes = {
  list: [],

  async init() {
    if (!window.api || !api.recipesList) return;
    api.onRecipesChanged(() => Recipes.load());
    await Recipes.load();
  },
  async load() {
    try { Recipes.list = await api.recipesList(); } catch (e) { Recipes.list = []; }
    if (App.tab) Tools.renderList();
  },

  // markup for the left panel
  html() {
    let h = `<div class="sect cnt">Your recipes<span class="n">${Recipes.list.length}</span></div><div class="recipes user">`;
    if (!Recipes.list.length) h += '<div class="help" style="grid-column:span 2">Recipe files you drop in the recipes folder show up here.</div>';
    Recipes.list.forEach((r, i) => { h += `<button data-urecipe="${i}" title="${esc(r.note || (r.steps.length + ' steps'))}">${esc(r.name)}</button>`; });
    h += '<div class="rbar"><button data-rfolder="1">Open folder</button><button data-radd="1">Add file…</button></div></div>';
    return h;
  },

  async run(i) {
    const r = Recipes.list[i]; if (!r) return;
    await Panels.runMacroOn(r, 'Recipe: ' + r.name);
  },

  // a macro from the Macros tab, saved into the shared folder
  async share(m) {
    const text = JSON.stringify({ format: 'image-bender-macro', version: 1, name: m.name, note: m.note || '', steps: m.steps }, null, 1);
    const out = await api.recipesAdd({ name: m.name.replace(/[^\w-]+/g, '-') + '.json', text });
    if (out) App.toast(`“${m.name}” is now in your recipes folder, ready to share.`, 'good');
    await Recipes.load();
  },

  async addFile() {
    const files = await api.openDialog('json');
    for (const f of files || []) await Recipes.addBytes(f.name, new Uint8Array(f.data));
  },
  async addBytes(name, bytes) {
    try {
      const text = new TextDecoder().decode(bytes), j = JSON.parse(text);
      if (j.format !== 'image-bender-macro' || !Array.isArray(j.steps)) throw new Error('not a recipe file');
      await api.recipesAdd({ name, text });
      App.toast(`Added recipe “${j.name || name}”.`, 'good');
      await Recipes.load();
    } catch (e) { App.toast(`${name} isn't a recipe file (${e.message}).`, 'bad'); }
  },
};
