# 테스트용 합성 사진 생성 (numpy/PIL) → tests/fixtures/*.jpg
import numpy as np
from PIL import Image, ImageFilter
rng = np.random.default_rng(7)

def fbm2(w, h, octaves, seed, base):
    r = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32); amp = 1.0; tot = 0
    for o in range(octaves):
        n = base * 2**o
        g = r.random((max(2, int(n*h/w))+1, n+1)).astype(np.float32)
        img = Image.fromarray((g*255).astype(np.uint8)).resize((w, h), Image.BICUBIC)
        out += amp * (np.asarray(img, np.float32)/255); tot += amp; amp *= 0.5
    return out / tot

def ridge(w, seed, rough=0.55, scale=1.0):
    r = np.random.default_rng(seed)
    n = 1
    pts = np.array([0.5, 0.5])
    amp = 0.5 * scale
    for _ in range(12):
        mid = (pts[:-1] + pts[1:]) / 2 + (r.random(len(pts)-1) - 0.5) * amp
        new = np.empty(len(pts)*2-1); new[0::2] = pts; new[1::2] = mid
        pts = new; amp *= rough
    return np.interp(np.linspace(0, 1, w), np.linspace(0, 1, len(pts)), pts)

W, H = 2000, 1500
y = np.linspace(0, 1, H)[:, None]; x = np.linspace(0, 1, W)[None, :]
top = np.array([40, 70, 140], np.float32); mid = np.array([240, 150, 110], np.float32); low = np.array([255, 205, 150], np.float32)
t = np.clip(y/0.62, 0, 1)[..., None]
sky = np.where(t < 0.55, top + (mid-top)*(t/0.55), mid + (low-mid)*((t-0.55)/0.45))
sky = np.broadcast_to(sky, (H, W, 3)).copy()
c = fbm2(W, H, 7, 3, 3); cl = np.clip((c-0.48)*3.4, 0, 1)[..., None] * (1-np.clip(y/0.6, 0, 1))[..., None]
sky = sky*(1-cl*0.6) + np.array([255, 225, 200], np.float32)*cl*0.6
d = np.sqrt(((x-0.68)*1.33)**2 + (y-0.52)**2)
sky += np.exp(-(d/0.05)**2)[..., None]*np.array([255, 240, 200]) + np.exp(-(d/0.25)**2)[..., None]*np.array([90, 50, 20])
img = sky
tex = fbm2(W, H, 8, 21, 40)
for (base_y, amp, col, seed) in [(0.50, 0.22, (110, 85, 125), 11), (0.58, 0.18, (70, 60, 95), 12), (0.66, 0.12, (32, 34, 56), 13)]:
    rg = base_y - amp*(ridge(W, seed) - 0.5)
    m = (y > rg[None, :]).astype(np.float32)[..., None]
    fog = np.clip((y - base_y)/0.25, 0, 1)[..., None]
    colr = np.array(col, np.float32)*(1-0.25*(1-fog)) + 40*(1-fog)
    colr = colr * (0.75 + 0.5*tex[..., None])
    img = img*(1-m) + colr*m
lake_y = 0.78
mask = (y > lake_y).astype(np.float32)[..., None]
refl = np.roll(img[::-1, :, :], int(H*(1-2*lake_y)), axis=0)
ripple = (fbm2(W, H, 6, 5, 8)-0.5)*26
sunrefl = np.exp(-(((x-0.68)/0.04)**2))*np.clip(1-(y-lake_y)/0.22, 0, 1)*(0.6+0.4*np.sin(y*900))
refl = refl*0.5 + np.array([18, 36, 66])*0.5 + ripple[..., None] + (sunrefl[..., None]*np.array([200, 150, 90]))
img = img*(1-mask) + refl*mask
for px, ph, pw in [(0.12, 0.38, 0.02), (0.88, 0.32, 0.018)]:
    trunk = ((np.abs(x-px) < pw*(1+0.3*np.sin(y*40))) & (y > 1-ph) & (y < 1.0)).astype(np.float32)[..., None]
    img = img*(1-trunk) + np.array([18, 14, 16])*trunk
# 잎사귀 군집
for (cx, cy, r) in [(0.12, 0.62, 0.09), (0.88, 0.68, 0.08)]:
    dd = np.sqrt(((x-cx)*1.33)**2 + (y-cy)**2)
    leaf = (dd < r*(0.8+0.4*tex)).astype(np.float32)[..., None]
    img = img*(1-leaf*0.95) + np.array([14, 22, 18])*leaf*0.95*(0.6+0.8*tex[..., None])
img += rng.normal(0, 4.0, img.shape)
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.5)).save('fixtures/landscape.jpg', quality=92)

W2, H2 = 1200, 1600
yy = np.linspace(0, 1, H2)[:, None]; xx = np.linspace(0, 1, W2)[None, :]
bg = np.stack([70 + 50*xx*np.ones_like(yy), 100 + 40*yy*np.ones_like(xx), 130 + 40*(1-xx)*np.ones_like(yy)], -1)
bg = bg * (0.8 + 0.4*fbm2(W2, H2, 6, 9, 5)[..., None])
face = np.exp(-(((xx-0.5)/0.22)**2 + ((yy-0.42)/0.17)**2)**1.5)[..., None]
skin = np.array([226, 176, 150]) * (0.93 + 0.12*fbm2(W2, H2, 5, 14, 12)[..., None])
img2 = bg*(1-face) + skin*face
eyes = (np.exp(-(((xx-0.43)/0.025)**2+((yy-0.40)/0.012)**2)) + np.exp(-(((xx-0.57)/0.025)**2+((yy-0.40)/0.012)**2)))[..., None]
img2 = img2*(1-eyes*0.85) + np.array([40, 30, 30])*eyes*0.85
mouth = np.exp(-(((xx-0.5)/0.06)**2+((yy-0.52)/0.012)**2))[..., None]
img2 = img2*(1-mouth*0.7) + np.array([170, 70, 80])*mouth*0.7
# 흉터/점 (지우개 테스트용)
for (cx, cy) in [(0.58, 0.46), (0.42, 0.34)]:
    dd = np.sqrt(((xx-cx)*1.33)**2 + (yy-cy)**2)
    img2 = img2*(1-np.exp(-(dd/0.01)**2)[..., None]*0.8) + np.array([90, 50, 40])*np.exp(-(dd/0.01)**2)[..., None]*0.8
img2 += rng.normal(0, 4.0, img2.shape)
Image.fromarray(np.clip(img2, 0, 255).astype(np.uint8)).save('fixtures/portrait.jpg', quality=90)
print('fixtures ok')
