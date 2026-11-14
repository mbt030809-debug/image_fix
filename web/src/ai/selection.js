// AI 영역 선택: 마스크(Uint8 0..255) 래스터라이즈 · 합성 · 윤곽선 — 순수 함수(DOM 없음, Node 테스트 가능)
// 좌표계: 마스크 격자 px. 픽셀 (x,y) 의 중심은 (x+0.5, y+0.5).
import { blurPlane } from '../engine/blur.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const newMask = (w, h, v = 0) => new Uint8Array(w * h).fill(v);

function addSpan(acc, x0, x1, w) {
  if (x1 <= 0 || x0 >= w) return;
  x0 = Math.max(0, x0); x1 = Math.min(w, x1);
  if (x1 <= x0) return;
  const i0 = Math.floor(x0), i1 = Math.min(w - 1, Math.ceil(x1) - 1);
  if (i0 === i1) { acc[i0] += x1 - x0; return; }
  acc[i0] += i0 + 1 - x0;
  for (let i = i0 + 1; i < i1; i++) acc[i] += 1;
  acc[i1] += x1 - i1;
}

/** 폴리곤(pts=[x0,y0,x1,y1,…]) → 커버리지 0..255 (세로 4배 슈퍼샘플 + 가로 정확 커버리지, nonzero 규칙) */
export function rasterPolygon(pts, w, h) {
  const out = new Uint8Array(w * h);
  const n = pts.length >> 1;
  if (n < 3) return out;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pts.length; i += 2) { const y = pts[i]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const SS = 4;
  const acc = new Float32Array(w);
  const cx = [], cd = [];
  for (let y = y0; y <= y1; y++) {
    acc.fill(0);
    let any = false;
    for (let s = 0; s < SS; s++) {
      const sy = y + (s + 0.5) / SS;
      cx.length = 0; cd.length = 0;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const ax = pts[2 * i], ay = pts[2 * i + 1], bx = pts[2 * j], by = pts[2 * j + 1];
        if (ay === by) continue;
        const up = ay < by;
        const lo = up ? ay : by, hi = up ? by : ay;
        if (sy < lo || sy >= hi) continue;
        const x = ax + (bx - ax) * ((sy - ay) / (by - ay));
        const dir = up ? 1 : -1;
        let k = cx.length;
        cx.push(x); cd.push(dir);
        while (k > 0 && cx[k - 1] > x) { cx[k] = cx[k - 1]; cd[k] = cd[k - 1]; k--; }
        cx[k] = x; cd[k] = dir;
      }
      let wind = 0, start = 0;
      for (let k = 0; k < cx.length; k++) {
        const prev = wind; wind += cd[k];
        if (prev === 0 && wind !== 0) start = cx[k];
        else if (prev !== 0 && wind === 0) { addSpan(acc, start, cx[k], w); any = true; }
      }
    }
    if (!any) continue;
    const row = y * w;
    for (let x = 0; x < w; x++) { const v = acc[x]; if (v > 0) out[row + x] = Math.min(255, Math.round((v / SS) * 255)); }
  }
  return out;
}

export const rectPts = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1];

export function ellipsePts(cx, cy, rx, ry, n) {
  n = n || Math.max(24, Math.min(240, Math.ceil(Math.PI * (Math.abs(rx) + Math.abs(ry)) / 2.5)));
  const p = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; p.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
  return p;
}

/** 커버리지(cov)를 마스크에 합성: add = 합집합(스크린), sub = 빼기 */
export function combine(mask, cov, mode) {
  const n = mask.length;
  if (mode === 'sub') {
    for (let i = 0; i < n; i++) { const c = cov[i]; if (c) mask[i] = Math.round((mask[i] * (255 - c)) / 255); }
  } else {
    for (let i = 0; i < n; i++) { const c = cov[i]; if (c) { const m = mask[i]; mask[i] = Math.min(255, Math.round(m + c - (m * c) / 255)); } }
  }
  return mask;
}

/** 브러시 스탬프를 마스크에 바로 합성 (r: 반지름 px, hard: 0..1 — 이 비율까지는 100%, 이후 선형 감쇠) */
export function stampOp(mask, w, h, cx, cy, r, hard, mode) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const rh = r * hard, span = Math.max(1e-6, r - rh);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      const f = d <= rh ? 1 : 1 - (d - rh) / span;
      const v = Math.round(255 * f);
      if (!v) continue;
      const i = y * w + x, m = mask[i];
      mask[i] = mode === 'sub' ? Math.round((m * (255 - v)) / 255) : Math.min(255, Math.round(m + v - (m * v) / 255));
    }
  }
}

export function strokeOp(mask, w, h, ax, ay, bx, by, r, hard, mode) {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.ceil(len / Math.max(0.75, r * 0.25)));
  for (let i = 0; i <= n; i++) stampOp(mask, w, h, ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, r, hard, mode);
}

export function invertMask(mask) {
  for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i];
  return mask;
}

/** 선택된 픽셀(> thr)의 경계 상자. 반개구간 [x0,x1)×[y0,y1). 없으면 null */
export function bboxOf(mask, w, h, thr = 8) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] > thr) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

/** 선택 비율 0..1 (가중) */
export function coverage(mask) {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i];
  return s / (255 * mask.length);
}

