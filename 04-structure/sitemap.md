# Step 4 · Sitemap and flow

Sitemap, user flow (with all states) and grey wireframes live in Figma; export screenshots to `img/`.

This sitemap is taken from the finished app (menus, panels and tool groups read from the app itself), not from a plan.

## Navigation type
Image Bender is one workspace, not a set of pages. The left panel picks what to do, the centre shows the picture, and the right panel holds the settings. Three tabs on the right (Tool, History, Macros) and a Visual / Hex switch at the top change what you see. Dialogs open on top of the workspace and close back to it. Several images can be open at once as tabs along the top.

## Sitemap
- Start screen (no image open)
  - Open an image, or drop one in
  - Take the tour
  - Keyboard shortcuts
- Workspace (an image is open)
  - Top bar
    - Image tabs (one per open image)
    - Open…
    - Convert menu: Copy as BMP, TIFF, PPM, PNG, GIF, WebP · Bake into a new JPEG · JPEG made of blocks · Generation loss
    - Undo and Redo
    - Visual / Hex switch
    - Hold to compare
    - Split view
    - Export menu: Save file · Save picture as PNG, JPEG, WebP
  - Left panel: what to do
    - One-click recipes (Stutter, Torn ledges, Acid colours, Scanner failure, Shattered, Melt, Bit rot, Collapse) and Surprise me
    - Your recipes (files from the recipes folder; Open folder, Add file…)
    - Tools in groups (the tools a file cannot use move to a folded group called Not for this file)
      - Move: Duplicate & stamp, Slide rows, Diagonal shear, Mirror & flip, Wrong width, Copy a chunk, Cut or insert bytes
      - Colour: Colour split, Swap & invert colours, Shift palette, Pixel sort, Crush values, JPEG detail tables
      - Destroy: Pixel smear, Shatter, Byte noise, Fill, PNG row filters, Tweak bytes, Scatter chunks
      - JPEG: Shuffle JPEG blocks, JPEG colour detail
      - Mix: Mix with another image
      - Bytes: Corrupt compression
      - File structure: PNG chunks, Edit header
      - Not for this file: the tools above that do not work with the open file, each with the reason
  - Centre: the picture
    - Visual view: the picture, zoom (−, +, Fit), drag to choose an area, original / edited split
    - Hex view: Go to…, Find…, columns and grouping, Copy / Paste, Bookmarks, fill / zero / random / invert / revert / ±1 on selected bytes, byte inspector
    - File map: which parts of the file are safe to edit, locked, or already changed by you
  - Right panel: settings
    - Tool tab: the chosen tool's settings, Fine control (Strength, Coverage), Apply and Cancel
    - History tab: every step, jump back to any of them, Back to original
    - Macros tab: save the history as a macro, run it here, run it on a folder, make variations, share to recipes, export, import, rename, delete
  - Status bar: messages (Ready, what just happened) and file details
- Dialogs and menus
  - Open as raw pixels
  - Not a picture Image Bender knows
  - Generation loss, JPEG made of blocks, Bake into a JPEG, Copy as WebP
  - Save macro, Rename macro, Delete macro
  - Run a macro on a folder, Variations
  - Close without saving?
  - Keyboard shortcuts
  - Welcome tour (7 steps: recipes and tools, choosing an area, settings, History and Macros, Visual or Hex, compare, export)
- Mac menu bar: File (Open, Open as Raw Pixels, Save File, Close Tab) · Edit (Undo, Redo, Cut, Copy, Paste, Find, Go to Offset) · View (Visual Mode, Hex Mode, zoom) · Window · Help (Keyboard Shortcuts, Welcome Tour, Open Recipes Folder)

## Main user flow (start to goal)
Goal: corrupt one image and export it so it still opens.

1. Start screen: press Open an image, or drop a file in. The workspace opens with the picture.
2. Left panel: press a one-click recipe, or choose a tool. The picture changes right away as a preview.
3. Right panel: adjust the settings (and Fine control if the effect is too strong). Optionally drag a box on the picture to limit the effect to one area.
4. Press Apply (or Enter) to keep it. The step is added to History.
5. Not happy? Undo, or jump back in History. Hold to compare or Split view to look at the original.
6. Repeat steps 2 to 5 as often as you like. The locked parts of the file stay protected the whole time.
7. Press Export and choose Save file. The corrupted image is saved and still opens.

## States to cover
Empty · loading · error · success · long content

| State | Where it shows in the app |
|---|---|
| Empty | Start screen with no image. The right panel says to open an image first. Your recipes says the recipes folder is empty. |
| Loading | A "Rendering…" label over the picture while a recipe, preview or large file is being worked on |
| Error | A tool the file cannot use stays in "Not for this file" and says why when pressed. A file that is not a picture asks what to do. A failed recipe or an edit that breaks the file shows a message. |
| Success | A message after a recipe, a macro, a saved file or an exported picture, and the status bar says what just happened |
| Long content | The History list on a long session, a long list of macros, the hex view on a large file, and the tool groups, which fold to keep the list short |
