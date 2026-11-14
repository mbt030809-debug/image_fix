// 지오메트리: 방향(회전/뒤집기) + 수평 보정(각도) + 원근 + 자르기
//   geo = { r:0..3 (시계 90°), f:0|1 (좌우 뒤집기 후 회전), a:도, pv:-100..100, ph:-100..100, crop:[x,y,w,h] (캔버스 정규화) }
// "캔버스" = 방향이 적용된 이미지와 같은 크기의 좌표계. crop / 오버레이 / 로컬 마스크는 모두 캔버스 정규화 좌표를 쓴다.
import { clamp } from './util.js';

export const DEFAULT_GEO = () => ({ r: 0, f: 0, a: 0, pv: 0, ph: 0, crop: [0, 0, 1, 1] });

export function geoIsDefault(g) {
  return !g || (!g.r && !g.f && !g.a && !g.pv && !g.ph && (!g.crop || (g.crop[0] === 0 && g.crop[1] === 0 && g.crop[2] === 1 && g.crop[3] === 1)));
}

export function orientedSize(Ws, Hs, geo) {
  return geo && geo.r & 1 ? [Hs, Ws] : [Ws, Hs];
}

// ------------------------------------------------------------ 3x3 행렬 (행 우선 길이 9)
export const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function mul3(a, b) {
  const o = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return o;
}
export function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}
export function apply3(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}
const T3 = (tx, ty) => [1, 0, tx, 0, 1, ty, 0, 0, 1];
const S3 = (sx, sy) => [sx, 0, 0, 0, sy, 0, 0, 0, 1];
const R3 = (rad) => { const c = Math.cos(rad), s = Math.sin(rad); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

/** 4점 대응 호모그래피 (src→dst) */
export function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const n = 8;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let r = col + 1; r < n; r++) {
      const k = A[r][col] / d;
      for (let c = col; c < n; c++) A[r][c] -= k * A[col][c];
      b[r] -= k * b[col];
    }
  }
  const h = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * h[c];
    h[r] = s / (A[r][r] || 1e-12);
  }
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/** 원근 변형: 정규화 좌표(-1..1) 정방형 → 사다리꼴 (정방향). 파라미터가 0이면 null */
function perspectiveForward(pv, ph) {
  if (!pv && !ph) return null;
  const dv = (clamp(pv, -100, 100) / 100) * 0.35;
  const dh = (clamp(ph, -100, 100) / 100) * 0.35;
  let TL = [-1, -1], TR = [1, -1], BR = [1, 1], BL = [-1, 1];
  if (dv > 0) { BL[0] = -(1 - dv); BR[0] = 1 - dv; } else if (dv < 0) { TL[0] = -(1 + dv); TR[0] = 1 + dv; }
  if (dh > 0) { TR[1] = -(1 - dh); BR[1] = 1 - dh; } else if (dh < 0) { TL[1] = -(1 + dh); BL[1] = 1 + dh; }
  return homography([[-1, -1], [1, -1], [1, 1], [-1, 1]], [TL, TR, BR, BL]);
}

/** 방향 O^-1: 방향 적용 이미지 px → 원본 px (Ws,Hs = 원본 크기) */
function orientInverse(Ws, Hs, geo) {
  const r = geo.r | 0, f = geo.f | 0;
  let m;
  switch (r & 3) {
    case 0: m = I3(); break;
    case 1: m = [0, 1, 0, -1, 0, Hs, 0, 0, 1]; break; // xs = y', ys = Hs - x'
    case 2: m = [-1, 0, Ws, 0, -1, Hs, 0, 0, 1]; break;
    default: m = [0, -1, Ws, 1, 0, 0, 0, 0, 1]; break; // xs = Ws - y', ys = x'
  }
  if (f) m = mul3([-1, 0, Ws, 0, 1, 0, 0, 0, 1], m); // 원본에서 먼저 좌우 반전했으므로 역변환 뒤에 반전
  return m;
}

/** 캔버스 px → 원본 px 행렬 (자르기 제외) */
export function canvasToSource(geo, Ws, Hs) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  const Oi = orientInverse(Ws, Hs, geo);
  let m = Oi;
  // 회전(수평 보정) 역변환
  if (geo.a) m = mul3(m, mul3(T3(Wo / 2, Ho / 2), mul3(R3((-geo.a * Math.PI) / 180), T3(-Wo / 2, -Ho / 2))));
  // 원근 역변환 (정규화 좌표에서)
  const P = perspectiveForward(geo.pv || 0, geo.ph || 0);
  if (P) {
    const Pi = inv3(P);
    const N = mul3(S3(2 / Wo, 2 / Ho), T3(-Wo / 2, -Ho / 2));
    const Ninv = inv3(N);
    m = mul3(m, mul3(Ninv, mul3(Pi, N)));
  }
  return m;
}

