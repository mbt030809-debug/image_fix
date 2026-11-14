// 효과 레지스트리: 제자리(in-place) 처리. 반경/길이는 이미지 짧은 변(mn) 기준 상대값이라 미리보기=내보내기.
import { clamp, clamp01, lerp, smoothstep, lumaPlane, cloneImg, sampleClamp, mulberry32 } from './util.js';
import { blurRGBA, blurPlaneFast, guidedSmooth, boxMean } from './blur.js';
import { hslToRgb255 } from './develop.js';

const S = (key, ko, en, min, max, def, extra = {}) => ({ key, ko, en, min, max, def, ...extra });
const SEL = (key, ko, en, options, def) => ({ key, ko, en, type: 'select', options, def });

export const EFFECT_CATS = [
  ['blur', '블러·초점'], ['art', '아트'], ['light', '빛'], ['distort', '왜곡'], ['retro', '글리치·레트로'],
];

function defaults(def) {
  const p = {};
  for (const a of def.params) p[a.key] = a.def;
  return p;
}
export function effectDefaults(id) {
  const d = getEffect(id);
  return d ? defaults(d) : {};
}

const screenCh = (a, b) => 255 - ((255 - a) * (255 - b)) / 255;

function remap(img, fn) {
  const { w, h, d } = img;
  const src = new Uint8ClampedArray(d);
  const out = [0, 0, 0, 0], m = [0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      fn(x + 0.5, y + 0.5, m);
      sampleClamp(src, w, h, m[0], m[1], out);
      const j = (y * w + x) * 4;
      d[j] = out[0]; d[j + 1] = out[1]; d[j + 2] = out[2]; d[j + 3] = out[3];
    }
  }
}

function lumaOf(d, j) { return (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255; }

function selectiveBlend(img, blurA, blurB, maskFn) {
  // 마스크 t(0..1): 0=원본, 0.5=블러A, 1=블러B
  const { w, h, d } = img;
  const a = blurA.d ? blurA.d : blurA, b = blurB ? (blurB.d ? blurB.d : blurB) : null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = maskFn(x + 0.5, y + 0.5);
      if (t <= 0) continue;
      const j = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const o = d[j + c];
        if (!b || t < 0.5) d[j + c] = o + (a[j + c] - o) * (b ? t * 2 : t);
        else d[j + c] = a[j + c] + (b[j + c] - a[j + c]) * (t * 2 - 1);
      }
    }
  }
}

