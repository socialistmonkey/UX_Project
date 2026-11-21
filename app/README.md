# Image Bender

Corrupt images by hand without breaking the file. Every mechanical way of breaking an image in one app, with the dangerous bytes locked so the result always opens. No AI, just bytes.

Formats: **BMP, TIFF, PNG, JPEG, GIF, WebP, ICO, PPM/PGM**, plus **any file at all as raw pixels**. An animated GIF opens as its first picture. AVIF and anything else the system can decode is converted to BMP when you open it.


> **Project version.** This copy of Image Bender was prepared for the METU course *Design your own app* (UX Design Studies I). The video studio, the animation (Frames) feature, the music features (music-reactive tools) and everything that needed ffmpeg were removed on purpose to keep the project simple. Image corruption, the hex editor, safe zones, recipes, macros and converting between image formats are unchanged. The full app lives in the original `imagebender` folder.

## Why this exists

I make glitch and corruption art, and I started out doing it the manual way: changing the data inside an image file and seeing what comes out. It was slow and frustrating. Every few edits the file broke so badly that it would not open any more, and all the work up to that point was lost. Because the damage landed in the file's header or structure as often as in the picture itself, I spent more time fixing and re-saving files than making anything.

The tools I tried did not fix this. Hex Fiend, the hex editor I used on the Mac, is simple but has few features. The advanced hex editors have plenty of features, but they are complicated and built for reverse engineering, not for making images.

Image Bender is the tool I wanted. The dangerous parts of a file (headers, sizes, tables) are locked, so everything you can edit is safe to edit and the result always opens. Inside those limits the changes are as random and destructive as you like, so you get unexpected results without breaking the file. Nothing is hidden behind AI or presets; every effect is a plain change to the bytes, and you can see them in the hex editor next to the picture.

### The Audacity trick, built in

A well-known databending method is to import an image into Audacity as raw data and process it like a sound recording: echo, reverse, distortion, speed changes. The audio editor treats the picture's bytes as 8-bit samples, and the sound effects become visual glitches. It produces great results, but it is awkward to set up, and the file often breaks on the way back.

Image Bender has this method inside it, in the **Audio** group of tools: **Echo**, **Reverse**, **Amplify and distort**, **Change speed**, **Tremolo** and **Sample hold**. You do not need to import or export anything through Audacity, you see the picture change as you adjust the sliders, and the safe zones keep the file valid.

## Download

Go to the [latest release](../../releases/latest) and download the DMG for your Mac:

- `Image-Bender-x.y.z-arm64.dmg` (Apple Silicon: M1, M2, M3, M4). Intel Macs are no longer built.

Open the DMG, drag Image Bender into Applications.


The app isn't notarized by Apple (that costs $99/year), so the first time you open it macOS will complain. Do this once:

1. Right-click (or Control-click) Image Bender in Applications and choose **Open**, then **Open** again.
2. If macOS says the app is "damaged" instead, open Terminal and run: `xattr -cr /Applications/Image\ Bender.app` then open it again.

## Run from source

