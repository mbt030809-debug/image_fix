// 경계 정밀화: 모델의 거친 확률맵(320px)을 "띠 안에서만" 고해상도로 다듬는다. 순수 함수(DOM 없음).
//  1) 확률맵을 작업 해상도로 키우고, 애매한 곳(확률 0.08~0.92) + 경계 주변을 미확정 띠로 만든다
//  2) Canny 가장자리(블러 → Sobel → 비최대 억제 → 이중 임계값 + 히스테리시스)를 구해 그래프컷의 "자르기 쉬운 선"으로 쓴다
//  3) 색 + 가장자리 그래프컷으로 띠 안을 인물/배경으로 확정(refineMask)
//  4) 가이디드 필터로 머리카락 같은 반투명 경계(알파)를 만든다
import { refineMask, signedDistance, components } from './autoselect.js';

/** 이중선형 확대/축소(Float32) */
export function resizeF(src, sw, sh, w, h) {
  const out = new Float32Array(w * h), sx = sw / w, sy = sh / h;
  for (let j = 0; j < h; j++) {
    const fy = Math.max(0, Math.min(sh - 1, (j + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let i = 0; i < w; i++) {
      const fx = Math.max(0, Math.min(sw - 1, (i + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      out[j * w + i] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    }
  }
  return out;
}

function gaussKernel(sigma) { const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1); let s = 0; for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; } for (let i = 0; i < k.length; i++) k[i] /= s; return k; }
export function blur(src, w, h, sigma) {
  const k = gaussKernel(sigma), r = (k.length - 1) >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let t = -r; t <= r; t++) a += src[y * w + Math.min(w - 1, Math.max(0, x + t))] * k[t + r]; tmp[y * w + x] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let t = -r; t <= r; t++) a += tmp[Math.min(h - 1, Math.max(0, y + t)) * w + x] * k[t + r]; out[y * w + x] = a; }
  return out;
}
export function luma(rgba, n) { const g = new Float32Array(n); for (let i = 0; i < n; i++) g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]; return g; }

/**
 * Canny. mask(선택)가 있으면 그 안의 그래디언트 분포로 임계값을 정한다(상위 hiPct% 가 strong, low = hi*loRatio).
 * 반환 Uint8(0/1). 블러 sigma 는 해상도에 비례하게 쓴다.
 */
export function canny(rgba, w, h, opts = {}) {
  const n = w * h, sigma = opts.sigma || Math.max(0.8, 0.0012 * Math.max(w, h)), g = blur(luma(rgba, n), w, h, sigma);
  const mag = new Float32Array(n), dir = new Uint8Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = (g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - 1] + g[i + w - 1]);
    const gy = (g[i + w - 1] + 2 * g[i + w] + g[i + w + 1]) - (g[i - w - 1] + 2 * g[i - w] + g[i - w + 1]);
    mag[i] = Math.hypot(gx, gy);
    const a = Math.abs(gx), b = Math.abs(gy); // 방향을 4가지로 양자화: 0=가로변화(세로선) 1=대각 / 2=세로변화 3=대각 \
    dir[i] = b <= a * 0.4142 ? 0 : b >= a * 2.4142 ? 2 : (gx * gy > 0 ? 1 : 3);
  }
  const nms = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, m = mag[i]; if (m === 0) continue;
    let a, b;
    switch (dir[i]) { case 0: a = mag[i - 1]; b = mag[i + 1]; break; case 2: a = mag[i - w]; b = mag[i + w]; break; case 1: a = mag[i - w - 1]; b = mag[i + w + 1]; break; default: a = mag[i - w + 1]; b = mag[i + w - 1]; }
    if (m >= a && m >= b) nms[i] = m;
  }
  // 임계값: 관심 영역(mask)의 nms 분포에서 정한다
  const vals = []; for (let i = 0; i < n; i += 1) if (nms[i] > 0 && (!opts.mask || opts.mask[i])) vals.push(nms[i]);
  vals.sort((p, q) => p - q);
  const hiPct = opts.hiPct != null ? opts.hiPct : 0.8, hi = opts.hi != null ? opts.hi : (vals.length ? vals[Math.floor(vals.length * hiPct)] : 1e9), lo = hi * (opts.loRatio != null ? opts.loRatio : 0.4);
  const out = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
  for (let i = 0; i < n; i++) if (nms[i] >= hi) { out[i] = 1; stack[sp++] = i; }
  while (sp) { // 히스테리시스: strong 에 이어진 weak 만 살린다
    const p = stack[--sp], x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const q = yy * w + xx; if (!out[q] && nms[q] >= lo) { out[q] = 1; stack[sp++] = q; }
    }
  }
  return out;
}