export const EFFECTS = [
  // ------------------------------------------------------------ 블러·초점
  {
    id: 'blur', cat: 'blur', ko: '블러', en: 'Blur', icon: 'droplet',
    params: [S('radius', '강도', 'Amount', 0, 100, 30)],
    apply(img, q, c) { const s = (q.radius / 100) * 0.04 * c.mn; if (s >= 0.4) img.d.set(blurRGBA(img, s)); },
  },
  {
    id: 'motion', cat: 'blur', ko: '모션 블러', en: 'Motion blur', icon: 'move',
    params: [S('length', '길이', 'Length', 0, 100, 40), S('angle', '각도', 'Angle', -90, 90, 0)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const L = (q.length / 100) * 0.1 * c.mn;
      if (L < 1.5) return;
      const ang = (q.angle * Math.PI) / 180, dx = Math.cos(ang), dy = Math.sin(ang);
      const N = Math.min(40, Math.max(3, Math.round(L)));
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0;
          for (let k = 0; k < N; k++) {
            const t = (k / (N - 1) - 0.5) * L;
            let sx = Math.round(x + dx * t), sy = Math.round(y + dy * t);
            sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx; sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
            const i = (sy * w + sx) * 4;
            r += src[i]; g += src[i + 1]; b += src[i + 2];
          }
          const j = (y * w + x) * 4;
          d[j] = r / N; d[j + 1] = g / N; d[j + 2] = b / N;
        }
      }
    },
  },
  {
    id: 'zoom', cat: 'blur', ko: '줌 블러', en: 'Zoom blur', icon: 'scan',
    params: [S('amount', '강도', 'Amount', 0, 100, 40), S('cx', '중심 X', 'Center X', 0, 100, 50), S('cy', '중심 Y', 'Center Y', 0, 100, 50)],
    handle: { kind: 'point', x: 'cx', y: 'cy' },
    apply(img, q) {
      const { w, h, d } = img;
      const k = (q.amount / 100) * 0.35;
      if (k <= 0.002) return;
      const cx = (q.cx / 100) * w, cy = (q.cy / 100) * h;
      const N = 18;
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let r = 0, g = 0, b = 0;
          const vx = cx - x, vy = cy - y;
          for (let i = 0; i < N; i++) {
            const t = (i / (N - 1)) * k;
            let sx = Math.round(x + vx * t), sy = Math.round(y + vy * t);
            sx = sx < 0 ? 0 : sx >= w ? w - 1 : sx; sy = sy < 0 ? 0 : sy >= h ? h - 1 : sy;
            const j2 = (sy * w + sx) * 4;
            r += src[j2]; g += src[j2 + 1]; b += src[j2 + 2];
          }
          const j = (y * w + x) * 4;
          d[j] = r / N; d[j + 1] = g / N; d[j + 2] = b / N;
        }
      }
    },
  },
  {
    id: 'tilt', cat: 'blur', ko: '틸트 시프트', en: 'Tilt-shift', icon: 'focus',
    params: [S('pos', '위치', 'Position', 0, 100, 50), S('size', '선명 영역', 'Focus width', 2, 80, 22), S('blur', '블러', 'Blur', 0, 100, 55), S('angle', '각도', 'Angle', -90, 90, 0)],
    handle: { kind: 'band', pos: 'pos', angle: 'angle', size: 'size' },
    apply(img, q, c) {
      const { w, h } = img;
      const s = (q.blur / 100) * 0.035 * c.mn;
      if (s < 0.5) return;
      const B1 = blurRGBA(img, s * 0.5), B2 = blurRGBA(img, s);
      const ang = (q.angle * Math.PI) / 180, nx = -Math.sin(ang), ny = Math.cos(ang); // 법선
      const half = (q.size / 100) * 0.5 * Math.hypot(w, h) * 0.5, feather = Math.max(4, Math.hypot(w, h) * 0.18);
      const py = h * (q.pos / 100);
      selectiveBlend(img, B1, B2, (x, y) => {
        const dist = Math.abs((x - w / 2) * nx + (y - py) * ny);
        return smoothstep(half, half + feather, dist);
      });
    },
  },
  {
    id: 'radialfocus', cat: 'blur', ko: '원형 초점', en: 'Radial focus', icon: 'aperture',
    params: [S('cx', '중심 X', 'Center X', 0, 100, 50), S('cy', '중심 Y', 'Center Y', 0, 100, 50), S('size', '선명 영역', 'Focus size', 5, 100, 35), S('blur', '블러', 'Blur', 0, 100, 55)],
    handle: { kind: 'point', x: 'cx', y: 'cy', radius: 'size' },
    apply(img, q, c) {
      const { w, h } = img;
      const s = (q.blur / 100) * 0.035 * c.mn;
      if (s < 0.5) return;
      const B1 = blurRGBA(img, s * 0.5), B2 = blurRGBA(img, s);
      const cx = (q.cx / 100) * w, cy = (q.cy / 100) * h, R = (q.size / 100) * 0.5 * c.mn * 1.2, F = Math.max(6, c.mn * 0.25);
      selectiveBlend(img, B1, B2, (x, y) => smoothstep(R, R + F, Math.hypot(x - cx, y - cy)));
    },
  },
  // ------------------------------------------------------------ 아트
  {
    id: 'pixelate', cat: 'art', ko: '모자이크', en: 'Pixelate', icon: 'grid-3x3',
    params: [S('size', '블록 크기', 'Block size', 1, 100, 25)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const bs = Math.max(2, Math.round((q.size / 100) * 0.08 * c.mn));
      for (let by = 0; by < h; by += bs) {
        for (let bx = 0; bx < w; bx += bs) {
          let r = 0, g = 0, b = 0, n = 0;
          const ye = Math.min(h, by + bs), xe = Math.min(w, bx + bs);
          for (let y = by; y < ye; y++) for (let x = bx; x < xe; x++) { const j = (y * w + x) * 4; r += d[j]; g += d[j + 1]; b += d[j + 2]; n++; }
          r /= n; g /= n; b /= n;
          for (let y = by; y < ye; y++) for (let x = bx; x < xe; x++) { const j = (y * w + x) * 4; d[j] = r; d[j + 1] = g; d[j + 2] = b; }
        }
      }
    },
  },
  {
    id: 'halftone', cat: 'art', ko: '하프톤', en: 'Halftone', icon: 'circle-dashed',
    params: [S('size', '점 크기', 'Dot size', 10, 100, 40), SEL('style', '스타일', 'Style', [[0, '컬러'], [1, '흑백']], 0)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const cell = Math.max(4, (q.size / 100) * 0.06 * c.mn);
      const bl = blurRGBA(img, cell * 0.45);
      const a = Math.PI / 4, ca = Math.cos(a), sa = Math.sin(a);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = x * ca + y * sa, v = -x * sa + y * ca;
          const cu = (Math.floor(u / cell) + 0.5) * cell, cv = (Math.floor(v / cell) + 0.5) * cell;
          const cxp = cu * ca - cv * sa, cyp = cu * sa + cv * ca;
          const sx = clamp(Math.round(cxp), 0, w - 1), sy = clamp(Math.round(cyp), 0, h - 1);
          const si = (sy * w + sx) * 4;
          const L = lumaOf(bl, si);
          const rad = cell * 0.62 * Math.sqrt(1 - L * 0.97);
          const dist = Math.hypot(x - cxp, y - cyp);
          const cov = clamp01(rad - dist + 0.5);
          const j = (y * w + x) * 4;
          let r = bl[si], g = bl[si + 1], b = bl[si + 2];
          if (q.style == 1) { r = g = b = 20; }
          d[j] = 250 + (r * 0.92 - 250) * cov; d[j + 1] = 248 + (g * 0.92 - 248) * cov; d[j + 2] = 244 + (b * 0.92 - 244) * cov;
        }
      }
    },
  },
  {
    id: 'oil', cat: 'art', ko: '유화', en: 'Oil paint', icon: 'brush',
    params: [S('radius', '붓 크기', 'Brush size', 1, 100, 30)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const half = Math.max(1, Math.round(1 + (q.radius / 100) * 0.006 * c.mn));
      const n = w * h;
      const planes = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = d[j], g = d[j + 1], b = d[j + 2], L = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        planes[0][i] = r; planes[1][i] = g; planes[2][i] = b; planes[3][i] = L; planes[4][i] = L * L;
      }
      const M = planes.map((p) => boxMean(p, w, h, half));
      const offs = [[-half, -half], [half, -half], [-half, half], [half, half]];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let best = 1e9, bi = 0;
          for (let k = 0; k < 4; k++) {
            const sx = clamp(x + offs[k][0], 0, w - 1), sy = clamp(y + offs[k][1], 0, h - 1);
            const i = sy * w + sx;
            const v = M[4][i] - M[3][i] * M[3][i];
            if (v < best) { best = v; bi = i; }
          }
          const j = (y * w + x) * 4;
          d[j] = M[0][bi]; d[j + 1] = M[1][bi]; d[j + 2] = M[2][bi];
        }
      }
    },
  },
  {
    id: 'sketch', cat: 'art', ko: '스케치', en: 'Sketch', icon: 'pencil',
    params: [S('detail', '선 굵기', 'Line weight', 0, 100, 40), S('color', '색 유지', 'Keep color', 0, 100, 0)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const n = w * h;
      const L = lumaPlane(img);
      const inv = new Float32Array(n);
      for (let i = 0; i < n; i++) inv[i] = 1 - L[i];
      const B = blurPlaneFast(inv, w, h, Math.max(0.8, (0.002 + (q.detail / 100) * 0.012) * c.mn));
      const k = q.color / 100;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const dodge = Math.min(1, L[i] / (1 - B[i] + 0.004));
        const v = Math.pow(dodge, 1.2) * 255;
        d[j] = v + (v * (d[j] / 255) * 1.1 - v) * k; d[j + 1] = v + (v * (d[j + 1] / 255) * 1.1 - v) * k; d[j + 2] = v + (v * (d[j + 2] / 255) * 1.1 - v) * k;
      }
    },
  },
  {
    id: 'cartoon', cat: 'art', ko: '만화', en: 'Cartoon', icon: 'sticker',
    params: [S('levels', '단계', 'Levels', 3, 12, 6), S('edge', '윤곽선', 'Outline', 0, 100, 55), S('smooth', '부드러움', 'Smooth', 0, 100, 60)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const r = Math.max(2, Math.round((0.004 + (q.smooth / 100) * 0.008) * c.mn));
      guidedSmooth(img, r, 0.01);
      guidedSmooth(img, r, 0.01);
      const n = w * h;
      const L = lumaPlane(img);
      const lv = Math.round(q.levels) - 1;
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const y = L[i], yq = Math.round(y * lv) / lv;
        const k = y > 0.01 ? (yq + 0.02) / y : 1;
        d[j] = clamp(d[j] * k, 0, 255); d[j + 1] = clamp(d[j + 1] * k, 0, 255); d[j + 2] = clamp(d[j + 2] * k, 0, 255);
      }
      if (q.edge > 0) {
        const th = 0.5 - (q.edge / 100) * 0.42;
        for (let y = 1; y < h - 1; y++) {
          for (let x = 1; x < w - 1; x++) {
            const i = y * w + x;
            const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
            const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
            const m = Math.hypot(gx, gy);
            if (m > th) {
              const k = 1 - clamp01((m - th) * 4) * 0.9, j = i * 4;
              d[j] *= k; d[j + 1] *= k; d[j + 2] *= k;
            }
          }
        }
      }
    },
  },
  {
    id: 'emboss', cat: 'art', ko: '엠보스', en: 'Emboss', icon: 'layers-2',
    params: [S('strength', '강도', 'Strength', 0, 100, 50), S('angle', '각도', 'Angle', 0, 360, 315), S('color', '색 유지', 'Keep color', 0, 100, 0)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const L = lumaPlane(img);
      const a = (q.angle * Math.PI) / 180, dx = Math.cos(a), dy = Math.sin(a);
      const off = Math.max(1, Math.round(c.mn / 900));
      const st = (q.strength / 100) * 3.2, kc = q.color / 100;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x1 = clamp(Math.round(x + dx * off), 0, w - 1), y1 = clamp(Math.round(y + dy * off), 0, h - 1);
          const x2 = clamp(Math.round(x - dx * off), 0, w - 1), y2 = clamp(Math.round(y - dy * off), 0, h - 1);
          const diff = L[y1 * w + x1] - L[y2 * w + x2];
          const v = 128 + diff * st * 255;
          const j = (y * w + x) * 4;
          d[j] = v + (d[j] * (v / 128) - v) * kc; d[j + 1] = v + (d[j + 1] * (v / 128) - v) * kc; d[j + 2] = v + (d[j + 2] * (v / 128) - v) * kc;
        }
      }
    },
  },
  {
    id: 'edges', cat: 'art', ko: '외곽선', en: 'Outline', icon: 'scan-line',
    params: [S('strength', '강도', 'Strength', 0, 100, 60), S('color', '색 유지', 'Keep color', 0, 100, 70)],
    apply(img, q) {
      const { w, h, d } = img;
      const L = lumaPlane(img);
      const src = new Uint8ClampedArray(d);
      const k = 1 + (q.strength / 100) * 5, kc = q.color / 100;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1), y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1);
          const gx = -L[y0 * w + x0] - 2 * L[y * w + x0] - L[y1 * w + x0] + L[y0 * w + x1] + 2 * L[y * w + x1] + L[y1 * w + x1];
          const gy = -L[y0 * w + x0] - 2 * L[y0 * w + x] - L[y0 * w + x1] + L[y1 * w + x0] + 2 * L[y1 * w + x] + L[y1 * w + x1];
          const m = clamp01(Math.hypot(gx, gy) * k);
          const j = (y * w + x) * 4;
          for (let ch = 0; ch < 3; ch++) d[j + ch] = 255 * m + (src[j + ch] * m - 255 * m) * kc;
        }
      }
    },
  },
  {
    id: 'posterize', cat: 'art', ko: '포스터', en: 'Posterize', icon: 'layers',
    params: [S('levels', '단계', 'Levels', 2, 16, 5)],
    apply(img, q) {
      const d = img.d, lv = Math.round(q.levels) - 1;
      for (let j = 0; j < d.length; j += 4) for (let c = 0; c < 3; c++) d[j + c] = (Math.round((d[j + c] / 255) * lv) / lv) * 255;
    },
  },
  {
    id: 'solarize', cat: 'art', ko: '솔라라이즈', en: 'Solarize', icon: 'sun-moon',
    params: [S('threshold', '기준', 'Threshold', 0, 100, 50)],
    apply(img, q) {
      const d = img.d, th = (q.threshold / 100) * 255;
      for (let j = 0; j < d.length; j += 4) for (let c = 0; c < 3; c++) if (d[j + c] > th) d[j + c] = 255 - d[j + c];
    },
  },
  {
    id: 'threshold', cat: 'art', ko: '흑백 2색', en: 'Threshold', icon: 'contrast',
    params: [S('threshold', '기준', 'Threshold', 0, 100, 50)],
    apply(img, q) {
      const d = img.d, th = (q.threshold / 100) * 255;
      for (let j = 0; j < d.length; j += 4) {
        const v = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] > th ? 255 : 0;
        d[j] = d[j + 1] = d[j + 2] = v;
      }
    },
  },
  {
    id: 'invert', cat: 'art', ko: '반전', en: 'Invert', icon: 'eclipse',
    params: [],
    apply(img) { const d = img.d; for (let j = 0; j < d.length; j += 4) { d[j] = 255 - d[j]; d[j + 1] = 255 - d[j + 1]; d[j + 2] = 255 - d[j + 2]; } },
  },
  {
    id: 'duotone', cat: 'art', ko: '듀오톤', en: 'Duotone', icon: 'palette',
    params: [S('hue1', '어두운 색', 'Shadow hue', 0, 360, 235), S('hue2', '밝은 색', 'Light hue', 0, 360, 38), S('sat', '채도', 'Saturation', 0, 100, 75)],
    apply(img, q) {
      const d = img.d;
      const a = hslToRgb255(q.hue1, q.sat / 100, 0.16), b = hslToRgb255(q.hue2, q.sat / 100, 0.82);
      const lut = new Uint8ClampedArray(256 * 3);
      for (let i = 0; i < 256; i++) { const t = i / 255; for (let c = 0; c < 3; c++) lut[i * 3 + c] = a[c] + (b[c] - a[c]) * t; }
      for (let j = 0; j < d.length; j += 4) {
        const l = Math.round(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) * 3;
        d[j] = lut[l]; d[j + 1] = lut[l + 1]; d[j + 2] = lut[l + 2];
      }
    },
  },
  // ------------------------------------------------------------ 빛
  {
    id: 'glow', cat: 'light', ko: '글로우', en: 'Glow', icon: 'sparkles',
    params: [S('threshold', '밝은 영역', 'Threshold', 0, 100, 55), S('radius', '번짐', 'Spread', 0, 100, 45), S('strength', '강도', 'Strength', 0, 100, 55)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const th = q.threshold / 100;
      const bright = { w, h, d: new Uint8ClampedArray(d.length) };
      for (let j = 0; j < d.length; j += 4) {
        const L = lumaOf(d, j), m = L <= th ? 0 : (L - th) / (1 - th + 1e-4);
        bright.d[j] = d[j] * m; bright.d[j + 1] = d[j + 1] * m; bright.d[j + 2] = d[j + 2] * m; bright.d[j + 3] = 255;
      }
      const B = blurRGBA(bright, Math.max(1, (q.radius / 100) * 0.05 * c.mn));
      const k = (q.strength / 100) * 1.6;
      for (let j = 0; j < d.length; j += 4) for (let ch = 0; ch < 3; ch++) d[j + ch] = screenCh(d[j + ch], B[j + ch] * k);
    },
  },
  {
    id: 'softfocus', cat: 'light', ko: '소프트 포커스', en: 'Soft focus', icon: 'cloud-fog',
    params: [S('amount', '강도', 'Amount', 0, 100, 50), S('radius', '번짐', 'Spread', 0, 100, 40)],
    apply(img, q, c) {
      const d = img.d, B = blurRGBA(img, Math.max(1, (q.radius / 100) * 0.03 * c.mn)), k = (q.amount / 100) * 0.75;
      for (let j = 0; j < d.length; j += 4) for (let ch = 0; ch < 3; ch++) {
        const o = d[j + ch], s = screenCh(o, B[j + ch]);
        d[j + ch] = o + (s - o) * k;
      }
    },
  },
  {
    id: 'lightleak', cat: 'light', ko: '빛샘', en: 'Light leak', icon: 'flashlight',
    params: [S('intensity', '강도', 'Intensity', 0, 100, 55), S('hue', '색상', 'Hue', 0, 360, 22), S('x', '위치 X', 'Position X', 0, 100, 90), S('y', '위치 Y', 'Position Y', 0, 100, 12), S('size', '크기', 'Size', 10, 100, 60)],
    handle: { kind: 'point', x: 'x', y: 'y' },
    apply(img, q, c) {
      const { w, h, d } = img;
      const col = hslToRgb255(q.hue, 1, 0.55), col2 = hslToRgb255((q.hue + 40) % 360, 1, 0.6);
      const px = (q.x / 100) * w, py = (q.y / 100) * h, R = (q.size / 100) * Math.hypot(w, h) * 0.55;
      const k = (q.intensity / 100) * 1.1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dist = Math.hypot(x - px, y - py) / R;
          const f = Math.exp(-dist * dist * 1.6) * k;
          if (f < 0.004) continue;
          const f2 = Math.exp(-(dist * 1.5) * (dist * 1.5)) * k * 0.7;
          const j = (y * w + x) * 4;
          d[j] = screenCh(d[j], clamp(col[0] * f + col2[0] * f2 * 0.5, 0, 255));
          d[j + 1] = screenCh(d[j + 1], clamp(col[1] * f + col2[1] * f2 * 0.5, 0, 255));
          d[j + 2] = screenCh(d[j + 2], clamp(col[2] * f + col2[2] * f2 * 0.5, 0, 255));
        }
      }
      void c;
    },
  },
  {
    id: 'bokeh', cat: 'light', ko: '빛망울', en: 'Bokeh lights', icon: 'sparkle',
    params: [S('amount', '개수', 'Amount', 0, 100, 40), S('size', '크기', 'Size', 5, 100, 40), S('seed', '무작위', 'Shuffle', 1, 99, 7)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const rnd = mulberry32(q.seed * 7919);
      const n = Math.round(q.amount * 0.9);
      const src = new Uint8ClampedArray(d);
      for (let i = 0; i < n; i++) {
        const cx = rnd() * w, cy = rnd() * h, R = (0.012 + rnd() * 0.05) * c.mn * (0.4 + q.size / 70), al = 0.18 + rnd() * 0.3;
        const si = (clamp(Math.round(cy), 0, h - 1) * w + clamp(Math.round(cx), 0, w - 1)) * 4;
        const cr = Math.min(255, src[si] * 1.3 + 40), cg = Math.min(255, src[si + 1] * 1.3 + 40), cb = Math.min(255, src[si + 2] * 1.3 + 40);
        const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R)), y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const dd = Math.hypot(x - cx, y - cy) / R;
          if (dd > 1) continue;
          const a = al * (dd > 0.82 ? 1.25 : 0.7) * (1 - smoothstep(0.92, 1, dd));
          const j = (y * w + x) * 4;
          d[j] = screenCh(d[j], cr * a); d[j + 1] = screenCh(d[j + 1], cg * a); d[j + 2] = screenCh(d[j + 2], cb * a);
        }
      }
    },
  },
  {
    id: 'snow', cat: 'light', ko: '눈 내리는', en: 'Snow', icon: 'snowflake',
    params: [S('amount', '양', 'Amount', 0, 100, 50), S('size', '크기', 'Size', 5, 100, 35), S('seed', '무작위', 'Shuffle', 1, 99, 11)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const rnd = mulberry32(q.seed * 104729);
      const n = Math.round(q.amount * 6);
      for (let i = 0; i < n; i++) {
        const cx = rnd() * w, cy = rnd() * h, R = Math.max(1, (0.002 + rnd() * rnd() * 0.012) * c.mn * (0.4 + q.size / 50)), al = 0.45 + rnd() * 0.5;
        const x0 = Math.max(0, Math.floor(cx - R - 1)), x1 = Math.min(w - 1, Math.ceil(cx + R + 1)), y0 = Math.max(0, Math.floor(cy - R - 1)), y1 = Math.min(h - 1, Math.ceil(cy + R + 1));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const a = clamp01(1 - Math.hypot(x - cx, y - cy) / R) * al;
          if (a <= 0) continue;
          const j = (y * w + x) * 4;
          d[j] += (255 - d[j]) * a; d[j + 1] += (255 - d[j + 1]) * a; d[j + 2] += (255 - d[j + 2]) * a;
        }
      }
    },
  },
  // ------------------------------------------------------------ 왜곡
  {
    id: 'swirl', cat: 'distort', ko: '소용돌이', en: 'Swirl', icon: 'rotate-3d',
    params: [S('amount', '강도', 'Amount', -100, 100, 60), S('radius', '범위', 'Radius', 10, 100, 60), S('cx', '중심 X', 'Center X', 0, 100, 50), S('cy', '중심 Y', 'Center Y', 0, 100, 50)],
    handle: { kind: 'point', x: 'cx', y: 'cy', radius: 'radius' },
    apply(img, q, c) {
      const { w, h } = img;
      const cx = (q.cx / 100) * w, cy = (q.cy / 100) * h, R = (q.radius / 100) * c.mn * 0.75, A = (q.amount / 100) * Math.PI * 1.5;
      remap(img, (x, y, m) => {
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
        if (r >= R) { m[0] = x; m[1] = y; return; }
        const t = 1 - r / R, th = A * t * t, cs = Math.cos(th), sn = Math.sin(th);
        m[0] = cx + dx * cs - dy * sn; m[1] = cy + dx * sn + dy * cs;
      });
    },
  },
  {
    id: 'bulge', cat: 'distort', ko: '볼록/오목', en: 'Bulge / pinch', icon: 'circle',
    params: [S('amount', '강도', 'Amount', -100, 100, 55), S('radius', '범위', 'Radius', 10, 100, 55), S('cx', '중심 X', 'Center X', 0, 100, 50), S('cy', '중심 Y', 'Center Y', 0, 100, 50)],
    handle: { kind: 'point', x: 'cx', y: 'cy', radius: 'radius' },
    apply(img, q, c) {
      const { w, h } = img;
      const cx = (q.cx / 100) * w, cy = (q.cy / 100) * h, R = (q.radius / 100) * c.mn * 0.75, A = q.amount / 100;
      remap(img, (x, y, m) => {
        const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
        if (r >= R || r === 0) { m[0] = x; m[1] = y; return; }
        const t = r / R, k = A > 0 ? 1 - A * 0.6 * (1 - t) * (1 - t) * 2 : 1 + -A * 0.8 * (1 - t) * (1 - t) * 2;
        m[0] = cx + dx * k; m[1] = cy + dy * k;
      });
    },
  },
  {
    id: 'wave', cat: 'distort', ko: '물결', en: 'Wave', icon: 'waves',
    params: [S('amp', '높이', 'Amplitude', 0, 100, 30), S('len', '간격', 'Wavelength', 5, 100, 30), SEL('dir', '방향', 'Direction', [[0, '가로'], [1, '세로']], 0)],
    apply(img, q, c) {
      const A = (q.amp / 100) * 0.04 * c.mn, L = (0.02 + (q.len / 100) * 0.3) * c.mn;
      remap(img, (x, y, m) => {
        if (q.dir == 1) { m[0] = x; m[1] = y + A * Math.sin((2 * Math.PI * x) / L); }
        else { m[0] = x + A * Math.sin((2 * Math.PI * y) / L); m[1] = y; }
      });
    },
  },
  {
    id: 'fisheye', cat: 'distort', ko: '어안 렌즈', en: 'Fisheye', icon: 'eye',
    params: [S('amount', '강도', 'Amount', 0, 100, 55)],
    apply(img, q) {
      const { w, h } = img;
      const k = (q.amount / 100) * 0.9, cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
      remap(img, (x, y, m) => {
        const dx = (x - cx) / R, dy = (y - cy) / R, r = Math.hypot(dx, dy);
        const f = 1 + k * r * r;
        m[0] = cx + (dx * f) * R / (1 + k * 0.5); m[1] = cy + (dy * f) * R / (1 + k * 0.5);
      });
    },
  },
  {
    id: 'mirror', cat: 'distort', ko: '거울', en: 'Mirror', icon: 'flip-horizontal',
    params: [SEL('mode', '모드', 'Mode', [[0, '좌→우'], [1, '우→좌'], [2, '상→하'], [3, '하→상'], [4, '4분할'], [5, '만화경']], 0), S('seg', '조각 수', 'Segments', 3, 12, 6)],
    apply(img, q) {
      const { w, h } = img;
      const cx = w / 2, cy = h / 2, mode = +q.mode, seg = Math.round(q.seg);
      remap(img, (x, y, m) => {
        let sx = x, sy = y;
        if (mode === 0 && x > cx) sx = w - x;
        else if (mode === 1 && x < cx) sx = w - x;
        else if (mode === 2 && y > cy) sy = h - y;
        else if (mode === 3 && y < cy) sy = h - y;
        else if (mode === 4) { if (x > cx) sx = w - x; if (y > cy) sy = h - y; }
        else if (mode === 5) {
          const dx = x - cx, dy = y - cy, r = Math.hypot(dx, dy);
          let a = Math.atan2(dy, dx);
          const s = (Math.PI * 2) / seg;
          a = ((a % s) + s) % s;
          if (a > s / 2) a = s - a;
          sx = cx + Math.cos(a) * r; sy = cy + Math.sin(a) * r;
        }
        m[0] = sx; m[1] = sy;
      });
    },
  },
  // ------------------------------------------------------------ 글리치·레트로
  {
    id: 'glitch', cat: 'retro', ko: '글리치', en: 'Glitch', icon: 'zap',
    params: [S('amount', '강도', 'Amount', 0, 100, 45), S('shift', 'RGB 분리', 'RGB split', 0, 100, 40), S('seed', '무작위', 'Shuffle', 1, 99, 5)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const rnd = mulberry32(q.seed * 2654435);
      const src = new Uint8ClampedArray(d);
      const bands = 3 + Math.round((q.amount / 100) * 12);
      for (let i = 0; i < bands; i++) {
        const y0 = Math.floor(rnd() * h), bh = Math.max(1, Math.floor((0.01 + rnd() * 0.06) * h)), sh = Math.round((rnd() - 0.5) * 2 * (q.amount / 100) * 0.12 * w);
        for (let y = y0; y < Math.min(h, y0 + bh); y++) for (let x = 0; x < w; x++) {
          const sx = (((x - sh) % w) + w) % w;
          const j = (y * w + x) * 4, s = (y * w + sx) * 4;
          d[j] = src[s]; d[j + 1] = src[s + 1]; d[j + 2] = src[s + 2];
        }
      }
      const s2 = Math.round((q.shift / 100) * 0.02 * w);
      if (s2 > 0) {
        const cp = new Uint8ClampedArray(d);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const j = (y * w + x) * 4;
          d[j] = cp[(y * w + clamp(x + s2, 0, w - 1)) * 4];
          d[j + 2] = cp[(y * w + clamp(x - s2, 0, w - 1)) * 4 + 2];
        }
      }
      if (q.amount > 50) for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x++) { const j = (y * w + x) * 4; d[j] *= 0.86; d[j + 1] *= 0.86; d[j + 2] *= 0.86; }
      void c;
    },
  },
  {
    id: 'chroma', cat: 'retro', ko: '색수차', en: 'Chromatic aberration', icon: 'rainbow',
    params: [S('amount', '강도', 'Amount', 0, 100, 35)],
    apply(img, q) {
      const { w, h, d } = img;
      const k = (q.amount / 100) * 0.018, cx = w / 2, cy = h / 2;
      const src = new Uint8ClampedArray(d), out = [0, 0, 0, 0];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x + 0.5 - cx, dy = y + 0.5 - cy, j = (y * w + x) * 4;
          sampleClamp(src, w, h, cx + dx * (1 + k), cy + dy * (1 + k), out); d[j] = out[0];
          sampleClamp(src, w, h, cx + dx * (1 - k), cy + dy * (1 - k), out); d[j + 2] = out[2];
        }
      }
    },
  },
  {
    id: 'rgbsplit', cat: 'retro', ko: 'RGB 분리', en: 'RGB shift', icon: 'layers-2',
    params: [S('x', '가로', 'Horizontal', -100, 100, 30), S('y', '세로', 'Vertical', -100, 100, 0)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const sx = Math.round((q.x / 100) * 0.03 * c.mn), sy = Math.round((q.y / 100) * 0.03 * c.mn);
      const src = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = (y * w + x) * 4;
        d[j] = src[(clamp(y + sy, 0, h - 1) * w + clamp(x + sx, 0, w - 1)) * 4];
        d[j + 2] = src[(clamp(y - sy, 0, h - 1) * w + clamp(x - sx, 0, w - 1)) * 4 + 2];
      }
    },
  },
  {
    id: 'vhs', cat: 'retro', ko: 'VHS', en: 'VHS', icon: 'monitor-smartphone',
    params: [S('amount', '강도', 'Amount', 0, 100, 55), S('seed', '무작위', 'Shuffle', 1, 99, 3)],
    apply(img, q, c) {
      const { w, h, d } = img;
      const rnd = mulberry32(q.seed * 31337), k = q.amount / 100;
      const src = new Uint8ClampedArray(d);
      const bleed = Math.max(1, Math.round(c.mn * 0.012 * (0.4 + k)));
      for (let y = 0; y < h; y++) {
        const jit = Math.round(Math.sin(y * 0.07 + q.seed) * k * 0.004 * w + (rnd() < 0.01 ? (rnd() - 0.5) * 0.06 * w * k : 0));
        for (let x = 0; x < w; x++) {
          const j = (y * w + x) * 4, sx = clamp(x - jit, 0, w - 1);
          d[j] = src[(y * w + clamp(sx + bleed, 0, w - 1)) * 4];
          d[j + 1] = src[(y * w + sx) * 4 + 1];
          d[j + 2] = src[(y * w + clamp(sx - bleed, 0, w - 1)) * 4 + 2];
          const sl = y % 3 === 0 ? 1 - 0.18 * k : 1, nz = (rnd() - 0.5) * 40 * k;
          d[j] = d[j] * sl + nz; d[j + 1] = d[j + 1] * sl + nz; d[j + 2] = d[j + 2] * sl + nz;
        }
      }
    },
  },
];

const BY_ID = new Map(EFFECTS.map((e) => [e.id, e]));
export function getEffect(id) { return BY_ID.get(id) || null; }

/** fx 스택 적용: items = [{k, on, mix, p}] */
export function applyEffects(img, items, ctx) {
  if (!items || !items.length) return img;
  for (const it of items) {
    if (!it || it.on === false) continue;
    const def = getEffect(it.k);
    if (!def) continue;
    const q = { ...defaults(def), ...(it.p || {}) };
    const mix = it.mix == null ? 100 : it.mix;
    if (mix <= 0) continue;
    if (mix >= 100) { def.apply(img, q, ctx); continue; }
    const orig = new Uint8ClampedArray(img.d);
    def.apply(img, q, ctx);
    const d = img.d, k = mix / 100;
    for (let j = 0; j < d.length; j += 4) {
      d[j] = orig[j] + (d[j] - orig[j]) * k; d[j + 1] = orig[j + 1] + (d[j + 1] - orig[j + 1]) * k; d[j + 2] = orig[j + 2] + (d[j + 2] - orig[j + 2]) * k;
    }
  }
  return img;
}

export { lerp, cloneImg };
