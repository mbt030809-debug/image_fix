// 현상(Develop) 파이프라인: 노출·톤·색·HSL·커브·스플릿토닝·흑백·LUT·비네팅·그레인·디테일
// 입력 파라미터(adj)는 -100..100 정수 슬라이더 값 기반의 평탄한 객체.
import { clamp, clamp01, smoothstep, lumaPlane, cloneImg } from './util.js';
import { blurPlaneFast, unsharp, guidedSmooth, upPlane } from './blur.js';

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'];
const HSL_CENTERS = [0, 30, 60, 120, 180, 240, 270, 300];

export const SCALAR_KEYS = [
  'exposure', 'brightness', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'dehaze', 'fade',
  'saturation', 'vibrance', 'temp', 'tint', 'hue',
  'clarity', 'texture', 'sharpen', 'denoise', 'grain', 'vignette', 'bw', 'splitBal',
];
// 기본값이 0 이 아닌 슬라이더
export const DEFAULTS = { grainSize: 35, vigSize: 50, vigFeather: 50, vigRound: 0 };

// ---------------------------------------------------------------- 색 공간 LUT
const S2L = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  S2L[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const L2S_N = 4096;
const L2S = new Float32Array(L2S_N);
for (let i = 0; i < L2S_N; i++) {
  const v = i / (L2S_N - 1);
  L2S[i] = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// ---------------------------------------------------------------- HSL 변환 (모듈 스크래치 변수 사용: 할당 없음)
let _h = 0, _s = 0, _l = 0, _r = 0, _g = 0, _b = 0;
function rgb2hsl(r, g, b) {
  const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
  const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
  const l = (mx + mn) * 0.5;
  let h = 0, s = 0;
  if (mx !== mn) {
    const dd = mx - mn;
    s = l > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
    if (mx === r) h = (g - b) / dd + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / dd + 2;
    else h = (r - g) / dd + 4;
    h *= 60;
  }
  _h = h; _s = s; _l = l;
}
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}
function hsl2rgb(h, s, l) {
  if (s <= 0) { _r = _g = _b = l; return; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  h /= 360;
  _r = hue2rgb(p, q, h + 1 / 3);
  _g = hue2rgb(p, q, h);
  _b = hue2rgb(p, q, h - 1 / 3);
}
export function hslToRgb255(h, s, l) {
  hsl2rgb(((h % 360) + 360) % 360, clamp01(s), clamp01(l));
  return [Math.round(_r * 255), Math.round(_g * 255), Math.round(_b * 255)];
}

// ---------------------------------------------------------------- 커브 (단조 3차 스플라인, PCHIP)
/** pts: [[x,y]...] 0..1 → 256+ 길이 LUT */
export function curveLUT(pts, n = 1024) {
  const lut = new Float32Array(n);
  if (!pts || pts.length < 2) {
    for (let i = 0; i < n; i++) lut[i] = i / (n - 1);
    return lut;
  }
  const p = pts.map((q) => [clamp01(q[0]), clamp01(q[1])]).sort((a, b) => a[0] - b[0]);
  // 양 끝 보강
  if (p[0][0] > 0) p.unshift([0, p[0][1]]);
  if (p[p.length - 1][0] < 1) p.push([1, p[p.length - 1][1]]);
  const m = p.length;
  const dx = [], sl = [];
  for (let i = 0; i < m - 1; i++) {
    dx[i] = Math.max(1e-6, p[i + 1][0] - p[i][0]);
    sl[i] = (p[i + 1][1] - p[i][1]) / dx[i];
  }
  const t = new Array(m);
  t[0] = sl[0];
  t[m - 1] = sl[m - 2];
  for (let i = 1; i < m - 1; i++) {
    if (sl[i - 1] * sl[i] <= 0) t[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / sl[i - 1] + w2 / sl[i]);
    }
  }
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    while (k < m - 2 && x > p[k + 1][0]) k++;
    const h = dx[k], s = (x - p[k][0]) / h;
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    lut[i] = clamp01(h00 * p[k][1] + h10 * h * t[k] + h01 * p[k + 1][1] + h11 * h * t[k + 1]);
  }
  return lut;
}

