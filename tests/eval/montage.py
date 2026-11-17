# 평가 결과 시각화(개발 전용): 윤곽선을 사진 위에 겹쳐 비교 패널로 저장. python3 montage.py <맵폴더> <결과폴더> <출력.png> <사진:x0,y0,x1,y1(비율)> ...
import sys, numpy as np, cv2
from PIL import Image, ImageDraw
maps, out, dst = sys.argv[1:4]; specs = sys.argv[4:]
panels = []
for sp in specs:
    n, box = sp.split(':'); fx0, fy0, fx1, fy1 = map(float, box.split(','))
    w, h = map(int, open(f'{out}/{n}.size').read().split()); im = np.asarray(Image.open(f'{maps}/{n}.png').convert('RGB').resize((w, h)))
    def cont(key, color):
        m = np.fromfile(f'{out}/{n}.{key}.u8', dtype=np.uint8).reshape(h, w); cs, _ = cv2.findContours((m > 0).astype(np.uint8), cv2.RETR_LIST, cv2.CHAIN_APPROX_NONE); return cs, color
    row = []
    for keys in (('GT',), ('v0',), ('full',)):
        v = im.copy(); big = 3
        v = cv2.resize(v, (w * big, h * big), interpolation=cv2.INTER_CUBIC)
        for key, col in ((keys[0], (255, 40, 40)),):
            cs, _ = cont(key, col); cv2.drawContours(v, [c * big for c in cs], -1, col, 2)
        x0, y0, x1, y1 = int(fx0 * w * big), int(fy0 * h * big), int(fx1 * w * big), int(fy1 * h * big)
        c = v[y0:y1, x0:x1]; c = cv2.resize(c, (360, int(360 * c.shape[0] / c.shape[1])))
        cv2.putText(c, {'GT': 'reference(isnet)', 'v0': 'current app', 'full': 'new pipeline'}[keys[0]], (6, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        row.append(c)
    hh = max(r.shape[0] for r in row); row = [cv2.copyMakeBorder(r, 0, hh - r.shape[0], 0, 6, cv2.BORDER_CONSTANT) for r in row]
    panels.append(np.hstack(row))
ww = max(p.shape[1] for p in panels); panels = [cv2.copyMakeBorder(p, 0, 6, 0, ww - p.shape[1], cv2.BORDER_CONSTANT) for p in panels]
Image.fromarray(np.vstack(panels)).save(dst)
