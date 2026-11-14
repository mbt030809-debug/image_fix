// 블러·샤프닝·가이디드 필터 (Float32 플레인 기반, O(n))
import { clamp, lumaPlane } from './util.js';

/** 가우시안 근사를 위한 박스 폭 (Kutskir) */
export function boxesForGauss(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

function boxH(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let y = 0; y < h; y++) {
    let ti = y * w, li = ti, ri = ti + r;
    const fv = src[ti], lv = src[ti + w - 1];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j];
    for (let j = 0; j <= r; j++) { val += src[ri++] - fv; dst[ti++] = val * iarr; }
    for (let j = r + 1; j < w - r; j++) { val += src[ri++] - src[li++]; dst[ti++] = val * iarr; }
    for (let j = w - r; j < w; j++) { val += lv - src[li++]; dst[ti++] = val * iarr; }
  }
}

function boxV(src, dst, w, h, r) {
  const iarr = 1 / (r + r + 1);
  for (let x = 0; x < w; x++) {
    let ti = x, li = ti, ri = ti + r * w;
    const fv = src[ti], lv = src[ti + w * (h - 1)];
    let val = (r + 1) * fv;
    for (let j = 0; j < r; j++) val += src[ti + j * w];
    for (let j = 0; j <= r; j++) { val += src[ri] - fv; dst[ti] = val * iarr; ri += w; ti += w; }
    for (let j = r + 1; j < h - r; j++) { val += src[ri] - src[li]; dst[ti] = val * iarr; li += w; ri += w; ti += w; }
    for (let j = h - r; j < h; j++) { val += lv - src[li]; dst[ti] = val * iarr; li += w; ti += w; }
  }
}

function safeR(r, w, h) {
  const m = Math.floor((Math.min(w, h) - 1) / 2) - 1;
  return Math.max(0, Math.min(Math.round(r), m));
}

/** 박스 평균 1회 (반경 r). 새 플레인 반환 */
export function boxMean(plane, w, h, r) {
  r = safeR(r, w, h);
  if (r < 1) return Float32Array.from(plane);
  const a = new Float32Array(plane.length), b = new Float32Array(plane.length);
  boxH(plane, a, w, h, r);
  boxV(a, b, w, h, r);
  return b;
}

/** 가우시안 블러(3패스 박스). 새 플레인 반환 */
export function blurPlane(plane, w, h, sigma) {
  if (sigma < 0.4) return Float32Array.from(plane);
  const sizes = boxesForGauss(sigma, 3);
  let a = Float32Array.from(plane);
  let b = new Float32Array(plane.length);
  for (let i = 0; i < 3; i++) {
    const r = safeR((sizes[i] - 1) / 2, w, h);
    if (r < 1) continue;
    boxH(a, b, w, h, r);
    boxV(b, a, w, h, r);
  }
  return a;
}

/** 플레인 반 해상도 축소 (2x2 평균) */
export function halfPlane(p, w, h) {
  const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1);
  const o = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1);
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1);
      o[y * nw + x] = (p[y0 * w + x0] + p[y0 * w + x1] + p[y1 * w + x0] + p[y1 * w + x1]) * 0.25;
    }
  }
  return { p: o, w: nw, h: nh };
}

/** 플레인 양선형 확대 (목표 크기로) */
export function upPlane(p, w, h, nw, nh) {
  const o = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = Math.max(0, Math.min(h - 1, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = Math.max(0, Math.min(w - 1, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
      const a = p[y0 * w + x0] * (1 - tx) + p[y0 * w + x1] * tx;
      const b = p[y1 * w + x0] * (1 - tx) + p[y1 * w + x1] * tx;
      o[y * nw + x] = a * (1 - ty) + b * ty;
    }
  }
  return o;
}

/** 큰 반경 블러를 빠르게: 필요하면 축소→블러→확대 */
export function blurPlaneFast(plane, w, h, sigma) {
  let p = plane, pw = w, ph = h, s = sigma, shrink = 0;
  while (s > 6 && pw > 64 && ph > 64 && shrink < 3) {
    const r = halfPlane(p, pw, ph);
    p = r.p; pw = r.w; ph = r.h; s /= 2; shrink++;
  }
  const b = blurPlane(p, pw, ph, s);
  if (shrink === 0) return b;
  return upPlane(b, pw, ph, w, h);
}

/** RGBA 이미지의 RGB 채널을 가우시안 블러 (알파 유지). 새 Uint8ClampedArray 반환 */
export function blurRGBA(img, sigma) {
  const { w, h, d } = img;
  const out = new Uint8ClampedArray(d.length);
  const n = w * h;
  const plane = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0, j = c; i < n; i++, j += 4) plane[i] = d[j];
    const b = blurPlane(plane, w, h, sigma);
    for (let i = 0, j = c; i < n; i++, j += 4) out[j] = b[i];
  }
  for (let i = 3; i < d.length; i += 4) out[i] = d[i];
  return out;
}

/** 휘도 기반 언샤프 마스크. amount: 0..N, radius: 픽셀 sigma */
export function unsharp(img, sigma, amount, threshold = 0) {
  if (amount === 0 || sigma <= 0) return;
  const { w, h, d } = img;
  const n = w * h;
  const L = lumaPlane(img);
  const B = blurPlaneFast(L, w, h, sigma);
  const amt = amount * 255;
  const th = threshold / 255;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let diff = L[i] - B[i];
    if (th > 0) {
      const a = Math.abs(diff);
      diff = a < th ? 0 : diff - Math.sign(diff) * th * 0.5;
    }
    const v = diff * amt;
    if (v === 0) continue;
    const r = d[j] + v, g = d[j + 1] + v, b = d[j + 2] + v;
    d[j] = r < 0 ? 0 : r > 255 ? 255 : r;
    d[j + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[j + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

/** 가이드(휘도) 기반 엣지 보존 스무딩. eps: 0..1 (작을수록 엣지 강하게 보존) */
export function guidedSmooth(img, r, eps, mask) {
  const { w, h, d } = img;
  const n = w * h;
  r = Math.max(1, Math.round(r));
  const I = lumaPlane(img);
  const meanI = boxMean(I, w, h, r);
  const II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const corrI = boxMean(II, w, h, r);
  const varI = new Float32Array(n);
  for (let i = 0; i < n; i++) varI[i] = corrI[i] - meanI[i] * meanI[i];
  const p = new Float32Array(n), Ip = new Float32Array(n);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    for (let i = 0, j = c; i < n; i++, j += 4) { const v = d[j] / 255; p[i] = v; Ip[i] = I[i] * v; }
    const meanP = boxMean(p, w, h, r);
    const corrIp = boxMean(Ip, w, h, r);
    for (let i = 0; i < n; i++) {
      const cov = corrIp[i] - meanI[i] * meanP[i];
      const ai = cov / (varI[i] + eps);
      a[i] = ai;
      b[i] = meanP[i] - ai * meanI[i];
    }
    const ma = boxMean(a, w, h, r), mb = boxMean(b, w, h, r);
    for (let i = 0, j = c; i < n; i++, j += 4) {
      let q = (ma[i] * I[i] + mb[i]) * 255;
      if (mask) q = d[j] + (q - d[j]) * mask[i];
      d[j] = q < 0 ? 0 : q > 255 ? 255 : q;
    }
  }
}

/** 마스크(0..1 Float32) 가장자리를 부드럽게 */
export function featherMask(mask, w, h, sigma) {
  return blurPlaneFast(mask, w, h, Math.max(0.5, sigma));
}

export { clamp };