function composeLUT(a, b) { // b(a(x))
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = a[i] * (b.length - 1);
    const i0 = Math.floor(v), i1 = Math.min(b.length - 1, i0 + 1), f = v - i0;
    out[i] = b[i0] * (1 - f) + b[i1] * f;
  }
  return out;
}

function isIdentityPts(pts) {
  if (!pts || pts.length === 0) return true;
  if (pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1) return true;
  return pts.every((q) => Math.abs(q[0] - q[1]) < 1e-4);
}

// ---------------------------------------------------------------- 파라미터 병합 (사용자 보정 + 필터)
export function mergeAdj(user, filterP, amt) {
  const k = clamp(amt == null ? 1 : amt, 0, 1);
  const a = { ...(user || {}) };
  a.curvesList = [];
  if (user && user.curves) a.curvesList.push(user.curves);
  if (filterP && k > 0) {
    for (const key of SCALAR_KEYS) {
      if (key === 'bw') continue;
      if (filterP[key]) a[key] = (a[key] || 0) + filterP[key] * k;
    }
    if (filterP.bw) a.bw = clamp((a.bw || 0) + filterP.bw * k, 0, 100);
    if (filterP.bwMix && !a.bwMix) a.bwMix = filterP.bwMix;
    if (filterP.curves) a.curvesList.push(scaleCurves(filterP.curves, k));
    if (filterP.hsl) {
      const hsl = { ...(a.hsl || {}) };
      for (const band of HSL_BANDS) {
        const fv = filterP.hsl[band];
        if (!fv) continue;
        const uv = hsl[band] || [0, 0, 0];
        hsl[band] = [uv[0] + fv[0] * k, uv[1] + fv[1] * k, uv[2] + fv[2] * k];
      }
      a.hsl = hsl;
    }
    for (const key of ['splitHi', 'splitLo']) {
      const fv = filterP[key];
      if (fv && fv.s > 0) {
        const uv = a[key];
        if (!uv || !uv.s) a[key] = { h: fv.h, s: fv.s * k };
      }
    }
    if (filterP.lut) a.lut = { ...filterP.lut, amt: (filterP.lut.amt == null ? 1 : filterP.lut.amt) * k };
  }
  if (user && user.lut) a.lut = user.lut;
  return a;
}

function scaleCurves(c, k) {
  if (k >= 0.999) return c;
  const out = {};
  for (const key of ['l', 'r', 'g', 'b']) {
    if (c[key]) out[key] = c[key].map((p) => [p[0], p[0] + (p[1] - p[0]) * k]);
  }
  return out;
}

/** 변화가 전혀 없는 보정인지 (렌더 생략용) */
export function adjIsNeutral(a) {
  if (!a) return true;
  for (const key of SCALAR_KEYS) if (a[key]) return false;
  if (a.curvesList && a.curvesList.some(curvesActive)) return false;
  if (a.curves && curvesActive(a.curves)) return false;
  if (a.hsl) for (const b of HSL_BANDS) { const v = a.hsl[b]; if (v && (v[0] || v[1] || v[2])) return false; }
  if (a.splitHi && a.splitHi.s) return false;
  if (a.splitLo && a.splitLo.s) return false;
  if (a.lut && a.lut.data && (a.lut.amt == null || a.lut.amt > 0)) return false;
  return true;
}
function curvesActive(c) {
  return ['l', 'r', 'g', 'b'].some((k) => c[k] && !isIdentityPts(c[k]));
}

