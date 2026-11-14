// 로컬 보정(마스크 기반): 브러시 / 선형 / 원형 / 색 범위 + 보정 파라미터
// 좌표는 "캔버스 정규화" (방향·수평 보정 적용 후, 자르기 전). 반경은 캔버스 짧은 변 대비 비율.
import { clamp01 } from './util.js';
import { guidedSmooth, blurRGBA, blurPlaneFast } from './blur.js';
import { rasterStrokesFull, linearMask, radialMask, colorRangeMask, invertPlane } from './mask.js';
import { developMasked, mergeAdj, adjIsNeutral } from './develop.js';

/** ctx: {w,h (출력 px), crop:[x,y,w,h]} */
function mapX(x, ctx) { return ((x - ctx.crop[0]) / ctx.crop[2]) * ctx.w; }
function mapY(y, ctx) { return ((y - ctx.crop[1]) / ctx.crop[3]) * ctx.h; }

export function buildLocalMask(L, img, ctx) {
  const { w, h } = ctx;
  const Wc = w / ctx.crop[2], Hc = h / ctx.crop[3], unit = Math.min(Wc, Hc);
  let m;
  if (L.kind === 'brush') {
    const strokes = (L.strokes || []).map((s) => {
      const pts = new Array(s.pts.length);
      for (let i = 0; i < s.pts.length; i += 2) { pts[i] = mapX(s.pts[i], ctx); pts[i + 1] = mapY(s.pts[i + 1], ctx); }
      return { pts, r: Math.max(1, s.r * unit), soft: s.soft, erase: s.erase };
    });
    m = rasterStrokesFull(strokes, w, h);
  } else if (L.kind === 'linear') {
    m = linearMask(w, h, mapX(L.x1, ctx), mapY(L.y1, ctx), mapX(L.x2, ctx), mapY(L.y2, ctx), L.feather == null ? 0.6 : L.feather);
  } else if (L.kind === 'radial') {
    m = radialMask(w, h, mapX(L.cx, ctx), mapY(L.cy, ctx), Math.max(2, L.rx * Wc), Math.max(2, L.ry * Hc), ((L.rot || 0) * Math.PI) / 180, L.feather == null ? 0.5 : L.feather);
  } else if (L.kind === 'color') {
    m = colorRangeMask(img, L.rgb || [128, 128, 128], L.tol == null ? 40 : L.tol, 0.4);
  } else {
    m = new Float32Array(w * h);
  }
  if (L.kind === 'brush' && L.feather > 0) m = blurPlaneFast(m, w, h, L.feather * 0.01 * unit);
  if (L.inv) invertPlane(m);
  const amt = L.amt == null ? 1 : clamp01(L.amt / 100);
  if (amt < 0.999) for (let i = 0; i < m.length; i++) m[i] *= amt;
  return m;
}

function blendMasked(img, other, m) {
  const d = img.d, o = other;
  for (let i = 0, j = 0; i < m.length; i++, j += 4) {
    const k = m[i];
    if (k < 0.004) continue;
    d[j] += (o[j] - d[j]) * k; d[j + 1] += (o[j + 1] - d[j + 1]) * k; d[j + 2] += (o[j + 2] - d[j + 2]) * k;
  }
}

export function applyLocals(img, locals, ctx) {
  if (!locals || !locals.length) return img;
  const mn = Math.min(img.w, img.h);
  for (const L of locals) {
    if (!L || L.on === false) continue;
    const m = buildLocalMask(L, img, ctx);
    const p = L.p || {};
    const A = mergeAdj(p, null, 0);
    if (!adjIsNeutral(A)) developMasked(img, A, m);
    if (p.smooth > 0) {
      const tmp = { w: img.w, h: img.h, d: new Uint8ClampedArray(img.d) };
      const s = p.smooth / 100;
      guidedSmooth(tmp, Math.max(2, Math.round((0.004 + s * 0.008) * mn)), 0.003 + s * 0.03);
      blendMasked(img, tmp.d, m);
    }
    if (p.blur > 0) {
      const b = blurRGBA(img, Math.max(0.8, (p.blur / 100) * 0.03 * mn));
      blendMasked(img, b, m);
    }
  }
  return img;
}