/** 출력 px → 원본 px 행렬 */
export function outputToSource(geo, Ws, Hs, outW, outH, crop) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  const c = crop || geo.crop || [0, 0, 1, 1];
  const Acrop = mul3(T3(c[0] * Wo, c[1] * Ho), S3((c[2] * Wo) / outW, (c[3] * Ho) / outH));
  return mul3(canvasToSource(geo, Ws, Hs), Acrop);
}

export function cropOutputSize(geo, Ws, Hs, crop) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  const c = crop || geo.crop || [0, 0, 1, 1];
  return [Math.max(1, Math.round(c[2] * Wo)), Math.max(1, Math.round(c[3] * Ho))];
}

/** R 을 지오메트리대로 변환. 결과 RGBA(바깥은 투명) */
export function renderGeometry(R, geo, opts = {}) {
  const { w: Ws, h: Hs, d: sd } = R;
  const crop = opts.crop || geo.crop || [0, 0, 1, 1];
  let [outW, outH] = cropOutputSize(geo, Ws, Hs, crop);
  if (opts.outW) { outW = opts.outW; outH = opts.outH; }
  const M = outputToSource(geo, Ws, Hs, outW, outH, crop);
  const out = new Uint8ClampedArray(outW * outH * 4);
  const affine = Math.abs(M[6]) < 1e-12 && Math.abs(M[7]) < 1e-12;
  const m0 = M[0], m1 = M[1], m2 = M[2], m3 = M[3], m4 = M[4], m5 = M[5], m6 = M[6], m7 = M[7], m8 = M[8];
  const wm1 = Ws - 1, hm1 = Hs - 1;
  // 정수 이동/배율 1:1 빠른 경로
  const identityLike = affine && Math.abs(m0 - 1) < 1e-9 && Math.abs(m4 - 1) < 1e-9 && Math.abs(m1) < 1e-9 && Math.abs(m3) < 1e-9
    && Math.abs(m2 - Math.round(m2)) < 1e-6 && Math.abs(m5 - Math.round(m5)) < 1e-6;
  if (identityLike) {
    const ox = Math.round(m2), oy = Math.round(m5);
    for (let y = 0; y < outH; y++) {
      const sy = y + oy;
      if (sy < 0 || sy >= Hs) continue;
      for (let x = 0; x < outW; x++) {
        const sx = x + ox;
        if (sx < 0 || sx >= Ws) continue;
        const si = (sy * Ws + sx) * 4, di = (y * outW + x) * 4;
        out[di] = sd[si]; out[di + 1] = sd[si + 1]; out[di + 2] = sd[si + 2]; out[di + 3] = sd[si + 3];
      }
    }
    return { w: outW, h: outH, d: out };
  }
  for (let y = 0; y < outH; y++) {
    const py = y + 0.5;
    for (let x = 0; x < outW; x++) {
      const px = x + 0.5;
      let sx, sy;
      if (affine) { sx = m0 * px + m1 * py + m2; sy = m3 * px + m4 * py + m5; }
      else {
        const wv = m6 * px + m7 * py + m8;
        if (Math.abs(wv) < 1e-9) continue;
        sx = (m0 * px + m1 * py + m2) / wv; sy = (m3 * px + m4 * py + m5) / wv;
      }
      // 양선형 (경계는 커버리지로 안티앨리어싱)
      const fx = sx - 0.5, fy = sy - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      if (x0 < -1 || y0 < -1 || x0 > wm1 || y0 > hm1) continue;
      const tx = fx - x0, ty = fy - y0;
      let r = 0, g = 0, b = 0, a = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const xx = x0 + (k & 1), yy = y0 + (k >> 1);
        if (xx < 0 || yy < 0 || xx > wm1 || yy > hm1) continue;
        const wt = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? ty : 1 - ty);
        const i = (yy * Ws + xx) * 4;
        const al = sd[i + 3] * wt;
        r += sd[i] * al; g += sd[i + 1] * al; b += sd[i + 2] * al; a += al; ws += wt;
      }
      if (a <= 0) continue;
      const di = (y * outW + x) * 4;
      const inv = 1 / a;
      out[di] = r * inv; out[di + 1] = g * inv; out[di + 2] = b * inv;
      out[di + 3] = a; // ws 가 1 미만이면 바깥과 섞인 가장자리 → 이미 가중 합으로 알파가 줄어듦
      if (ws < 0.999) out[di + 3] = a; // (명시적 의미 유지)
    }
  }
  return { w: outW, h: outH, d: out };
}

// ------------------------------------------------------------ 자르기 유효성
function cornersValid(geo, rect, Ws, Hs, tol = 0.75) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  const M = canvasToSource(geo, Ws, Hs);
  const [x, y, w, h] = rect;
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]];
  for (const [u, v] of pts) {
    const [sx, sy] = apply3(M, u * Wo, v * Ho);
    if (!(sx >= -tol && sy >= -tol && sx <= Ws + tol && sy <= Hs + tol)) return false;
  }
  return true;
}

export function cropValid(geo, rect, Ws, Hs) { return cornersValid(geo, rect, Ws, Hs); }

