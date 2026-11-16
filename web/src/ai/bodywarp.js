// 체형 보정 엔진(순수 함수 — Node 에서도 시험한다): 인물(마스크)만 변형하고 배경은 그대로 둔다.
//  1) 변형(ops)은 "되돌려 찾기"(backward mapping)로 인물 픽셀과 새 인물 마스크를 만든다.
//  2) 인물이 줄어서 드러난 자리(=예전 인물 마스크 − 새 인물 마스크)는 주변 배경으로 채운다(push-pull 확산 + 입자감).
//  3) 결과 패치는 "바뀐 곳(구멍)"에만 불투명, 나머지는 투명 → 이 패치를 레이어로 얹으면 배경의 다른 곳은 한 픽셀도 바뀌지 않는다.
// 모든 좌표는 영역(region) 픽셀. ops: {kind:'width', y0, y1, amt} 가로 폭 · {kind:'height', y0, y1, amt} 세로 길이 · {kind:'bulge', cx, cy, r, amt} 확대/축소
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1), 0, 1); return t * t * (3 - 2 * t); };

/** 밴드 가중치: 위·아래 25% 에서 부드럽게 0 → 가운데 1 */
function bandWeight(y, y0, y1) {
  const L = Math.max(1e-6, y1 - y0), r = 0.25 * L;
  return smooth(y0, y0 + r, y) * (1 - smooth(y1 - r, y1, y));
}

/** 행마다 인물의 가로 중심(질량 중심) — 부드럽게 다듬고 빈 행은 가까운 행 값으로 */
export function rowCenters(mask, w, h) {
  const cx = new Float32Array(h), has = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0, m = 0;
    for (let x = 0, i = y * w; x < w; x++, i++) { const v = mask[i]; if (v > 127) { s += x * v; m += v; } }
    if (m > 0) { cx[y] = s / m; has[y] = 1; }
  }
  let last = -1;
  for (let y = 0; y < h; y++) { if (has[y]) { for (let k = last + 1; k < y && last >= 0; k++) cx[k] = cx[last]; if (last < 0) for (let k = 0; k < y; k++) cx[k] = cx[y]; last = y; } }
  for (let y = last + 1; y < h && last >= 0; y++) cx[y] = cx[last];
  if (last < 0) cx.fill(w / 2);
  const R = Math.max(2, Math.round(h * 0.02)), out = new Float32Array(h);
  for (let y = 0; y < h; y++) { let s = 0, n = 0; for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R); k++) { s += cx[k]; n++; } out[y] = s / n; }
  return out;
}

/** 한 변형의 "되돌려 찾기": 결과 좌표 (x,y) → 원본 좌표 */
function backward(op, x, y, ctx) {
  if (op.kind === 'width') {
    const wgt = bandWeight(y, op.y0, op.y1);
    const f = 1 + op.amt * wgt;
    const c = ctx.cx[clamp(Math.round(y), 0, ctx.h - 1)];
    return [c + (x - c) / f, y];
  }
  if (op.kind === 'height') {
    const L = op.y1 - op.y0, k = op.amt;
    if (y <= op.y0) return [x, y];
    const y1n = op.y0 + L * (1 + k);
    if (y <= y1n) return [x, op.y0 + (y - op.y0) / (1 + k)];
    return [x, y - L * k];
  }
  if (op.kind === 'bulge') {
    const dx = x - op.cx, dy = y - op.cy, d = Math.hypot(dx, dy), t = d / op.r;
    if (t >= 1) return [x, y];
    const f = 1 - op.amt * (1 - t * t) * (1 - t * t);
    return [op.cx + dx * f, op.cy + dy * f];
  }
  return [x, y];
}

