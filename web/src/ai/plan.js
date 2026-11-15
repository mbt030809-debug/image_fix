// AI 요청 계획: 선택 영역 → 보낼 크롭 사각형/제공 크기/레터박스, API 마스크, 색 맞춤, 합성 패치 — 순수 함수
import { growMask } from './selection.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** gpt-image 계열이 공통으로 받는 출력 크기 */
export const SIZES = [
  { w: 1024, h: 1024, str: '1024x1024', ar: 1 },
  { w: 1536, h: 1024, str: '1536x1024', ar: 1.5 },
  { w: 1024, h: 1536, str: '1024x1536', ar: 2 / 3 },
];

/** 제공자별 크기 목록(sizes)에서 비율이 가장 가까운 것 (ar 이 없으면 w/h 로 계산) */
export function pickSize(ar, sizes = SIZES) {
  let best = sizes[0], bd = Infinity;
  for (const s of sizes) { const d = Math.abs(Math.log(ar / (s.ar || s.w / s.h))); if (d < bd) { bd = d; best = s; } }
  return best;
}

export const CONTEXTS = [0.15, 0.4, 0.9]; // 좁게 / 보통 / 넓게 (선택 영역 긴 변 대비 사방 여백)

/**
 * bbox: 표시 영역 기준 0..1 정규화 {x0,y0,x1,y1}
 * full: 표시 영역의 작업 해상도 크기 {w,h} (px)
 * opts: {context, minSide, sizes(제공자별 크기 목록)}
 * 반환: rect(full px 정수 사각형), size(제공 크기), fit(size 캔버스 안에서 rect 가 놓이는 위치/크기, 정수)
 */
export function planRequest(bbox, full, opts = {}) {
  const ctxF = opts.context == null ? CONTEXTS[1] : opts.context;
  const minSide = Math.min(opts.minSide || 320, full.w, full.h);
  const bx0 = bbox.x0 * full.w, by0 = bbox.y0 * full.h, bx1 = bbox.x1 * full.w, by1 = bbox.y1 * full.h;
  const m = Math.max(bx1 - bx0, by1 - by0) * ctxF;
  let x0 = bx0 - m, y0 = by0 - m, x1 = bx1 + m, y1 = by1 + m;
  if (x1 - x0 < minSide) { const c = (x0 + x1) / 2; x0 = c - minSide / 2; x1 = c + minSide / 2; }
  if (y1 - y0 < minSide) { const c = (y0 + y1) / 2; y0 = c - minSide / 2; y1 = c + minSide / 2; }
  const sizes = opts.sizes || SIZES;
  const size = pickSize((x1 - x0) / (y1 - y0), sizes);
  const ar = size.w / size.h;
  let rw = x1 - x0, rh = y1 - y0;
  if (rw / rh < ar) rw = rh * ar; else rh = rw / ar; // 짧은 쪽을 늘려 제공 비율에 맞춤 (더 많은 실제 문맥)
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const cw = Math.min(rw, full.w), ch = Math.min(rh, full.h);
  let rx = clamp(cx - cw / 2, 0, full.w - cw), ry = clamp(cy - ch / 2, 0, full.h - ch);
  // 정수 사각형 (선택 영역을 항상 포함하도록 바깥쪽으로 반올림)
  const ix0 = Math.floor(rx), iy0 = Math.floor(ry);
  const ix1 = Math.min(Math.ceil(full.w), Math.ceil(rx + cw)), iy1 = Math.min(Math.ceil(full.h), Math.ceil(ry + ch));
  const rect = { x: ix0, y: iy0, w: Math.max(1, ix1 - ix0), h: Math.max(1, iy1 - iy0) };
  const k = Math.min(size.w / rect.w, size.h / rect.h);
  const fw = Math.max(1, Math.min(size.w, Math.round(rect.w * k))), fh = Math.max(1, Math.min(size.h, Math.round(rect.h * k)));
  const fit = { x: Math.floor((size.w - fw) / 2), y: Math.floor((size.h - fh) / 2), w: fw, h: fh };
  return { rect, size, fit, k };
}

/** rect(표시 영역 full px) → 레이어 배치(캔버스 정규화 중심 x,y, 짧은 변 대비 너비 w) */
export function layerPlacement(rect, full, crop, Wo, Ho) {
  const cx = (rect.x + rect.w / 2) / full.w, cy = (rect.y + rect.h / 2) / full.h;
  return { x: crop[0] + cx * crop[2], y: crop[1] + cy * crop[3], w: rect.w / Math.min(Wo, Ho) };
}