/** 사각형을 유효 영역 안으로 (자기 중심 기준 축소, 중심이 바깥이면 캔버스 중심쪽으로 이동) */
export function fitCropInside(geo, rect, Ws, Hs) {
  if (cornersValid(geo, rect, Ws, Hs)) return rect.slice();
  let [x, y, w, h] = rect;
  let cx = x + w / 2, cy = y + h / 2;
  // 중심이 유효하지 않으면 캔버스 중심으로 접근
  for (let it = 0; it < 40 && !cornersValid(geo, [cx - 0.001, cy - 0.001, 0.002, 0.002], Ws, Hs); it++) {
    cx += (0.5 - cx) * 0.2; cy += (0.5 - cy) * 0.2;
  }
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (cornersValid(geo, [cx - (w * mid) / 2, cy - (h * mid) / 2, w * mid, h * mid], Ws, Hs)) lo = mid; else hi = mid;
  }
  const k = Math.max(lo, 0.02);
  return [cx - (w * k) / 2, cy - (h * k) / 2, w * k, h * k];
}

/** 픽셀 종횡비 asp(=w/h) 로 유효 영역에 들어가는 최대 중앙 크롭 */
export function maxCropRect(geo, asp, Ws, Hs) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  let cw = 1, ch = 1;
  if (asp) {
    // 캔버스 안에서 asp 비율 최대
    if (Wo / Ho > asp) { ch = 1; cw = (asp * Ho) / Wo; } else { cw = 1; ch = Wo / asp / Ho; }
  }
  const rect = [(1 - cw) / 2, (1 - ch) / 2, cw, ch];
  if (cornersValid(geo, rect, Ws, Hs)) return rect;
  let lo = 0, hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const r = [0.5 - (cw * mid) / 2, 0.5 - (ch * mid) / 2, cw * mid, ch * mid];
    if (cornersValid(geo, r, Ws, Hs)) lo = mid; else hi = mid;
  }
  const k = Math.max(lo, 0.02);
  return [0.5 - (cw * k) / 2, 0.5 - (ch * k) / 2, cw * k, ch * k];
}

// ------------------------------------------------------------ 표시 단위 변환 (회전/뒤집기 버튼)
/** 캔버스 정규화 좌표 매핑 함수 */
export const MAP = {
  cw: (x, y) => [1 - y, x],
  ccw: (x, y) => [y, 1 - x],
  flipH: (x, y) => [1 - x, y],
  flipV: (x, y) => [x, 1 - y],
};

function mapRect(rect, fn) {
  const [x, y, w, h] = rect;
  const a = fn(x, y), b = fn(x + w, y + h);
  const nx = Math.min(a[0], b[0]), ny = Math.min(a[1], b[1]);
  return [nx, ny, Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])];
}

/** op: 'cw' | 'ccw' | 'flipH' | 'flipV'  → {geo, map, dRot} (map: 캔버스 정규화 좌표 매핑, dRot: 레이어 회전 증분(도)) */
export function applyOrientOp(geo, op) {
  const g = { ...geo, crop: geo.crop ? geo.crop.slice() : [0, 0, 1, 1] };
  const r = geo.r | 0, f = geo.f | 0;
  let dRot = 0;
  if (op === 'cw') { g.r = (r + 1) & 3; dRot = 90; }
  else if (op === 'ccw') { g.r = (r + 3) & 3; dRot = -90; }
  else if (op === 'flipH') { g.r = (4 - r) & 3; g.f = 1 - f; }
  else if (op === 'flipV') { g.r = (2 - r + 4) & 3; g.f = 1 - f; }
  // 수평 보정 각도·원근은 표시 방향 기준이므로 그대로 유지하되 부호 보정
  if (op === 'flipH' || op === 'flipV') { g.a = -(geo.a || 0); }
  if (op === 'cw' || op === 'ccw') { /* 각도는 화면 기준 → 유지 */ }
  const fn = MAP[op];
  g.crop = mapRect(g.crop, fn);
  if (op === 'cw' || op === 'ccw') { g.pv = geo.ph || 0; g.ph = -(geo.pv || 0); if (op === 'ccw') { g.pv = -(geo.ph || 0); g.ph = geo.pv || 0; } }
  else if (op === 'flipH') { g.ph = -(geo.ph || 0); }
  else if (op === 'flipV') { g.pv = -(geo.pv || 0); }
  return { geo: g, map: fn, dRot };
}

/** 각도 변경 시 캔버스 정규화 점의 이동 (캔버스 중심 기준 회전) */
export function mapForAngleChange(dDeg, Wo, Ho) {
  const rad = (dDeg * Math.PI) / 180, c = Math.cos(rad), s = Math.sin(rad);
  return (x, y) => {
    const px = (x - 0.5) * Wo, py = (y - 0.5) * Ho;
    return [(px * c - py * s) / Wo + 0.5, (px * s + py * c) / Ho + 0.5];
  };
}

export function cropAspectPx(rect, Wo, Ho) { return (rect[2] * Wo) / (rect[3] * Ho); }