// ---------------------------------------------------------------- 전역 톤 LUT (채널별, 감마 공간)
function buildToneLUT(A, n = 1024) {
  const br = (A.brightness || 0) / 100, ct = (A.contrast || 0) / 100;
  const bl = (A.blacks || 0) / 100, wh = (A.whites || 0) / 100, fd = clamp01((A.fade || 0) / 100);
  const bp = -bl * 0.12, wp = 1 - wh * 0.12;
  const lut = new Float32Array(n);
  const gam = Math.pow(2, -br * 0.9);
  const k = ct > 0 ? Math.pow(2, ct * 1.15) : 1;
  let active = bl !== 0 || wh !== 0 || br !== 0 || ct !== 0 || fd !== 0;
  for (let i = 0; i < n; i++) {
    let x = i / (n - 1);
    x = clamp01((x - bp) / (wp - bp));
    if (br !== 0) x = Math.pow(x, gam);
    if (ct > 0) x = x < 0.5 ? 0.5 * Math.pow(2 * x, k) : 1 - 0.5 * Math.pow(2 * (1 - x), k);
    else if (ct < 0) x = 0.5 + (x - 0.5) * (1 + ct * 0.6);
    if (fd > 0) x = fd * 0.16 + x * (1 - fd * 0.16);
    lut[i] = clamp01(x);
  }
  return { lut, active };
}

function buildHslLUT(hsl) {
  if (!hsl) return null;
  let any = false;
  const dh = new Float32Array(9), ds = new Float32Array(9), dl = new Float32Array(9);
  for (let i = 0; i < 8; i++) {
    const v = hsl[HSL_BANDS[i]];
    if (v && (v[0] || v[1] || v[2])) any = true;
    dh[i] = v ? v[0] / 100 : 0; ds[i] = v ? v[1] / 100 : 0; dl[i] = v ? v[2] / 100 : 0;
  }
  if (!any) return null;
  dh[8] = dh[0]; ds[8] = ds[0]; dl[8] = dl[0];
  const centers = HSL_CENTERS.concat([360]);
  const lut = new Float32Array(360 * 3);
  for (let deg = 0; deg < 360; deg++) {
    let k = 0;
    while (k < 7 && deg >= centers[k + 1]) k++;
    const t = (deg - centers[k]) / (centers[k + 1] - centers[k]);
    lut[deg * 3] = dh[k] * (1 - t) + dh[k + 1] * t;
    lut[deg * 3 + 1] = ds[k] * (1 - t) + ds[k + 1] * t;
    lut[deg * 3 + 2] = dl[k] * (1 - t) + dl[k + 1] * t;
  }
  return lut;
}

function tintRgb(t) { // 스플릿토닝 색 (밝기 보존 오프셋)
  hsl2rgb(((t.h % 360) + 360) % 360, 1, 0.5);
  const y = 0.2126 * _r + 0.7152 * _g + 0.0722 * _b;
  return [(_r - y) * clamp01(t.s / 100), (_g - y) * clamp01(t.s / 100), (_b - y) * clamp01(t.s / 100)];
}

// ---------------------------------------------------------------- 3D LUT (.cube)
function applyLut3D(img, lut, amt, mask) {
  const { w, h, d } = img;
  const N = lut.size, data = lut.data;
  const n1 = N - 1;
  const total = w * h;
  for (let p = 0, j = 0; p < total; p++, j += 4) {
    const m = mask ? mask[p] : 1;
    if (m < 0.004) continue;
    const r = d[j] / 255 * n1, g = d[j + 1] / 255 * n1, b = d[j + 2] / 255 * n1;
    const r0 = r | 0, g0 = g | 0, b0 = b | 0;
    const r1 = r0 < n1 ? r0 + 1 : r0, g1 = g0 < n1 ? g0 + 1 : g0, b1 = b0 < n1 ? b0 + 1 : b0;
    const fr = r - r0, fg = g - g0, fb = b - b0;
    let o0 = 0, o1 = 0, o2 = 0;
    for (let c = 0; c < 8; c++) {
      const ri = (c & 1) ? r1 : r0, gi = (c & 2) ? g1 : g0, bi = (c & 4) ? b1 : b0;
      const wt = ((c & 1) ? fr : 1 - fr) * ((c & 2) ? fg : 1 - fg) * ((c & 4) ? fb : 1 - fb);
      const idx = ((bi * N + gi) * N + ri) * 3; // .cube: R 가 가장 빠르게 변함
      o0 += data[idx] * wt; o1 += data[idx + 1] * wt; o2 += data[idx + 2] * wt;
    }
    const k = clamp01(amt) * m;
    d[j] = d[j] + (o0 * 255 - d[j]) * k;
    d[j + 1] = d[j + 1] + (o1 * 255 - d[j + 1]) * k;
    d[j + 2] = d[j + 2] + (o2 * 255 - d[j + 2]) * k;
  }
}