function box(src, w, h, r) { // 평균 필터(적분 이미지)
  const W1 = w + 1, I = new Float64Array(W1 * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
  for (let y = 0; y < h; y++) { const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1); for (let x = 0; x < w; x++) { const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1); out[y * w + x] = (I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0]) / ((x1 - x0) * (y1 - y0)); } }
  return out;
}
/** 가이디드 필터(He et al.): guide(0..1 밝기) 의 구조를 따라 src 를 부드럽게 — 이진 마스크 → 알파 */
export function guidedFilter(guide, src, w, h, r, eps) {
  const n = w * h, mI = box(guide, w, h, r), mP = box(src, w, h, r), Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = guide[i] * src[i]; II[i] = guide[i] * guide[i]; }
  const mIp = box(Ip, w, h, r), mII = box(II, w, h, r), a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) { const cov = mIp[i] - mI[i] * mP[i], v = mII[i] - mI[i] * mI[i]; a[i] = cov / (v + eps); b[i] = mP[i] - a[i] * mI[i]; }
  const ma = box(a, w, h, r), mb = box(b, w, h, r), q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * guide[i] + mb[i]));
  return q;
}

/** 인물 안쪽에 갇힌 작은 구멍(전체 인물의 maxFrac 이하)을 메운다 */
export function fillHoles(bin, w, h, maxFrac) {
  const n = w * h, inv = new Uint8Array(n); let fg = 0; for (let i = 0; i < n; i++) { inv[i] = bin[i] ? 0 : 255; if (bin[i]) fg++; }
  const { lab, areas } = components(inv, w, h), touch = new Uint8Array(areas.length);
  for (let x = 0; x < w; x++) { if (lab[x] >= 0) touch[lab[x]] = 1; if (lab[(h - 1) * w + x] >= 0) touch[lab[(h - 1) * w + x]] = 1; }
  for (let y = 0; y < h; y++) { if (lab[y * w] >= 0) touch[lab[y * w]] = 1; if (lab[y * w + w - 1] >= 0) touch[lab[y * w + w - 1]] = 1; }
  const out = Uint8Array.from(bin), lim = fg * maxFrac;
  for (let i = 0; i < n; i++) { const c = lab[i]; if (c >= 0 && !touch[c] && areas[c] <= lim) out[i] = 255; }
  return out;
}
function dilate(bin, w, h, r) { // 거리 기반 팽창
  const d = signedDistance(bin, w, h, r + 1), out = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) out[i] = d[i] > -r ? 1 : 0; return out;
}

/**
 * 모델 확률맵(sal: sz×sz, 0..255 또는 0..1 Float)을 작업 해상도(w×h)의 마스크로 정밀화한다.
 * opts: { steps: { cut, canny, matte } (비교용 스위치), bandFrac(기본 0.012), eps }
 * 반환 { alpha: Float32(0..1), bin: Uint8(0/255), ms: {단계별 시간} }
 */