function sampleRGBA(src, w, h, x, y, out) {
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, d = (y1 * w + x1) * 4;
  for (let k = 0; k < 3; k++) out[k] = (src[a + k] * (1 - fx) + src[b + k] * fx) * (1 - fy) + (src[c + k] * (1 - fx) + src[d + k] * fx) * fy;
}
function sampleMask(m, w, h, x, y) {
  x = clamp(x, 0, w - 1); y = clamp(y, 0, h - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = x - x0, fy = y - y0;
  return (m[y0 * w + x0] * (1 - fx) + m[y0 * w + x1] * fx) * (1 - fy) + (m[y1 * w + x0] * (1 - fx) + m[y1 * w + x1] * fx) * fy;
}

/** 상자 팽창(max) — 반지름 r */
function dilate(m, w, h, r) {
  if (r <= 0) return m.slice();
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) if (m[y * w + k]) v = 1; tmp[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) if (tmp[k * w + x]) v = 1; out[y * w + x] = v; }
  return out;
}
/** 상자 흐림(0/1 → 0..1) */
function boxBlur01(m, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; for (let k = -r; k <= r; k++) s += m[y * w + clamp(k, 0, w - 1)]; for (let x = 0; x < w; x++) { tmp[y * w + x] = s / n; s += m[y * w + clamp(x + r + 1, 0, w - 1)] - m[y * w + clamp(x - r, 0, w - 1)]; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[clamp(k, 0, h - 1) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / n; s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; } }
  return out;
}

/**
 * push-pull 채우기: known(1)인 픽셀 색을 피라미드로 모아 모르는(0) 곳으로 번지게 한다. 반환: RGB Float32Array(3*N)
 */
export function pushPullFill(rgba, known, w, h) {
  const levels = [];
  let cw = w, ch = h;
  let c = new Float32Array(cw * ch * 3), a = new Float32Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) if (known[i]) { c[i * 3] = rgba[i * 4]; c[i * 3 + 1] = rgba[i * 4 + 1]; c[i * 3 + 2] = rgba[i * 4 + 2]; a[i] = 1; }
  levels.push({ w: cw, h: ch, c, a });
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, (cw + 1) >> 1), nh = Math.max(1, (ch + 1) >> 1);
    const nc = new Float32Array(nw * nh * 3), na = new Float32Array(nw * nh);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const i = y * cw + x, j = (y >> 1) * nw + (x >> 1); na[j] += a[i]; nc[j * 3] += c[i * 3]; nc[j * 3 + 1] += c[i * 3 + 1]; nc[j * 3 + 2] += c[i * 3 + 2]; }
    levels.push({ w: nw, h: nh, c: nc, a: na });
    cw = nw; ch = nh; c = nc; a = na;
  }
  let est = null; // 위 단계(더 거친) 추정, 그 단계 크기
  for (let L = levels.length - 1; L >= 0; L--) {
    const { w: lw, h: lh, c: lc, a: la } = levels[L];
    const area = 4 ** L, cur = new Float32Array(lw * lh * 3);
    for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
      const i = y * lw + x;
      let er = 128, eg = 128, eb = 128;
      if (est) { const j = Math.min(est.h - 1, y >> 1) * est.w + Math.min(est.w - 1, x >> 1); er = est.v[j * 3]; eg = est.v[j * 3 + 1]; eb = est.v[j * 3 + 2]; }
      const cov = Math.min(1, la[i] / Math.min(area, 1e9));
      if (la[i] > 0) { const ar = lc[i * 3] / la[i], ag = lc[i * 3 + 1] / la[i], ab = lc[i * 3 + 2] / la[i]; cur[i * 3] = ar * cov + er * (1 - cov); cur[i * 3 + 1] = ag * cov + eg * (1 - cov); cur[i * 3 + 2] = ab * cov + eb * (1 - cov); }
      else { cur[i * 3] = er; cur[i * 3 + 1] = eg; cur[i * 3 + 2] = eb; }
    }
    est = { w: lw, h: lh, v: cur };
  }
  return est.v;
}

function prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/**
 * 인물만 변형한 패치를 만든다.
 * src: RGBA(영역), mask: 인물 마스크 Uint8(0..255, 이미 부드러운 가장자리), ops: 변형 목록(영역 픽셀 좌표)
 * 반환 {rgba: Uint8ClampedArray(바뀐 곳만 불투명), newMask: Uint8Array, hole: Uint8Array(0/1), changed: 구멍 픽셀 수}
 */
export function warpSubject(src, w, h, mask, ops, opts = {}) {
  const N = w * h;
  const ctx = { w, h, cx: rowCenters(mask, w, h) };
  const wm = new Float32Array(N), warped = new Float32Array(N * 3), px = [0, 0, 0];
  const list = ops || [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sx = x, sy = y;
    for (let k = list.length - 1; k >= 0; k--) { const r = backward(list[k], sx, sy, ctx); sx = r[0]; sy = r[1]; }
    const i = y * w + x;
    wm[i] = list.length ? sampleMask(mask, w, h, sx, sy) / 255 : mask[i] / 255;
    sampleRGBA(src, w, h, sx, sy, px);
    warped[i * 3] = px[0]; warped[i * 3 + 1] = px[1]; warped[i * 3 + 2] = px[2];
  }
  // 바뀌는 곳(구멍): 예전 인물 ∪ 새 인물 을 조금 키운 영역
  const u = new Uint8Array(N);
  for (let i = 0; i < N; i++) u[i] = mask[i] > 8 || wm[i] > 0.03 ? 1 : 0;
  const hole = dilate(u, w, h, Math.max(2, Math.round(Math.max(w, h) * 0.004)));
  const known = new Uint8Array(N);
  let kn = 0;
  for (let i = 0; i < N; i++) { known[i] = hole[i] ? 0 : 1; kn += known[i]; }
  const fill = kn ? pushPullFill(src, known, w, h) : new Float32Array(N * 3).fill(128);
  // 입자감: 구멍 둘레의 알려진 픽셀이 주변과 얼마나 다른지(표준편차)를 재서 같은 세기의 노이즈를 입힌다
  let sigma = 0;
  if (kn) {
    const ring = dilate(hole, w, h, 4); let s2 = 0, n2 = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (ring[i] && !hole[i]) { const l = (v) => src[v * 4] * 0.3 + src[v * 4 + 1] * 0.59 + src[v * 4 + 2] * 0.11; const d = l(i) - (l(i - 1) + l(i + 1) + l(i - w) + l(i + w)) / 4; s2 += d * d; n2++; } }
    sigma = n2 ? Math.min(7, Math.sqrt(s2 / n2) * 0.8) : 0;
  }
  const rnd = prng(opts.seed || 12345);
  const alphaH = boxBlur01(hole, w, h, 2);
  const out = new Uint8ClampedArray(N * 4), newMask = new Uint8Array(N);
  let changed = 0;
  for (let i = 0; i < N; i++) {
    newMask[i] = Math.round(wm[i] * 255);
    if (!hole[i] && alphaH[i] <= 0.001) continue;
    const m = wm[i], n = sigma && hole[i] ? (rnd() + rnd() + rnd() - 1.5) * sigma * 1.2 : 0, j = i * 3; // 구멍 가장자리 밖(번짐 2px)은 원본 색 그대로
    out[i * 4] = warped[j] * m + (fill[j] + n) * (1 - m);
    out[i * 4 + 1] = warped[j + 1] * m + (fill[j + 1] + n) * (1 - m);
    out[i * 4 + 2] = warped[j + 2] * m + (fill[j + 2] + n) * (1 - m);
    out[i * 4 + 3] = Math.round(alphaH[i] * 255);
    changed++;
  }
  return { rgba: out, newMask, hole, changed };
}

/** 슬라이더 값(-100..100) → 변형량. 폭·길이는 ±15%, 확대/축소는 ±40% */
export const AMOUNT = { width: 0.15, height: 0.15, bulge: 0.4 };
export const amountOf = (kind, v) => (AMOUNT[kind] || 0.15) * (v / 100);
