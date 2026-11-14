// 리터치 단계(원본 좌표계): 복제/치유, 지우기(인페인팅), 리퀴파이, 배경 제거 마스크 적용
// 모든 좌표는 원본 이미지 기준 정규화(0..1), 반경은 짧은 변 대비 비율.
import { clamp, clamp01, lerp, smoothstep, sampleClamp, mulberry32 } from './util.js';
import { blurRGBA, blurPlaneFast } from './blur.js';
import { rasterStrokeRegion } from './mask.js';

function toPx(pts, W, H) {
  const o = new Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) { o[i] = pts[i] * W; o[i + 1] = pts[i + 1] * H; }
  return o;
}

function extractRegion(img, x0, y0, w, h) {
  const out = { w, h, d: new Uint8ClampedArray(w * h * 4) };
  const { w: W, h: H, d } = img;
  for (let y = 0; y < h; y++) {
    const sy = y0 + y < 0 ? 0 : y0 + y >= H ? H - 1 : y0 + y;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x < 0 ? 0 : x0 + x >= W ? W - 1 : x0 + x;
      const si = (sy * W + sx) * 4, di = (y * w + x) * 4;
      out.d[di] = d[si]; out.d[di + 1] = d[si + 1]; out.d[di + 2] = d[si + 2]; out.d[di + 3] = d[si + 3];
    }
  }
  return out;
}

// ------------------------------------------------------------ 복제 / 치유
// 치유: 소스 질감은 가져오고, 색/밝기는 브러시 경계(바깥 고리)의 차이를 안쪽으로 부드럽게 퍼뜨려 맞춘다(푸아송 유사).
function applyClone(img, op) {
  const { w: W, h: H, d } = img;
  const mn = Math.min(W, H);
  const rpx = Math.max(1, op.r * mn);
  const reg = rasterStrokeRegion(toPx(op.pts, W, H), rpx, op.soft == null ? 0.5 : op.soft, W, H);
  if (!reg.w || !reg.h) return;
  const ox = Math.round(op.ox * W), oy = Math.round(op.oy * H);
  const heal = op.mode === 'heal';
  const opacity = op.op == null ? 1 : op.op;
  const snap = { w: W, h: H, d: new Uint8ClampedArray(d) };
  let off = null, rx0 = 0, ry0 = 0, rw = 0, rh = 0;
  if (heal) {
    const margin = Math.max(4, Math.ceil(rpx * 0.5));
    rx0 = reg.x0 - margin; ry0 = reg.y0 - margin; rw = reg.w + margin * 2; rh = reg.h + margin * 2;
    const dest = extractRegion(snap, rx0, ry0, rw, rh);
    const srcR = extractRegion(snap, rx0 + ox, ry0 + oy, rw, rh);
    const diff = { w: rw, h: rh, d: new Uint8ClampedArray(rw * rh * 4) };
    const hole = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x, j = i * 4;
        const rxm = x - margin, rym = y - margin;
        const m = rxm >= 0 && rym >= 0 && rxm < reg.w && rym < reg.h ? reg.m[rym * reg.w + rxm] : 0;
        if (m > 0.02) hole[i] = 1;
        diff.d[j] = dest.d[j] - srcR.d[j] + 128; diff.d[j + 1] = dest.d[j + 1] - srcR.d[j + 1] + 128; diff.d[j + 2] = dest.d[j + 2] - srcR.d[j + 2] + 128; diff.d[j + 3] = 255;
      }
    }
    off = inpaintRegion(diff, hole); // 안쪽 차이를 경계에서 보간
  }
  for (let y = 0; y < reg.h; y++) {
    for (let x = 0; x < reg.w; x++) {
      const m = reg.m[y * reg.w + x] * opacity;
      if (m < 0.004) continue;
      const gx = reg.x0 + x, gy = reg.y0 + y;
      const sx = clamp(gx + ox, 0, W - 1), sy = clamp(gy + oy, 0, H - 1);
      const si = (sy * W + sx) * 4, di = (gy * W + gx) * 4;
      let r = snap.d[si], g = snap.d[si + 1], b = snap.d[si + 2];
      if (heal) {
        const li = ((y + (reg.y0 - ry0)) * rw + (x + (reg.x0 - rx0))) * 3;
        r += off[li] - 128; g += off[li + 1] - 128; b += off[li + 2] - 128;
      }
      d[di] = clamp(d[di] + (r - d[di]) * m, 0, 255);
      d[di + 1] = clamp(d[di + 1] + (g - d[di + 1]) * m, 0, 255);
      d[di + 2] = clamp(d[di + 2] + (b - d[di + 2]) * m, 0, 255);
    }
  }
}

