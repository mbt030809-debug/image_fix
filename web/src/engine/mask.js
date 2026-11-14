// 마스크 래스터라이즈: 브러시 스트로크 / 선형 / 원형 그라데이션 (Float32 0..1)
import { clamp01, smoothstep } from './util.js';
import { blurPlaneFast } from './blur.js';

/** 점열 [x,y,x,y...] 을 따라 소프트 원형 브러시 도장. 영역(bbox) 마스크 반환 */
export function rasterStrokeRegion(pts, rpx, soft, W, H) {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minx) minx = pts[i]; if (pts[i] > maxx) maxx = pts[i];
    if (pts[i + 1] < miny) miny = pts[i + 1]; if (pts[i + 1] > maxy) maxy = pts[i + 1];
  }
  const x0 = Math.max(0, Math.floor(minx - rpx - 1)), y0 = Math.max(0, Math.floor(miny - rpx - 1));
  const x1 = Math.min(W, Math.ceil(maxx + rpx + 2)), y1 = Math.min(H, Math.ceil(maxy + rpx + 2));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  const m = new Float32Array(w * h);
  if (!w || !h) return { x0, y0, w, h, m };
  const spacing = Math.max(1, rpx * 0.22);
  const hard = rpx * (1 - clamp01(soft));
  const stamp = (cx, cy) => {
    const sx0 = Math.max(x0, Math.floor(cx - rpx)), sx1 = Math.min(x1 - 1, Math.ceil(cx + rpx));
    const sy0 = Math.max(y0, Math.floor(cy - rpx)), sy1 = Math.min(y1 - 1, Math.ceil(cy + rpx));
    for (let y = sy0; y <= sy1; y++) {
      for (let x = sx0; x <= sx1; x++) {
        const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (dist > rpx) continue;
        const v = dist <= hard ? 1 : 1 - smoothstep(hard, rpx, dist);
        const k = (y - y0) * w + (x - x0);
        if (v > m[k]) m[k] = v;
      }
    }
  };
  if (pts.length === 2) stamp(pts[0], pts[1]);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / spacing));
    for (let s = 0; s <= n; s++) { const t = s / n; stamp(ax + (bx - ax) * t, ay + (by - ay) * t); }
  }
  return { x0, y0, w, h, m };
}

/** 여러 스트로크 → 전체 마스크. strokes: [{pts(px), r(px), soft, erase}] */
export function rasterStrokesFull(strokes, W, H) {
  const out = new Float32Array(W * H);
  for (const s of strokes) {
    const reg = rasterStrokeRegion(s.pts, s.r, s.soft == null ? 0.5 : s.soft, W, H);
    for (let y = 0; y < reg.h; y++) {
      const oi = (reg.y0 + y) * W + reg.x0, ri = y * reg.w;
      if (s.erase) for (let x = 0; x < reg.w; x++) out[oi + x] *= 1 - reg.m[ri + x];
      else for (let x = 0; x < reg.w; x++) { const v = reg.m[ri + x]; if (v > out[oi + x]) out[oi + x] = v; }
    }
  }
  return out;
}

/** 선형 그라데이션 마스크: (x1,y1)=0 → (x2,y2)=1 (px). feather 로 폭 조절 */
export function linearMask(W, H, x1, y1, x2, y2, feather = 0.5) {
  const out = new Float32Array(W * H);
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy || 1;
  const f = Math.max(0.02, feather);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = ((x + 0.5 - x1) * dx + (y + 0.5 - y1) * dy) / len2; // 0..1 (두 점 사이)
      out[y * W + x] = smoothstep(0.5 - f * 0.5, 0.5 + f * 0.5, t);
    }
  }
  return out;
}

/** 원형(타원) 마스크: 중심에서 1, 가장자리로 갈수록 0 */
export function radialMask(W, H, cx, cy, rx, ry, rot = 0, feather = 0.5) {
  const out = new Float32Array(W * H);
  const c = Math.cos(rot), s = Math.sin(rot), f = Math.max(0.02, feather);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = (dx * c + dy * s) / rx, v = (-dx * s + dy * c) / ry;
      const d = Math.sqrt(u * u + v * v);
      out[y * W + x] = 1 - smoothstep(1 - f, 1 + 0.001, d);
    }
  }
  return out;
}

/** 색 범위 마스크: 기준색과의 거리(허용치 안쪽 1) */
export function colorRangeMask(img, rgb, tol, feather = 0.3) {
  const { w, h, d } = img;
  const out = new Float32Array(w * h);
  const t = Math.max(1, tol), f = Math.max(0.01, feather) * t;
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const dr = d[j] - rgb[0], dg = d[j + 1] - rgb[1], db = d[j + 2] - rgb[2];
    const dist = Math.sqrt(dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11) * 1.8;
    out[i] = 1 - smoothstep(t, t + f, dist);
  }
  return out;
}

export function featherPlane(m, W, H, sigma) {
  return sigma < 0.5 ? m : blurPlaneFast(m, W, H, sigma);
}

export function invertPlane(m) {
  for (let i = 0; i < m.length; i++) m[i] = 1 - m[i];
  return m;
}
