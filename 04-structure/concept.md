# Step 4 · Concept

8 sketches of the main screen: export to `img/sketches.png`.

## Chosen concept
Image Bender is a Mac app that lets you change the data inside an image file on purpose, without breaking the file. You can corrupt and damage a picture in an artistic way and still get a file that opens.

It has three ways in, so everyone can start where they feel comfortable: one-click recipes for a quick result, tools with plain-language settings for more control, and a hex editor for people who want to edit the bytes themselves. The parts of the file that hold it together (headers, sizes, tables) are locked as safe zones, so the damage only lands where it is safe. Every effect is a mechanical change to the file's bytes. There are no filters and no AI.

The app is built to be friendly and easy to approach. You do not need to know what a hex editor is to use it, and you can always see what changed, undo it and compare with the original. It is for creatives, artists and anyone who wants to experiment with their own images or any images.

This follows my problem hypothesis from Step 1: filter apps feel like presets, and corrupting a file by hand keeps destroying it. Image Bender gives real corruption with the file protected.

## What it does in one flow
1. Open an image (the Open button or dropping a file in).
2. Pick a recipe, or choose a tool and set it up. The picture updates right away.
3. Apply it. Tools that would break the file are switched off for that file and say why.
4. Keep going, undo, redo or hold to compare with the original. The safe zones stay locked the whole time.
5. Export. The corrupted image is saved at its full size and still opens.

## Value proposition
For creatives, artists and anyone who wants to experiment with images who want to damage a picture on purpose without losing the file, Image Bender is a Mac app that corrupts the real data of an image and locks the parts that would break it, so the result always opens. Unlike JPG Glitch, jpeg-butcher and DestroyPix, it protects the file while you corrupt it, keeps the original size and gives you control in plain language.

(I will rewrite the "for who" part with the persona once the interviews are done.)

## Why this concept (evidence)
From my benchmark of three competitors (my own testing):
- Nobody protects the file while you corrupt it. One wrong byte in jpeg-butcher gives a black or gray picture, and JPG Glitch and DestroyPix have nothing like a safe zone.
- There is either too little control or too much. JPG Glitch has four sliders, DestroyPix is a finger on a small screen and jpeg-butcher is raw hex with no explanation.
- Getting the finished file out is unreliable. JPG Glitch exports a smaller image, and jpeg-butcher gave me the original back.
- There is no good Mac option. Two are websites and DestroyPix failed to import an image on my Mac.

From my references: hexglitcher has a "Safe Zone" for the start of the file, which shows that people want this kind of protection.

Interview evidence: to add after the interviews (P-codes).

## What it will not do
1. No AI. There are no AI filters and no AI generation.
2. No video, music or animation.
3. No general photo editing. There is no crop, colour correction or retouching.