// ---------------------------------------------------------------- 그레인 노이즈
function noisePlane(w, h, cell, seed) {
  const nw = Math.max(2, Math.ceil(w / cell)), nh = Math.max(2, Math.ceil(h / cell));
  const p = new Float32Array(nw * nh);
  let s = (seed | 0) || 12345;
  for (let i = 0; i < p.length; i++) {
    // xorshift32 → 대략 가우시안(3개 합)
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const a = (s >>> 0) / 4294967296;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const b = (s >>> 0) / 4294967296;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    const c = (s >>> 0) / 4294967296;
    p[i] = (a + b + c) / 3 * 2 - 1; // -1..1, 중앙 집중
  }
  return cell <= 1.01 ? p : upPlane(p, nw, nh, w, h);
}

// ---------------------------------------------------------------- 메인: develop (제자리 처리)
/**
 * @param {{w:number,h:number,d:Uint8ClampedArray}} img  제자리 수정
 * @param {object} A  mergeAdj 결과(효과 파라미터)
 * @param {{mask?:Float32Array, seed?:number}} opts
 */
export function developImage(img, A, opts = {}) {
  if (!A || adjIsNeutral(A)) return img;
  const { w, h, d } = img;
  const n = w * h;
  const mn = Math.min(w, h);
  const mask = opts.mask || null;

  const exposure = A.exposure || 0;
  const temp = (A.temp || 0) / 100, tint = (A.tint || 0) / 100;
  const shadows = (A.shadows || 0) / 100, highlights = (A.highlights || 0) / 100;
  const dehaze = (A.dehaze || 0) / 100;
  const satV = (A.saturation || 0) / 100, vibV = (A.vibrance || 0) / 100;
  const hueDeg = A.hue || 0;
  const bwAmt = clamp01((A.bw || 0) / 100);

  // 1) 노이즈 제거 (공간) — 가장 먼저
  if (A.denoise > 0) {
    const dn = clamp01(A.denoise / 100);
    guidedSmooth(img, Math.max(1, Math.round((1.5 + dn * 3) * (mn / 1000))), 0.0004 + dn * 0.012);
  }

  // 2) 로컬 톤/디헤이즈용 블러 플레인
  const needLocalTone = shadows !== 0 || highlights !== 0;
  const needDehaze = dehaze !== 0;
  let Bl = null, Bmin = null;
  if (needLocalTone || needDehaze) {
    const L = lumaPlane(img);
    const sigma = Math.max(2, mn * 0.025);
    if (needLocalTone) Bl = blurPlaneFast(L, w, h, sigma);
    if (needDehaze) {
      const M = new Float32Array(n);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const r = d[j], g = d[j + 1], b = d[j + 2];
        M[i] = (r < g ? (r < b ? r : b) : (g < b ? g : b)) / 255;
      }
      Bmin = blurPlaneFast(M, w, h, Math.max(2, mn * 0.04));
    }
  }

  // 3) 상수 준비
  const exGain = Math.pow(2, (exposure / 100) * 2);
  const needLinear = exposure !== 0 || temp !== 0 || tint !== 0;
  const gR = exGain * (1 + 0.32 * temp) * (1 + 0.04 * tint);
  const gG = exGain * (1 - 0.2 * tint);
  const gB = exGain * (1 - 0.32 * temp) * (1 + 0.04 * tint);
  const shoulder = exGain > 1.0001;
  const exBlGain = Math.pow(exGain, 0.4545);

  const tone = buildToneLUT(A);
  const toneLUT = tone.lut, needTone = tone.active;
  const TN = toneLUT.length - 1;

  // 커브
  let cR = null, cG = null, cB = null;
  const clist = A.curvesList || (A.curves ? [A.curves] : []);
  if (clist.some(curvesActive)) {
    let lr = null, lg = null, lb = null;
    for (const c of clist) {
      if (!curvesActive(c)) continue;
      const lm = curveLUT(c.l), r1 = curveLUT(c.r), g1 = curveLUT(c.g), b1 = curveLUT(c.b);
      const R = composeLUT(lm, r1), G = composeLUT(lm, g1), B = composeLUT(lm, b1);
      lr = lr ? composeLUT(lr, R) : R; lg = lg ? composeLUT(lg, G) : G; lb = lb ? composeLUT(lb, B) : B;
    }
    cR = lr; cG = lg; cB = lb;
  }
  const CN = cR ? cR.length - 1 : 0;

  const needColor = satV !== 0 || vibV !== 0;
  const satK = 1 + satV;
  const hueOn = hueDeg !== 0;
  let m00 = 1, m01 = 0, m02 = 0, m10 = 0, m11 = 1, m12 = 0, m20 = 0, m21 = 0, m22 = 1;
  if (hueOn) {
    const a = (hueDeg * Math.PI) / 180, cs = Math.cos(a), sn = Math.sin(a);
    m00 = 0.213 + cs * 0.787 - sn * 0.213; m01 = 0.715 - cs * 0.715 - sn * 0.715; m02 = 0.072 - cs * 0.072 + sn * 0.928;
    m10 = 0.213 - cs * 0.213 + sn * 0.143; m11 = 0.715 + cs * 0.285 + sn * 0.14; m12 = 0.072 - cs * 0.072 - sn * 0.283;
    m20 = 0.213 - cs * 0.213 - sn * 0.787; m21 = 0.715 - cs * 0.715 + sn * 0.715; m22 = 0.072 + cs * 0.928 + sn * 0.072;
  }
  const hslLUT = buildHslLUT(A.hsl);

  const splitOn = (A.splitHi && A.splitHi.s > 0) || (A.splitLo && A.splitLo.s > 0);
  const tHi = splitOn && A.splitHi && A.splitHi.s > 0 ? tintRgb(A.splitHi) : null;
  const tLo = splitOn && A.splitLo && A.splitLo.s > 0 ? tintRgb(A.splitLo) : null;
  const pivot = 0.5 + ((A.splitBal || 0) / 100) * 0.25;

  let bwR = 0.299, bwG = 0.587, bwB = 0.114;
  if (bwAmt > 0) {
    const mix = A.bwMix || [0, 0, 0];
    bwR = Math.max(0, 0.299 + mix[0] * 0.004); bwG = Math.max(0, 0.587 + mix[1] * 0.004); bwB = Math.max(0, 0.114 + mix[2] * 0.004);
    const s = bwR + bwG + bwB || 1; bwR /= s; bwG /= s; bwB /= s;
  }

  const noMainLoop = !needLinear && !needDehaze && !needLocalTone && !needTone && !cR && !needColor && !hueOn && !hslLUT && !splitOn && bwAmt === 0;

  // 4) 메인 픽셀 루프
  if (!noMainLoop) {
    for (let p = 0, j = 0; p < n; p++, j += 4) {
      if (mask && mask[p] < 0.004) continue;
      const r0 = d[j], g0 = d[j + 1], b0 = d[j + 2];
      let r = r0 / 255, g = g0 / 255, b = b0 / 255;

      if (needLinear) {
        let lr = S2L[r0] * gR, lg = S2L[g0] * gG, lb = S2L[b0] * gB;
        if (shoulder) {
          if (lr > 0.75) { const t = (lr - 0.75) * 4; lr = 0.75 + 0.25 * t / (1 + t); }
          if (lg > 0.75) { const t = (lg - 0.75) * 4; lg = 0.75 + 0.25 * t / (1 + t); }
          if (lb > 0.75) { const t = (lb - 0.75) * 4; lb = 0.75 + 0.25 * t / (1 + t); }
        }
        r = L2S[lr >= 1 ? 4095 : lr <= 0 ? 0 : (lr * 4095 + 0.5) | 0];
        g = L2S[lg >= 1 ? 4095 : lg <= 0 ? 0 : (lg * 4095 + 0.5) | 0];
        b = L2S[lb >= 1 ? 4095 : lb <= 0 ? 0 : (lb * 4095 + 0.5) | 0];
      }

      if (needDehaze) {
        const hz = dehaze > 0 ? dehaze * 0.85 * Bmin[p] : 0;
        if (dehaze > 0) {
          const inv = 1 / (1 - hz + 1e-4);
          r = (r - hz) * inv; g = (g - hz) * inv; b = (b - hz) * inv;
        } else {
          const k = -dehaze * 0.6;
          r = r * (1 - k) + 0.82 * k; g = g * (1 - k) + 0.82 * k; b = b * (1 - k) + 0.84 * k;
        }
      }

      if (needLocalTone) {
        let bl = Bl[p] * exBlGain;
        if (bl > 1) bl = 1;
        let gain = 1;
        if (shadows > 0) gain *= 1 + shadows * 1.6 * Math.pow(1 - bl, 3);
        else if (shadows < 0) gain /= 1 - shadows * 1.6 * Math.pow(1 - bl, 3);
        if (highlights < 0) gain /= 1 - highlights * 1.0 * bl * bl * bl;
        else if (highlights > 0) gain *= 1 + highlights * 0.6 * bl * bl * bl;
        r *= gain; g *= gain; b *= gain;
      }

      if (needTone) {
        r = toneLUT[r <= 0 ? 0 : r >= 1 ? TN : (r * TN + 0.5) | 0];
        g = toneLUT[g <= 0 ? 0 : g >= 1 ? TN : (g * TN + 0.5) | 0];
        b = toneLUT[b <= 0 ? 0 : b >= 1 ? TN : (b * TN + 0.5) | 0];
      }

      if (needColor) {
        const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let s = satK;
        if (vibV !== 0) {
          const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
          const mi = r < g ? (r < b ? r : b) : (g < b ? g : b);
          const sat = mx > 1e-5 ? (mx - mi) / mx : 0;
          s *= vibV > 0 ? 1 + vibV * (1 - sat) : 1 + vibV * (0.4 + 0.6 * sat);
        }
        if (s < 0) s = 0;
        r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s;
      }

      if (hueOn) {
        const nr = m00 * r + m01 * g + m02 * b, ng = m10 * r + m11 * g + m12 * b, nb = m20 * r + m21 * g + m22 * b;
        r = nr; g = ng; b = nb;
      }

      if (hslLUT) {
        const rc = r < 0 ? 0 : r > 1 ? 1 : r, gc = g < 0 ? 0 : g > 1 ? 1 : g, bc = b < 0 ? 0 : b > 1 ? 1 : b;
        rgb2hsl(rc, gc, bc);
        if (_s > 0.02) {
          const deg = _h >= 359.999 ? 0 : _h | 0;
          const base = deg * 3;
          const wS = _s > 0.3 ? 1 : _s / 0.3;
          let hh = _h + hslLUT[base] * 30 * wS;
          if (hh < 0) hh += 360; else if (hh >= 360) hh -= 360;
          let ss = _s * (1 + hslLUT[base + 1] * wS);
          ss = ss < 0 ? 0 : ss > 1 ? 1 : ss;
          let ll = _l + hslLUT[base + 2] * 0.3 * wS * (1 - Math.abs(2 * _l - 1) * 0.6);
          ll = ll < 0 ? 0 : ll > 1 ? 1 : ll;
          hsl2rgb(hh, ss, ll);
          r = _r; g = _g; b = _b;
        }
      }

      if (cR) {
        r = cR[r <= 0 ? 0 : r >= 1 ? CN : (r * CN + 0.5) | 0];
        g = cG[g <= 0 ? 0 : g >= 1 ? CN : (g * CN + 0.5) | 0];
        b = cB[b <= 0 ? 0 : b >= 1 ? CN : (b * CN + 0.5) | 0];
      }

      if (splitOn) {
        const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (tHi) {
          const wH = smoothstep(pivot - 0.25, pivot + 0.4, y);
          r += tHi[0] * wH; g += tHi[1] * wH; b += tHi[2] * wH;
        }
        if (tLo) {
          const wL = 1 - smoothstep(pivot - 0.4, pivot + 0.25, y);
          r += tLo[0] * wL; g += tLo[1] * wL; b += tLo[2] * wL;
        }
      }

      if (bwAmt > 0) {
        const yb = bwR * r + bwG * g + bwB * b;
        r += (yb - r) * bwAmt; g += (yb - g) * bwAmt; b += (yb - b) * bwAmt;
      }

      let nr = r * 255 + 0.5, ng = g * 255 + 0.5, nb = b * 255 + 0.5;
      if (mask) {
        const m = mask[p];
        nr = r0 + (nr - r0) * m; ng = g0 + (ng - g0) * m; nb = b0 + (nb - b0) * m;
      }
      d[j] = nr < 0 ? 0 : nr > 255 ? 255 : nr;
      d[j + 1] = ng < 0 ? 0 : ng > 255 ? 255 : ng;
      d[j + 2] = nb < 0 ? 0 : nb > 255 ? 255 : nb;
    }
  }

  // 5) LUT
  if (A.lut && A.lut.data && (A.lut.amt == null || A.lut.amt > 0)) {
    applyLut3D(img, A.lut, A.lut.amt == null ? 1 : A.lut.amt, mask);
  }

  // 6) 디테일 (공간)
  if (A.clarity) unsharp(img, Math.max(2, mn * 0.02), (A.clarity / 100) * 0.9);
  if (A.texture) unsharp(img, Math.max(0.8, mn * 0.0035), (A.texture / 100) * 1.1);
  if (A.sharpen > 0) unsharp(img, Math.max(0.6, mn * 0.0012), (A.sharpen / 100) * 1.6, 2);

  // 7) 비네팅 / 그레인
  const vig = (A.vignette || 0) / 100;
  const grain = (A.grain || 0) / 100;
  if (vig !== 0 || grain > 0) {
    const vSize = (A.vigSize == null ? DEFAULTS.vigSize : A.vigSize) / 100;
    const vFeather = (A.vigFeather == null ? DEFAULTS.vigFeather : A.vigFeather) / 100;
    const vRound = (A.vigRound == null ? DEFAULTS.vigRound : A.vigRound) / 100;
    const inner = 0.15 + (1 - vSize) * 0.8;
    const width = 0.15 + vFeather * 0.9;
    const aspect = w / h;
    const gsz = (A.grainSize == null ? DEFAULTS.grainSize : A.grainSize) / 100;
    let noise = null;
    if (grain > 0) noise = noisePlane(w, h, Math.max(1, (0.8 + gsz * 2.6) * (mn / 1080)), opts.seed || 7);
    for (let y = 0; y < h; y++) {
      const dy = ((y + 0.5) / h) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const p = y * w + x, j = p * 4;
        const m = mask ? mask[p] : 1;
        if (m < 0.004) continue;
        let r = d[j], g = d[j + 1], b = d[j + 2];
        if (vig !== 0) {
          const dx = ((x + 0.5) / w) * 2 - 1;
          // 원형↔타원 보간
          const ex = dx * (1 + (aspect - 1) * vRound * (aspect > 1 ? 1 : 0));
          const ey = dy * (1 + (1 / aspect - 1) * vRound * (aspect < 1 ? 1 : 0));
          const dist = Math.sqrt(ex * ex + ey * ey) * 0.8165; // 모서리 ≈ 1.15
          const v = smoothstep(inner, inner + width, dist) * m;
          if (vig < 0) { const k = 1 + vig * 0.95 * v; r *= k; g *= k; b *= k; }
          else { const k = vig * 0.7 * v; r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
        }
        if (grain > 0) {
          const y01 = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          const amp = grain * 42 * (0.35 + 0.65 * (1 - Math.abs(2 * y01 - 1))) * m;
          const nv = noise[p] * amp;
          r += nv; g += nv; b += nv;
        }
        d[j] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[j + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[j + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
    }
  }
  return img;
}

/** 마스크 영역에만 보정 적용 (공간 필터 포함) */
export function developMasked(img, A, mask, opts = {}) {
  if (!A || adjIsNeutral(A)) return img;
  const copy = cloneImg(img);
  developImage(copy, A, { ...opts, mask: null });
  const d = img.d, c = copy.d, n = img.w * img.h;
  for (let p = 0, j = 0; p < n; p++, j += 4) {
    const m = mask[p];
    if (m < 0.004) continue;
    d[j] += (c[j] - d[j]) * m; d[j + 1] += (c[j + 1] - d[j + 1]) * m; d[j + 2] += (c[j + 2] - d[j + 2]) * m;
  }
  return img;
}

// ---------------------------------------------------------------- 분석: 히스토그램 / 자동 보정
export function histogram(img, step = 3) {
  const { w, h, d } = img;
  const hist = new Uint32Array(256 * 4); // R,G,B,L
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const j = (y * w + x) * 4;
      if (d[j + 3] < 8) continue;
      const r = d[j], g = d[j + 1], b = d[j + 2];
      hist[r]++; hist[256 + g]++; hist[512 + b]++;
      hist[768 + ((0.2126 * r + 0.7152 * g + 0.0722 * b + 0.5) | 0)]++;
    }
  }
  return hist;
}