export function refineFromLasso(rgba, w, h, sal, sz, lasso, opts = {}) {
  const n0 = w * h, long0 = Math.max(w, h), salF0 = sal instanceof Float32Array ? sal : Float32Array.from(sal, (v) => v / 255), p0 = resizeF(salF0, sz, sz, w, h);
  let lN = 0, cN = 0; for (let i = 0; i < n0; i++) if (lasso[i] >= 128) { lN++; if (p0[i] >= 0.5) cN++; }
  if (opts.mode !== 'hint' && lN && cN / lN >= (opts.trust != null ? opts.trust : 0.15)) {
    // 모델이 올가미 안에서 인물을 잘 찾았다 → 모델을 믿고 올가미는 "범위 제한"으로만 쓴다(올가미가 넉넉해도 배경이 안 딸려 옴)
    const reg = dilate(Uint8Array.from(lasso, (v) => (v >= 128 ? 1 : 0)), w, h, Math.max(2, Math.round(0.01 * long0))), pm = new Float32Array(n0);
    for (let i = 0; i < n0; i++) pm[i] = reg[i] ? p0[i] : 0;
    const r = refineFromProb(rgba, w, h, pm, w, { largest: true, szIsFull: true });
    return { alpha: r.alpha, bin: r.bin, ms: r.ms, ok: true, mode: 'model' };
  }
  return refineHint(rgba, w, h, sal, sz, lasso, opts);
}
function refineHint(rgba, w, h, sal, sz, lasso, opts = {}) {
  // 올가미 = 힌트(깊은 안쪽 인물, 깊은 바깥 배경), 모델 확률 = 띠 안의 한 표, 색 + Canny 가장자리 = 경계 위치
  const T = (() => { let t = Date.now(); return (k, o) => { const n = Date.now(); o[k] = n - t; t = n; }; })(), ms = {};
  const n = w * h, long = Math.max(w, h), bandPx = Math.max(3, (opts.bandFrac != null ? opts.bandFrac : 0.04) * long);
  const salF = sal instanceof Float32Array ? sal : Float32Array.from(sal, (v) => v / 255), p = resizeF(salF, sz, sz, w, h);
  const bin = new Uint8Array(n); for (let i = 0; i < n; i++) bin[i] = lasso[i] >= 128 ? 255 : 0;
  const d = signedDistance(bin, w, h, bandPx + 1), unknown = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (Math.abs(d[i]) <= bandPx) unknown[i] = 1;
  T('band', ms);
  const edge = dilate(canny(rgba, w, h, { mask: unknown }), w, h, 1); T('canny', ms);
  const r = refineMask(rgba, w, h, bin, { unknown, edge, band: bandPx, prior: opts.prior != null ? opts.prior : 0.6, prob: p, probW: opts.probW != null ? opts.probW : 1.5 });
  const out = r.ok ? fillHoles(r.mask, w, h, 0.03) : bin; T('cut', ms);
  const alpha = new Float32Array(n);
  const g = luma(rgba, n), m = new Float32Array(n); for (let i = 0; i < n; i++) { g[i] /= 255; m[i] = out[i] ? 1 : 0; }
  const q = guidedFilter(g, m, w, h, Math.max(2, Math.round(0.006 * long)), 1e-3), ub = dilate(unknown, w, h, 1);
  for (let i = 0; i < n; i++) alpha[i] = ub[i] ? q[i] : m[i]; T('matte', ms);
  return { alpha, bin: out, ms, ok: r.ok, why: r.why, mode: 'hint' };
}

