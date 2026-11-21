"""Cross-check: does our preview match what a real decoder (Pillow) shows for the exported file?"""
import json, sys
import numpy as np
from PIL import Image, ImageFile
ImageFile.LOAD_TRUNCATED_IMAGES = True

man = json.load(open(sys.argv[1]))
mism, ok, openfail, notes = 0, 0, 0, []
for e in man:
    try:
        im = Image.open(e['file']); im.load()
    except Exception as ex:
        if e['cmp'] == 'open' and e['file'].endswith('.gif'):
            notes.append(f"info: PIL could not decode corrupted GIF {e['tag']}: {str(ex)[:60]}")
            openfail += 1
            continue
        print('FAIL cannot decode', e['tag'], str(ex)[:100]); mism += 1; continue
    if e['cmp'] == 'open':
        ok += 1
        continue
    ref = np.asarray(im.convert('RGBA'), dtype=np.uint8)
    if im.size != (e['w'], e['h']):
        print('FAIL size', e['tag'], im.size, (e['w'], e['h'])); mism += 1; continue
    ours = np.fromfile(e['rgba'], dtype=np.uint8).reshape(e['h'], e['w'], 4)
    a, b = (ref[..., :3], ours[..., :3]) if e['cmp'] == 'rgb' else (ref, ours)
    # 16-bit sources: PIL reduces precision differently, allow +-1
    tol = 1 if 'rgb16' in e['tag'] else 0
    diff = np.abs(a.astype(int) - b.astype(int)).max() if a.size else 0
    if diff > tol:
        n = int((np.abs(a.astype(int) - b.astype(int)).max(axis=-1) > tol).sum())
        print('FAIL pixels differ', e['tag'], 'max diff', diff, 'pixels', n); mism += 1
    else:
        ok += 1
for n in notes[:6]: print(n)
print(f'decoder cross-check: {ok} files agree with Pillow, {mism} mismatches, {openfail} gif decode refusals')