/** 히스토그램 기반 자동 보정 제안 (adj 값 객체) */
export function autoEnhance(img) {
  const hist = histogram(img, 2);
  const L = hist.subarray(768, 1024);
  let total = 0;
  for (let i = 0; i < 256; i++) total += L[i];
  if (!total) return {};
  const pct = (q) => { let s = 0; for (let i = 0; i < 256; i++) { s += L[i]; if (s >= total * q) return i / 255; } return 1; };
  const p01 = pct(0.01), p50 = pct(0.5), p99 = pct(0.99);
  let mean = 0;
  for (let i = 0; i < 256; i++) mean += (i / 255) * L[i];
  mean /= total;
  const out = {};
  out.exposure = Math.round(clamp((0.46 - p50) * 110, -45, 45));
  out.contrast = Math.round(clamp((0.78 - (p99 - p01)) * 60, -10, 30));
  out.shadows = Math.round(clamp((0.22 - p01) * 120 + (0.4 - mean) * 40, 0, 45));
  out.highlights = Math.round(clamp((p99 - 0.94) * -400, -40, 0));
  out.whites = Math.round(clamp((0.985 - p99) * 150, -10, 15));
  out.blacks = Math.round(clamp((p01 - 0.03) * -150, -15, 0));
  out.vibrance = 18;
  out.saturation = 6;
  // 회색 세계 가정 색온도
  const hr = hist.subarray(0, 256), hg = hist.subarray(256, 512), hb = hist.subarray(512, 768);
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 256; i++) { mr += i * hr[i]; mg += i * hg[i]; mb += i * hb[i]; }
  mr /= total; mg /= total; mb /= total;
  const avg = (mr + mg + mb) / 3 || 1;
  const warm = clamp(((mb - mr) / avg) * 50, -18, 18); // 푸르면 + (따뜻하게)
  out.temp = Math.round(warm);
  return out;
}