const SMOOTH = 4; // 그래프컷 매끄러움(작을수록 가는 팔·머리카락을 덜 깎고 빠르다 — 평가로 14·8·4·2 중 선택)
const UNC = 2.5; // 모델이 애매한 곳을 다시 판정할 경계 거리(띠 폭의 배수)
export function refineFromProb(rgba, w, h, sal, sz, opts = {}) {
  const T = (() => { let t = Date.now(); return (k, o) => { const n = Date.now(); o[k] = n - t; t = n; }; })(), ms = {};
  const long = Math.max(w, h), n = w * h, steps = Object.assign({ cut: true, canny: true, matte: true }, opts.steps || {});
  const salF = sal instanceof Float32Array ? sal : Float32Array.from(sal, (v) => v / 255);
  const p = opts.szIsFull ? salF : resizeF(salF, sz, sz, w, h); T('upsample', ms); // szIsFull: 이미 작업 해상도(w×h)인 확률맵
  const bin = new Uint8Array(n); for (let i = 0; i < n; i++) bin[i] = p[i] >= 0.5 ? 255 : 0;
  const bandPx = Math.max(2, (opts.bandFrac != null ? opts.bandFrac : 0.012) * long);
  // 미확정 띠 = 모델이 애매한 곳 ∪ 경계에서 bandPx 이내
  const d = signedDistance(bin, w, h, bandPx * UNC + 1), unknown = new Uint8Array(n); let un = 0;
  for (let i = 0; i < n; i++) if (Math.abs(d[i]) <= bandPx || (p[i] > 0.06 && p[i] < 0.94 && Math.abs(d[i]) <= bandPx * UNC)) { unknown[i] = 1; un++; } // 경계 근처 + 모델이 애매한 곳(가는 팔·머리카락). 몸 깊은 곳의 애매한 곳은 건드리지 않는다(옷이 배경 색과 비슷해 구멍이 나던 문제)
  T('band', ms);
  let out = bin;
  if (steps.cut) {
    const edge = steps.canny ? dilate(canny(rgba, w, h, { mask: unknown }), w, h, 1) : null; T('canny', ms);
    const r = refineMask(rgba, w, h, bin, { unknown, edge, band: bandPx, prior: 1.2, prob: p, probW: opts.probW != null ? opts.probW : 2.5, smooth: opts.smooth != null ? opts.smooth : SMOOTH }); // 모델 확률도 한 표(색만으로 옷이 배경 색과 비슷할 때 잘못 자르는 걸 막는다)
    if (r.ok) out = fillHoles(r.mask, w, h, 0.03); ms.cutOk = r.ok ? 1 : 0; T('cut', ms);
  }
  const alpha = new Float32Array(n);
  if (steps.matte) {
    // 이진 → 알파: 미확정 띠에서만 가이디드 필터 결과를 쓴다
    const g = luma(rgba, n), m = new Float32Array(n); for (let i = 0; i < n; i++) { g[i] /= 255; m[i] = out[i] ? 1 : 0; }
    const q = guidedFilter(g, m, w, h, Math.max(2, Math.round(0.006 * long)), opts.eps || 1e-3);
    const ub = dilate(unknown, w, h, 1);
    for (let i = 0; i < n; i++) alpha[i] = ub[i] ? q[i] : m[i];
    T('matte', ms);
  } else for (let i = 0; i < n; i++) alpha[i] = out[i] ? 1 : 0;
  if (opts.largest) { // 가장 큰 덩어리(인물) + 그 가까이에 있는 조각(가는 팔·손·머리카락 가닥)만 남기고 나머지는 지운다
    const { lab, areas } = components(out, w, h);
    if (areas.length > 1) {
      let bi = 0; areas.forEach((a, i) => { if (a > areas[bi]) bi = i; });
      const main = new Uint8Array(n); for (let i = 0; i < n; i++) main[i] = lab[i] === bi ? 1 : 0;
      const near = dilate(main, w, h, Math.max(3, Math.round(0.06 * long))), keepC = new Uint8Array(areas.length);
      keepC[bi] = 1; for (let i = 0; i < n; i++) if (lab[i] >= 0 && near[i] && areas[lab[i]] >= areas[bi] * 0.01) keepC[lab[i]] = 1;
      const keep = new Uint8Array(n); for (let i = 0; i < n; i++) keep[i] = lab[i] >= 0 && keepC[lab[i]] ? 1 : 0;
      const kd = dilate(keep, w, h, 3); for (let i = 0; i < n; i++) { if (!kd[i]) alpha[i] = 0; if (!keep[i] && out[i]) out[i] = 0; }
    }
  }
  return { alpha, bin: out, ms, unknownFrac: un / n };
}