// ------------------------------------------------------------ 지우기 (푸시-풀 인페인팅 + 질감 노이즈)
function inpaintRegion(reg /*{w,h,d}*/, hole /*Uint8Array 0/1*/) {
  const { w, h, d } = reg;
  // 레벨 0: 프리멀티플라이드 색과 가중치
  const levels = [];
  let C = new Float32Array(w * h * 3), Wt = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!hole[i]) { Wt[i] = 1; C[i * 3] = d[i * 4]; C[i * 3 + 1] = d[i * 4 + 1]; C[i * 3 + 2] = d[i * 4 + 2]; }
  }
  levels.push({ w, h, C, W: Wt });
  while (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1) {
    const L = levels[levels.length - 1];
    const nw = Math.max(1, (L.w + 1) >> 1), nh = Math.max(1, (L.h + 1) >> 1);
    const nC = new Float32Array(nw * nh * 3), nW = new Float32Array(nw * nh);
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x, o = (y >> 1) * nw + (x >> 1);
        nC[o * 3] += L.C[i * 3] * 0.25; nC[o * 3 + 1] += L.C[i * 3 + 1] * 0.25; nC[o * 3 + 2] += L.C[i * 3 + 2] * 0.25; nW[o] += L.W[i] * 0.25;
      }
    }
    levels.push({ w: nw, h: nh, C: nC, W: nW });
    if (nw === 1 && nh === 1) break;
  }
  // 풀: 위에서 아래로
  let F = null; // 비프리멀티플라이드 채움 색 (현재 레벨)
  for (let l = levels.length - 1; l >= 0; l--) {
    const L = levels[l];
    const cur = new Float32Array(L.w * L.h * 3);
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const i = y * L.w + x;
        let ur = 128, ug = 128, ub = 128;
        if (F) {
          const P = levels[l + 1];
          // 양선형 업샘플
          const fx = Math.max(0, Math.min(P.w - 1, (x + 0.5) / 2 - 0.5)), fy = Math.max(0, Math.min(P.h - 1, (y + 0.5) / 2 - 0.5));
          const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(P.w - 1, x0 + 1), y1 = Math.min(P.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
          for (let c = 0; c < 3; c++) {
            const v = (F[(y0 * P.w + x0) * 3 + c] * (1 - tx) + F[(y0 * P.w + x1) * 3 + c] * tx) * (1 - ty) + (F[(y1 * P.w + x0) * 3 + c] * (1 - tx) + F[(y1 * P.w + x1) * 3 + c] * tx) * ty;
            if (c === 0) ur = v; else if (c === 1) ug = v; else ub = v;
          }
        } else if (L.W[i] > 0) { ur = L.C[i * 3] / L.W[i]; ug = L.C[i * 3 + 1] / L.W[i]; ub = L.C[i * 3 + 2] / L.W[i]; }
        const wv = Math.min(1, L.W[i] * (l === 0 ? 1 : 1));
        cur[i * 3] = L.C[i * 3] + (1 - wv) * ur;
        cur[i * 3 + 1] = L.C[i * 3 + 1] + (1 - wv) * ug;
        cur[i * 3 + 2] = L.C[i * 3 + 2] + (1 - wv) * ub;
      }
    }
    F = cur;
  }
  return F; // 레벨 0 채움 결과 (w*h*3)
}

function applyErase(img, op) {
  const { w: W, h: H, d } = img;
  const mn = Math.min(W, H);
  const rpx = Math.max(1, op.r * mn);
  const reg0 = rasterStrokeRegion(toPx(op.pts, W, H), rpx, 0.25, W, H);
  if (!reg0.w || !reg0.h) return;
  const margin = Math.max(6, Math.ceil(rpx * 0.9));
  const x0 = Math.max(0, reg0.x0 - margin), y0 = Math.max(0, reg0.y0 - margin);
  const x1 = Math.min(W, reg0.x0 + reg0.w + margin), y1 = Math.min(H, reg0.y0 + reg0.h + margin);
  const w = x1 - x0, h = y1 - y0;
  const region = extractRegion({ w: W, h: H, d }, x0, y0, w, h);
  const hole = new Uint8Array(w * h), alpha = new Float32Array(w * h);
  for (let y = 0; y < reg0.h; y++) {
    for (let x = 0; x < reg0.w; x++) {
      const v = reg0.m[y * reg0.w + x];
      if (v <= 0.003) continue;
      const k = (reg0.y0 + y - y0) * w + (reg0.x0 + x - x0);
      alpha[k] = v;
      if (v > 0.35) hole[k] = 1;
    }
  }
  // 구멍을 1px 확장해 경계 번짐 방지
  const hole2 = new Uint8Array(hole);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!hole[i] && (hole[i - 1] || hole[i + 1] || hole[i - w] || hole[i + w])) hole2[i] = 1;
  }
  const F = inpaintRegion(region, hole2);
  // 주변 질감 세기 추정 (구멍 밖 고주파 표준편차)
  const low = blurRGBA(region, 2);
  let sum = 0, cnt = 0;
  for (let i = 0; i < w * h; i += 3) {
    if (hole2[i]) continue;
    const j = i * 4;
    const v = (region.d[j] + region.d[j + 1] + region.d[j + 2]) / 3 - (low[j] + low[j + 1] + low[j + 2]) / 3;
    sum += v * v; cnt++;
  }
  const sigma = cnt ? Math.sqrt(sum / cnt) : 0;
  const rnd = mulberry32(((x0 * 73856093) ^ (y0 * 19349663)) | 0);
  const noise = new Float32Array(w * h);
  for (let i = 0; i < noise.length; i++) noise[i] = (rnd() + rnd() + rnd() - 1.5) * 1.15;
  const nsm = blurPlaneFast(noise, w, h, 0.8); // 약간 부드럽게(입자 크기)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = alpha[i];
      if (a < 0.004) continue;
      const gi = ((y0 + y) * W + (x0 + x)) * 4;
      const n = nsm[i] * sigma * 1.9;
      for (let c = 0; c < 3; c++) {
        const v = F[i * 3 + c] + n;
        d[gi + c] = clamp(d[gi + c] + (v - d[gi + c]) * a, 0, 255);
      }
    }
  }
}