You need Node.js 18+ (https://nodejs.org). In Terminal, inside this folder:

    npm install
    npm start

To build the app yourself:

    npm run dist:dmg        # -> dist/Image-Bender-<version>-arm64.dmg
    npm run dist            # just the .app folder, no dmg

## Releasing (for maintainers)

Pushing a version tag builds the Apple Silicon DMG on GitHub (an `macos-14` runner) and attaches them to a Release:

    npm version patch        # or edit "version" in package.json
    git push --follow-tags

(`npm version` makes the `v1.0.1` style tag; the workflow is `.github/workflows/release.yml`.)

Builds are ad-hoc signed, so they run on Apple Silicon after the steps above. For a warning-free install you need an Apple Developer account: set `mac.identity` in package.json to your Developer ID, remove the `afterPack` line, and add notarization.

There is no app icon yet. Put a 1024×1024 `icon.png` in a `build/` folder, then add `"icon": "build/icon.png"` under `build.mac` in package.json.

The name shown to users is `productName` in package.json (and the About panel in main.js). Replace `YOUR-USERNAME` in the `repository` field of package.json with your GitHub name.

## How it works

Two modes, switch with the Visual / Hex buttons (⌘1 / ⌘2):

- **Visual**: drag on the picture to select an area, pick a recipe or a tool, watch it live, press Apply (Enter).
- **Hex**: the raw bytes, for editing by hand. See below.

### Compare, and make it gentler

- **Split view** (button, or `C`): the original on the left of a draggable line, your edit on the right. Hold **Hold to compare** (or the `\` key) for a quick flash of the whole original; the split comes back when you let go.
- **Fine control**: every tool that changes pixels has a *Fine control* section with **Strength** (blend each change back toward the original) and **Coverage** (keep only some of the changed spots). Same seed, same result. Click a slider and hold `⌥` with the arrow keys for half-percent steps. The settings are saved in History and macros.

### Tools

Only tools that work on the open file are listed in the groups. Tools that need another file type (a JPEG tool on a PNG, say) wait in a folded **Not for this file** group at the bottom, each with the reason and what to do about it.

| Group | Tools |
| --- | --- |
| Move | Duplicate & stamp, Slide rows, Diagonal shear, Mirror & flip, Wrong width, Copy a chunk, Cut or insert bytes |
| Destroy | Pixel smear, Shatter, Byte noise, Fill, PNG row filters (now also cycle and band patterns, per row), Tweak bytes, Scatter chunks |
| Colour | Colour split, Swap & invert, Shift palette, Pixel sort, Crush values, JPEG detail tables |
| Bits | Bit maths (AND / OR / XOR / NOT, per channel), Shift or rotate bits, Bit layers |
| Bytes | Find and replace (hex or text, `??` wildcards), Compression glitch (damage the compressed stream and decode it anyway: the way real files break) |
| File structure | Edit header (width, height, colour depth, where pixels start, with a safety net), PNG chunks (shuffle, repeat, drop optional chunks, add text, cut the picture data into pieces) |
| Audio | Echo, Reverse, Amplify and distort, Change speed, Tremolo, Sample hold (the Audacity way: the bytes are treated as sound) |
| Layout | Flip byte order, Regroup colour channels, Wrong pixel size (read the same bytes as another layout) |
| Rows | Row tricks (shuffle, reverse, repeat, drop, offset, interlace…) |
| JPEG | Shuffle JPEG blocks, JPEG colour detail |
| Mix | Mix with another image (interleave, blend, bytewise maths between two files) |

Plus one-click recipes (Stutter, Torn ledges, Acid colours, Scanner failure, Shattered, Melt, Surprise me). Every tool has a Seed: same seed = same result, Roll again for new dice.

Tools that rely on a layout are greyed out with a lock icon where the format can't take them safely, and say why on hover.

**Shuffle JPEG blocks** works because the app contains its own JPEG encoder: Convert any image to a JPEG made of blocks (restart markers) and the compressed data splits into independent blocks that can be reordered, repeated, emptied or swapped, always giving a valid picture.

### Header tools, raw files, formats

- **Edit header** rewrites width, height, colour depth (BMP) or where the pixel data starts, directly in the file, so every viewer reads the same bytes differently. The file is re-read after each change and anything that would stop it opening snaps back with a message. This is how you get the wrong-bit-depth looks.
- **Open as Raw Pixels** (⇧⌘O): open any file, an image or not, as raw colour. Pick the width, the pixel layout (grey, RGB, BGR, with padding byte) and how many starting bytes to lock. It saves with the file's own extension and length, so a corrupted `.zip` or `.pdf` stays the same size. Files Image Bender doesn't recognise offer this automatically.
- **WebP** opens as a compressed stream with the container header and the codec header locked. **ICO** (8/24/32-bit or PNG icons; the largest size is edited), **PPM / PGM** (binary P5/P6).

### Recipes you can share

The sidebar has **Your recipes**, loaded from a folder. Drop a recipe file (a macro exported as `.json`) into the folder, or drop it on the window, and it appears in the list. Macros → *To recipes* puts one of yours in the folder. Help → Open Recipes Folder shows where it is. A few starter recipes are included.

### Shortcuts and tour

Help → Keyboard Shortcuts (⌘/) lists everything. A short tour of the window runs the first time you open a picture; Help → Welcome Tour runs it again.

### History, macros, batch

- **History** tab: every step by name. Click a step to go back to exactly how the file looked then. Edit after going back and the later steps are replaced. ⌘Z / ⇧⌘Z still work.
- **Macros** tab: turn your history into a macro. Replay it on this image, on a whole folder (Folder…), or make a set of variations with different seeds (Variations…). Positions are stored as fractions of the picture, so a macro works on any size. Macros can be exported and imported as files. Hex edits can't be replayed and are left out.
- PNG, JPEG, GIF and TIFF results from batches are checked to decode before they're written.

### The hex editor

- Virtual grid, fast on big files. Columns: auto-matched to the image's pixel size, or fixed (8, 16, 32…), grouped by byte, pixel or word. Channels are colour-tinted.
- Click a byte and type hex digits to overwrite, or click in the text column and type letters.
- Selection: click, shift-click, drag. Fill, Zero, Random, Invert, Revert to original, nudge −1 / +1, copy / paste as hex or as text.
- **Find** (⌘F): hex or text, `??` wildcards, match case, previous / next, Replace and Replace all. Matches are highlighted. Locked bytes are skipped.
- **Go to…** understands `row 40`, `pixel 120,80`, `start`, `end` or a hex offset.
- **Inspector**: zone, offset, value in hex / decimal / binary, which pixel and channel the byte belongs to, and number boxes (u8, i8, u16, i16, u32, i32, float, low byte first or high byte first) that you can type into to write values.
- **Bookmarks** to jump back to places.
- Everything you do in Hex is a named step in History and undoable.

### The safe zones

The file map under the picture shows the whole file:

- light grey = safe to edit (pixel data)
- near-black = locked (headers, sizes, metadata, length bytes)
- mid grey = tables you change only through the JPEG detail tables tool
- white ticks = what you changed
- white outline = your selection

**Moving the selection exactly.** With a box or band selected, **⌘↑ / ⌘↓** select the band of the same size directly above or below it (touching, no gap, no overlap; at an edge you get the leftover strip, then a message), **⌘← / ⌘→** do the same sideways. The **↑ Band above / ↓ Band below** buttons in the tool panel do the same. Plain **arrow keys** nudge the selection one pixel (⇧ = 10). The preview follows each move, so you can step down the picture and press Apply or Enter whenever it looks right.

Tools and typing only reach light-grey bytes. In JPEG, edits are also cleaned so a stray marker can't cut the picture short.

| Format | What you edit |
| --- | --- |
| BMP | Pixel bytes. Header locked. Row padding handled. |
| TIFF | Uncompressed pixel strips. Tags locked (strip sizes are recomputed, many files store wrong ones). |
| PNG | The decompressed pixels. The file is re-compressed on export. The scanline filter trick is its own tool. |
| JPEG | The compressed scan data. Detail tables only via the JPEG detail tables tool. |
| GIF | Palette indices, decompressed, re-compressed on export. Animated GIFs open as their first picture. |
| WebP | The compressed picture data. Lossy files survive small edits; lossless ones often stop decoding, and those edits are undone for you. |
| ICO | The pixels of the largest picture. |
| PPM / PGM | The pixels. Header locked. |
| Raw | Every byte after the ones you locked. |

Headers are locked in the normal tools. The **Edit header** tool is the one way to change them on purpose, and it checks the file still opens. Wrong width and Wrong pixel size give similar looks by changing how the pixels are read instead.

## Tests

    npm test            # engine checks

The engine suite runs 4,000+ checks: every tool on every format, locked bytes untouched, undo/redo exact, history jumps, macros, fine control, header edits, (the written GIF compared against Pillow), PNG chunk checksums, raw/ICO/PPM/WebP, recipes, and every exported file opened by Pillow (`pip install pillow`).



## Limits worth knowing

- The header tool on a PNG changes how the pixels are read rather than lying in the IHDR chunk itself (same look as Wrong width).
- WebP lossless breaks easily; edits that stop it decoding are undone. Animated WebP isn't supported, convert it first.
- ICO edits only the largest picture; the other sizes are kept as they are.
- The Mac build is ad-hoc signed, not notarized.