/** 넓히기(r>0)/좁히기(r<0): 3-4 챔퍼 거리변환(O(n)). 경계는 1px 안티앨리어싱 */
export function growMask(mask, w, h, r) {
  if (!r) return mask.slice();
  const dil = r > 0, rad = Math.abs(r);
  const INF = 0x3fffffff, N = w * h;
  const d = new Int32Array(N);
  for (let i = 0; i < N; i++) { const inside = mask[i] >= 128; d[i] = (dil ? inside : !inside) ? 0 : INF; }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0 && d[i - 1] + 3 < v) v = d[i - 1] + 3;
      if (y > 0) {
        if (d[i - w] + 3 < v) v = d[i - w] + 3;
        if (x > 0 && d[i - w - 1] + 4 < v) v = d[i - w - 1] + 4;
        if (x < w - 1 && d[i - w + 1] + 4 < v) v = d[i - w + 1] + 4;
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < w - 1 && d[i + 1] + 3 < v) v = d[i + 1] + 3;
      if (y < h - 1) {
        if (d[i + w] + 3 < v) v = d[i + w] + 3;
        if (x < w - 1 && d[i + w + 1] + 4 < v) v = d[i + w + 1] + 4;
        if (x > 0 && d[i + w - 1] + 4 < v) v = d[i + w - 1] + 4;
      }
      d[i] = v;
    }
  }
  const out = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const dp = d[i] / 3;
    // 선택 경계는 픽셀 경계 위에 있다: 정수 r 이면 r px 이내는 100%, 그 바깥은 0% (분수 r 은 1px 램프)
    const a = dil ? clamp(rad + 1 - dp, 0, 1) : clamp(dp - rad, 0, 1);
    out[i] = Math.round(a * 255);
  }
  return out;
}

/** 가우시안 페더 (sigma: px) */
export function featherU8(mask, w, h, sigma) {
  if (!(sigma >= 0.4)) return mask.slice();
  const f = new Float32Array(mask.length);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] / 255;
  const b = blurPlane(f, w, h, sigma);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(clamp(b[i], 0, 1) * 255);
  return out;
}

/** 격자의 부분 사각형(rect: 격자 px 실수)을 outW×outH 로 쌍선형 리샘플 (가장자리는 클램프) */
export function sampleMask(mask, mw, mh, rect, outW, outH) {
  const out = new Uint8Array(outW * outH);
  const sx = rect.w / outW, sy = rect.h / outH;
  const at = (x, y) => mask[clamp(y, 0, mh - 1) * mw + clamp(x, 0, mw - 1)];
  for (let j = 0; j < outH; j++) {
    const fy = rect.y + (j + 0.5) * sy - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let i = 0; i < outW; i++) {
      const fx = rect.x + (i + 0.5) * sx - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      out[j * outW + i] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
    }
  }
  return out;
}

/** 윤곽선(marching squares) → Float32Array [x1,y1,x2,y2,…] (픽셀 중심 좌표계, 격자 밖은 0 으로 간주해 가장자리도 닫힘) */
export function contourSegments(mask, w, h, thr = 127.5) {
  const W2 = w + 2;
  const bin = new Uint8Array(W2 * (h + 2));
  for (let y = 0; y < h; y++) { const row = y * w, brow = (y + 1) * W2 + 1; for (let x = 0; x < w; x++) bin[brow + x] = mask[row + x] > thr ? 1 : 0; }
  const val = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const segs = [];
  const lerp = (vp, vq) => { const dv = vq - vp; return dv === 0 ? 0.5 : clamp((thr - vp) / dv, 0, 1); };
  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const a = bin[(cy + 1) * W2 + cx + 1], b = bin[(cy + 1) * W2 + cx + 2], c = bin[(cy + 2) * W2 + cx + 2], d = bin[(cy + 2) * W2 + cx + 1];
      const code = a | (b << 1) | (c << 2) | (d << 3);
      if (code === 0 || code === 15) continue;
      const va = val(cx, cy), vb = val(cx + 1, cy), vc = val(cx + 1, cy + 1), vd = val(cx, cy + 1);
      const px = cx + 0.5, py = cy + 0.5;
      // 모서리 위 교차점: T(a→b), R(b→c), B(d→c), L(a→d)
      const E = [
        () => { const t = lerp(va, vb); return [px + t, py]; },
        () => { const t = lerp(vb, vc); return [px + 1, py + t]; },
        () => { const t = lerp(vd, vc); return [px + t, py + 1]; },
        () => { const t = lerp(va, vd); return [px, py + t]; },
      ];
      let pairs;
      switch (code) {
        case 1: case 14: pairs = [[3, 0]]; break;
        case 2: case 13: pairs = [[0, 1]]; break;
        case 3: case 12: pairs = [[3, 1]]; break;
        case 4: case 11: pairs = [[1, 2]]; break;
        case 6: case 9: pairs = [[0, 2]]; break;
        case 7: case 8: pairs = [[3, 2]]; break;
        case 5: pairs = (va + vb + vc + vd) / 4 > thr ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]; break;
        case 10: pairs = (va + vb + vc + vd) / 4 > thr ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]; break;
        default: pairs = [];
      }
      for (const [e1, e2] of pairs) { const p = E[e1](), q = E[e2](); segs.push(p[0], p[1], q[0], q[1]); }
    }
  }
  return Float32Array.from(segs);
}
