# Step 2 · Benchmark

Main task, phrased as a goal: I want to corrupt an image and export it so that it still opens.

I tested three competitors on the same task with the same criteria. I counted every click from the first screen to the finished export and took a screenshot of each step (`img/`).

## Comparison table

| Criterion | 1. JPG Glitch (web) | 2. jpeg-butcher (web) | 3. DestroyPix (iPhone app) |
|---|---|---|---|
| Steps from start to goal | 4: press Open, choose an image, move the sliders, export from the menu bar | | |
| 3 things that work | 1. Opening an image is one button<br>2. The corruption is real and the exported file still opens<br>3. Export is a plain download from the menu bar | 1. <br>2. <br>3. | 1. <br>2. <br>3. |
| 3 things that fail | 1. It scales the image down (Image Bender keeps the original size)<br>2. Only four sliders, so you cannot choose the direction of the corruption<br>3. No new commit in about 8 years, so it is not maintained | 1. <br>2. <br>3. | 1. <br>2. <br>3. |
| 2 quotes from 1- and 2-star reviews | "" <br>"" | "" <br>"" | "" <br>"" |

## Screenshots
- JPG Glitch: `img/jpg-glitch-01.png`, `img/jpg-glitch-02.png` ...
- jpeg-butcher: `img/jpeg-butcher-01.png` ...
- DestroyPix: `img/destroypix-01.png` ...

## Patterns to reuse
- 

## Gaps nobody solves
- 

## AI use
Claude helped set up this table. I did the testing, counted the steps and wrote the findings myself.