// ------------------------------------------------------------ 리퀴파이
function applyLiquifyGroup(img, ops) {
  const { w: W, h: H, d } = img;
  const mn = Math.min(W, H);
  // 영향 범위 bbox 계산
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const op of ops) {
    const r = op.r * mn;
    for (let i = 0; i < op.pts.length; i += 2) {
      minx = Math.min(minx, op.pts[i] * W - r); maxx = Math.max(maxx, op.pts[i] * W + r);
      miny = Math.min(miny, op.pts[i + 1] * H - r); maxy = Math.max(maxy, op.pts[i + 1] * H + r);
    }
  }
  const x0 = Math.max(0, Math.floor(minx) - 1), y0 = Math.max(0, Math.floor(miny) - 1);
  const x1 = Math.min(W, Math.ceil(maxx) + 1), y1 = Math.min(H, Math.ceil(maxy) + 1);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const dx = new Float32Array(w * h), dy = new Float32Array(w * h); // 역방향 변위: out(x) = in(x + D)
  for (const op of ops) {
    const R = Math.max(2, op.r * mn), str = clamp01(op.str == null ? 0.6 : op.str);
    const pts = toPx(op.pts, W, H);
    const spacing = Math.max(1, R * 0.2);
    const stamps = [];
    for (let i = 0; i + 1 < pts.length; i += 2) {
      if (i === 0) { stamps.push([pts[0], pts[1], 0, 0]); continue; }
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(len / spacing));
      for (let s = 1; s <= n; s++) {
        const t = s / n, px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
        stamps.push([px, py, (bx - ax) / n, (by - ay) / n]);
      }
    }
    for (const [cx, cy, mvx, mvy] of stamps) {
      const sx0 = Math.max(x0, Math.floor(cx - R)), sx1 = Math.min(x1 - 1, Math.ceil(cx + R));
      const sy0 = Math.max(y0, Math.floor(cy - R)), sy1 = Math.min(y1 - 1, Math.ceil(cy + R));
      for (let y = sy0; y <= sy1; y++) {
        for (let x = sx0; x <= sx1; x++) {
          const ex = x + 0.5 - cx, ey = y + 0.5 - cy, dist = Math.hypot(ex, ey);
          if (dist >= R) continue;
          const t = 1 - dist / R, wgt = t * t * (3 - 2 * t);
          const k = (y - y0) * w + (x - x0);
          switch (op.mode) {
            case 'push': dx[k] -= mvx * wgt * str * 1.0; dy[k] -= mvy * wgt * str * 1.0; break;
            case 'bloat': { const f = wgt * str * 0.06; dx[k] += ex * f; dy[k] += ey * f; break; }  // out(x)=in(x+D): 중심 쪽을 가져와 확대
            case 'pinch': { const f = wgt * str * 0.06; dx[k] -= ex * f; dy[k] -= ey * f; break; }
            case 'twirl': { const a = wgt * str * 0.12, c = Math.cos(a), s = Math.sin(a); dx[k] += ex * c - ey * s - ex; dy[k] += ex * s + ey * c - ey; break; }
            case 'twirlL': { const a = -wgt * str * 0.12, c = Math.cos(a), s = Math.sin(a); dx[k] += ex * c - ey * s - ex; dy[k] += ex * s + ey * c - ey; break; }
            case 'recon': dx[k] *= 1 - wgt * str * 0.25; dy[k] *= 1 - wgt * str * 0.25; break;
            default: break;
          }
        }
      }
    }
  }
  // 적용
  const snap = new Uint8ClampedArray(d);
  const out = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (dx[k] === 0 && dy[k] === 0) continue;
      sampleClamp(snap, W, H, x0 + x + 0.5 + dx[k], y0 + y + 0.5 + dy[k], out);
      const gi = ((y0 + y) * W + (x0 + x)) * 4;
      d[gi] = out[0]; d[gi + 1] = out[1]; d[gi + 2] = out[2]; d[gi + 3] = out[3];
    }
  }
}

