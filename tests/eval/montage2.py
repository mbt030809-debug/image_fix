# 비교 패널(개발 전용): 입력 | 현재 앱(v0) | 새 파이프라인(full) | 정답 — 마스크를 색으로 덮고 윤곽선 표시. python3 montage2.py <맵폴더> <결과폴더> <출력.png> <사진> ...
import sys, numpy as np, cv2
from PIL import Image
maps, out, dst = sys.argv[1:4]; rows = []
for n in sys.argv[4:]:
    w, h = map(int, open(f'{out}/{n}.size').read().split()); im = np.asarray(Image.open(f'{maps}/{n}.png').convert('RGB').resize((w, h)))
    sc = 380 / w; tile = []
    for key, label in (('IN', 'input'), ('v0', 'current app'), ('full', 'new'), ('GT', 'truth/ref')):
        v = im.copy()
        if key != 'IN':
            m = np.fromfile(f'{out}/{n}.{key}.u8', dtype=np.uint8).reshape(h, w) > 0
            col = {'v0': (255, 60, 60), 'full': (40, 220, 90), 'GT': (60, 140, 255)}[key]
            ov = v.astype(np.float32); ov[m] = ov[m] * 0.65 + np.array(col) * 0.35; v = ov.astype(np.uint8)
            cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE); cv2.drawContours(v, cs, -1, col, 2)
        v = cv2.resize(v, (380, int(h * sc))); cv2.putText(v, label if key != 'IN' else n, (6, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 2); tile.append(v)
    rows.append(np.hstack([cv2.copyMakeBorder(t, 0, 0, 0, 4, cv2.BORDER_CONSTANT) for t in tile]))
ww = max(r.shape[1] for r in rows)
Image.fromarray(np.vstack([cv2.copyMakeBorder(r, 0, 4, 0, ww - r.shape[1], cv2.BORDER_CONSTANT) for r in rows])).save(dst)