/** rect(표시 영역 full px) → 엔진 렌더용 크롭([x,y,w,h], 캔버스 정규화) */
export function rectToCrop(rect, full, crop) {
  return [crop[0] + (rect.x / full.w) * crop[2], crop[1] + (rect.y / full.h) * crop[3], (rect.w / full.w) * crop[2], (rect.h / full.h) * crop[3]];
}

/** 선택 마스크(size 해상도, fit 바깥 0)를 size 캔버스 전체 마스크로 확장: 격자 → 요청 캔버스 */
export function placeInCanvas(selFit, size, fit) {
  const out = new Uint8Array(size.w * size.h);
  for (let y = 0; y < fit.h; y++) {
    const src = y * fit.w, dst = (fit.y + y) * size.w + fit.x;
    for (let x = 0; x < fit.w; x++) out[dst + x] = selFit[src + x];
  }
  return out;
}

/** 마스크 입력을 받는 편집 API 용 RGBA: 편집할 곳 alpha=0(투명), 나머지 alpha=255. 모델이 경계를 자연스럽게 섞도록 dilatePx 만큼 넓힘. (v1.5.0 부터 마스크를 쓰는 제공자는 없다 — OpenAI 삭제. 순수 함수라 유지) */
export function apiMaskRGBA(selFull, size, dilatePx) {
  const g = dilatePx > 0 ? growMask(selFull, size.w, size.h, dilatePx) : selFull;
  const N = size.w * size.h;
  const out = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    const edit = g[i] >= 128;
    out[i * 4] = 0; out[i * 4 + 1] = 0; out[i * 4 + 2] = 0; out[i * 4 + 3] = edit ? 0 : 255;
  }
  return out;
}

/**
 * 모델이 선택 밖의 색/밝기를 조금씩 바꾸는 경우가 있어서, 선택 바로 바깥 고리 영역의 평균 색 차이로 결과를 보정한다.
 * ai/orig: size.w×size.h RGBA. 반환 [dr,dg,db] (±maxShift) 또는 null(고리 픽셀이 너무 적음)
 */
export function toneOffsets(ai, orig, selFull, size, fit, skip = 3, ring = 14, maxShift = 24) {
  const { w, h } = size;
  // 모델이 편집을 허용받은 영역(skip px 확장)은 제외하고 그 바깥 ring px 폭의 고리만 비교
  const inner = growMask(selFull, w, h, skip), outer = growMask(selFull, w, h, skip + ring);
  const so = [0, 0, 0], sa = [0, 0, 0];
  let n = 0;
  for (let y = fit.y; y < fit.y + fit.h; y++) {
    for (let x = fit.x; x < fit.x + fit.w; x++) {
      const i = y * w + x;
      if (outer[i] >= 128 && inner[i] < 128) {
        n++;
        for (let c = 0; c < 3; c++) { so[c] += orig[i * 4 + c]; sa[c] += ai[i * 4 + c]; }
      }
    }
  }
  if (n < 64) return null;
  return [0, 1, 2].map((c) => clamp((so[c] - sa[c]) / n, -maxShift, maxShift));
}

/** AI 결과에서 fit 영역만 잘라 RGBA 패치(alpha = 선택 마스크)를 만든다. off: toneOffsets 결과(또는 null) */
export function buildPatch(ai, size, fit, alpha, off) {
  const out = new Uint8ClampedArray(fit.w * fit.h * 4);
  const o0 = off ? off[0] : 0, o1 = off ? off[1] : 0, o2 = off ? off[2] : 0;
  for (let y = 0; y < fit.h; y++) {
    let si = ((fit.y + y) * size.w + fit.x) * 4, di = y * fit.w * 4, ai0 = y * fit.w;
    for (let x = 0; x < fit.w; x++, si += 4, di += 4, ai0++) {
      out[di] = ai[si] + o0; out[di + 1] = ai[si + 1] + o1; out[di + 2] = ai[si + 2] + o2;
      out[di + 3] = alpha[ai0];
    }
  }
  return out;
}

/** 페더 시그마(요청 캔버스 px): 슬라이더 0..100 → 표시 영역 짧은 변의 최대 3% */
export function featherSigma(feather, full, k) {
  return (feather / 100) * 0.03 * Math.min(full.w, full.h) * k;
}