// ------------------------------------------------------------ 배경 제거 마스크 적용
export function prepareCutMask(asset, feather, grow) {
  // asset: {w,h,data:Uint8Array 0..255}
  const { w, h, data } = asset;
  let m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = data[i] / 255;
  if (feather > 0) m = blurPlaneFast(m, w, h, feather);
  if (grow) {
    const g = grow / 100;
    for (let i = 0; i < m.length; i++) m[i] = clamp01((m[i] - 0.5) * (1 + Math.abs(g) * 6) + 0.5 + g * 0.5);
  }
  return { w, h, m };
}

function applyCut(img, op, assets) {
  const asset = assets && assets.get(op.mask);
  if (!asset) return;
  const mn = Math.min(img.w, img.h);
  const sc = Math.min(asset.w, asset.h) / mn;
  const pm = prepareCutMask(asset, ((op.feather || 0) / 100) * 0.02 * Math.min(asset.w, asset.h) * (sc > 0 ? 1 : 1), op.grow || 0);
  const { w: W, h: H, d } = img;
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(pm.h - 1, ((y + 0.5) / H) * pm.h - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(pm.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(pm.w - 1, ((x + 0.5) / W) * pm.w - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(pm.w - 1, x0 + 1), tx = fx - x0;
      const m = (pm.m[y0 * pm.w + x0] * (1 - tx) + pm.m[y0 * pm.w + x1] * tx) * (1 - ty) + (pm.m[y1 * pm.w + x0] * (1 - tx) + pm.m[y1 * pm.w + x1] * tx) * ty;
      const j = (y * W + x) * 4 + 3;
      d[j] = d[j] * m;
    }
  }
}

function sampleMask(pm, W, H) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(pm.h - 1, ((y + 0.5) / H) * pm.h - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(pm.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(pm.w - 1, ((x + 0.5) / W) * pm.w - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(pm.w - 1, x0 + 1), tx = fx - x0;
      out[y * W + x] = (pm.m[y0 * pm.w + x0] * (1 - tx) + pm.m[y0 * pm.w + x1] * tx) * (1 - ty) + (pm.m[y1 * pm.w + x0] * (1 - tx) + pm.m[y1 * pm.w + x1] * tx) * ty;
    }
  }
  return out;
}

/** 배경 흐리게: 마스크(255=피사체)가 아닌 영역만 블러 */
function applyBgBlur(img, op, assets) {
  const asset = assets && assets.get(op.mask);
  if (!asset || !(op.amount > 0)) return;
  const { w: W, h: H, d } = img;
  const mn = Math.min(W, H);
  const pm = prepareCutMask(asset, ((op.feather || 0) / 100) * 0.02 * Math.min(asset.w, asset.h), op.grow || 0);
  const m = sampleMask(pm, W, H);
  const blurred = blurRGBA(img, Math.max(1, (op.amount / 100) * 0.035 * mn));
  for (let i = 0, j = 0; i < W * H; i++, j += 4) {
    const k = m[i];
    d[j] = blurred[j] + (d[j] - blurred[j]) * k; d[j + 1] = blurred[j + 1] + (d[j + 1] - blurred[j + 1]) * k; d[j + 2] = blurred[j + 2] + (d[j + 2] - blurred[j + 2]) * k;
  }
}

/** 리터치 연산 목록을 순서대로 적용 (img 는 호출자가 복사본으로 넘겨야 함) */
export function applyRetouch(img, ops, assets) {
  if (!ops || !ops.length) return img;
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.k === 'liq') {
      const group = [];
      while (i < ops.length && ops[i].k === 'liq') group.push(ops[i++]);
      applyLiquifyGroup(img, group);
      continue;
    }
    if (op.k === 'clone') applyClone(img, op);
    else if (op.k === 'erase') applyErase(img, op);
    else if (op.k === 'cut') applyCut(img, op, assets);
    else if (op.k === 'bgblur') applyBgBlur(img, op, assets);
    i++;
  }
  return img;
}

export { lerp, smoothstep };
