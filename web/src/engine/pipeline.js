// 렌더 파이프라인: 원본 → (축소) → 리터치 → 지오메트리 → 현상/필터 → 로컬 → 효과
// 단계별 결과를 캐시해서 슬라이더만 바뀌면 현상 단계부터만 다시 계산한다.
import { resizeImg, cloneImg, hasAlpha } from './util.js';
import { DEFAULT_GEO, orientedSize, renderGeometry } from './geometry.js';
import { applyRetouch } from './retouch.js';
import { developImage, mergeAdj, histogram, autoEnhance } from './develop.js';
import { getFilter } from './filters.js';
import { applyEffects, effectDefaults } from './effects.js';
import { applyLocals } from './locals.js';

const j = (v) => JSON.stringify(v === undefined ? null : v);

export class Pipeline {
  constructor() {
    this.src = null;
    this.alpha = false;
    this.assets = new Map();
    this.assetRev = 0;
    this.layers = new Map(); // scaleKey → {S, R:{key,img}, G:{key,img}, D:{key,img}}
  }

  setSource(img) {
    this.src = img;
    this.alpha = hasAlpha(img);
    this.layers.clear();
  }

  setAsset(key, asset) {
    if (asset) this.assets.set(key, asset); else this.assets.delete(key);
    this.assetRev++;
    this.layers.clear();
  }

  _layer(scale) {
    const k = scale.toFixed(4);
    let L = this.layers.get(k);
    if (!L) {
      if (this.layers.size >= 3) this.layers.delete(this.layers.keys().next().value);
      L = { S: null, R: null, G: null, D: null };
      this.layers.set(k, L);
    } else { // LRU 갱신
      this.layers.delete(k); this.layers.set(k, L);
    }
    return L;
  }

  /** 출력 크기/스케일 계산 */
  plan(doc, o = {}) {
    const src = this.src;
    const geo = doc.geo || DEFAULT_GEO();
    const crop = o.crop || geo.crop || [0, 0, 1, 1];
    const [Wo0, Ho0] = orientedSize(src.w, src.h, geo);
    const fullW = crop[2] * Wo0, fullH = crop[3] * Ho0;
    let scale = o.scale;
    if (!scale) {
      const maxSide = o.maxSide || 1600;
      scale = Math.min(o.allowUpscale ? 8 : 1, maxSide / Math.max(fullW, fullH));
    }
    scale = Math.max(0.02, Math.round(scale * 10000) / 10000);
    return { geo, crop, scale, outW: Math.max(1, Math.round(fullW * scale)), outH: Math.max(1, Math.round(fullH * scale)) };
  }

  scaledSource(scale) {
    const L = this._layer(scale);
    if (!L.S) {
      const s = this.src;
      L.S = Math.abs(scale - 1) < 1e-4 ? s : resizeImg(s, Math.round(s.w * scale), Math.round(s.h * scale));
    }
    return L.S;
  }

  /** 지오메트리까지 (캐시) */
  geometryStage(doc, o = {}) {
    const p = this.plan(doc, o);
    const L = this._layer(p.scale);
    const S = this.scaledSource(p.scale);
    const rKey = j(doc.retouch) + '|' + this.assetRev;
    if (!L.R || L.R.key !== rKey) {
      let R = S;
      if (doc.retouch && doc.retouch.length) R = applyRetouch(cloneImg(S), doc.retouch, this.assets);
      L.R = { key: rKey, img: R };
      L.G = null; L.D = null;
    }
    const gKey = j(p.geo) + '|' + j(p.crop);
    if (!L.G || L.G.key !== gKey) {
      L.G = { key: gKey, img: renderGeometry(L.R.img, { ...p.geo, crop: p.crop }, { crop: p.crop }) };
      L.D = null;
    }
    return { L, p, G: L.G.img };
  }

  /** 전체 렌더. 반환 {w,h,d,hist?} (d 는 복사본) */
  render(doc, o = {}) {
    if (!this.src) throw new Error('no source');
    const { L, p, G } = this.geometryStage(doc, o);
    const dKey = j([doc.adj, doc.filter, doc.fx, doc.locals]) + '|' + (o.noDevelop ? 1 : 0);
    let D;
    if (L.D && L.D.key === dKey) D = L.D.img;
    else {
      D = cloneImg(G);
      if (!o.noDevelop) {
        const f = doc.filter && doc.filter.id && doc.filter.id !== 'none' ? getFilter(doc.filter.id) : null;
        const A = mergeAdj(doc.adj, f ? f.p : null, f ? (doc.filter.amt == null ? 100 : doc.filter.amt) / 100 : 0);
        if (doc.filter && doc.filter.lut && !A.lut) A.lut = doc.filter.lut;
        const lutAsset = doc.lutRef ? this.assets.get(doc.lutRef.key) : null;
        if (lutAsset) A.lut = { size: lutAsset.size, data: lutAsset.data, amt: (doc.lutRef.amt == null ? 100 : doc.lutRef.amt) / 100 };
        developImage(D, A, { seed: 7 });
        applyLocals(D, doc.locals, { w: D.w, h: D.h, crop: p.crop });
        applyEffects(D, doc.fx, { w: D.w, h: D.h, mn: Math.min(D.w, D.h) });
      }
      L.D = { key: dKey, img: D };
    }
    const out = { w: D.w, h: D.h, d: new Uint8ClampedArray(D.d) };
    if (o.hist) out.hist = histogram(D, Math.max(1, Math.round(Math.sqrt((D.w * D.h) / 90000))));
    if (o.release) this.layers.clear();
    return out;
  }

  /** 자동 보정 제안 */
  analyze(doc) {
    const { G } = this.geometryStage(doc, { maxSide: 700 });
    return autoEnhance(G);
  }

  /** 필터 썸네일: 현재 지오메트리/리터치 결과를 작은 크기로 만들어 각 필터 적용 */
  thumbs(doc, ids, size = 96) {
    const { G } = this.geometryStage(doc, { maxSide: size * 2 });
    const side = Math.max(G.w, G.h);
    const k = size / side;
    const base = resizeImg(G, Math.max(1, Math.round(G.w * k)), Math.max(1, Math.round(G.h * k)));
    const res = [];
    for (const id of ids) {
      const img = cloneImg(base);
      const f = id === 'none' ? null : getFilter(id);
      if (f) developImage(img, mergeAdj(null, f.p, 1), { seed: 3 });
      res.push({ id, w: img.w, h: img.h, d: img.d });
    }
    return res;
  }

  /** 효과 썸네일 */
  thumbsFx(doc, ids, size = 96) {
    const { G } = this.geometryStage(doc, { maxSide: size * 2 });
    const k = size / Math.max(G.w, G.h);
    const base = resizeImg(G, Math.max(1, Math.round(G.w * k)), Math.max(1, Math.round(G.h * k)));
    return ids.map((id) => {
      const img = cloneImg(base);
      try { applyEffects(img, [{ k: id, p: effectDefaults(id) }], { w: img.w, h: img.h, mn: Math.min(img.w, img.h) }); } catch (e) { /* 건너뜀 */ }
      return { id, w: img.w, h: img.h, d: img.d };
    });
  }

  _wandSource() {
    if (!this._ws || this._ws.src !== this.src) {
      const s = this.src, k = Math.min(1, 1024 / Math.max(s.w, s.h));
      this._ws = { src: s, img: k < 1 ? resizeImg(s, Math.round(s.w * k), Math.round(s.h * k)) : s };
    }
    return this._ws.img;
  }

  /** 마술봉: (x,y)=원본 정규화 좌표, tol=색 허용치(0..100), contiguous=연결된 영역만. 결과 mask 255=선택 */
  wand(x, y, tol, contiguous = true) {
    const img = this._wandSource();
    const { w, h, d } = img;
    const out = new Uint8Array(w * h);
    const sx = Math.max(0, Math.min(w - 1, Math.round(x * w))), sy = Math.max(0, Math.min(h - 1, Math.round(y * h)));
    const i0 = (sy * w + sx) * 4;
    const r0 = d[i0], g0 = d[i0 + 1], b0 = d[i0 + 2];
    const th = (tol / 100) * 255 * 1.6, th2 = th * th;
    const close = (i) => { const dr = d[i] - r0, dg = d[i + 1] - g0, db = d[i + 2] - b0; return dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11 <= th2 / 1.6; };
    if (!contiguous) { for (let p = 0; p < w * h; p++) if (close(p * 4)) out[p] = 255; return { w, h, data: out }; }
    const stack = new Int32Array(w * h); let sp = 0;
    stack[sp++] = sy * w + sx; out[sy * w + sx] = 255;
    while (sp) {
      const p = stack[--sp], px = p % w, py = (p / w) | 0;
      if (px > 0 && !out[p - 1] && close((p - 1) * 4)) { out[p - 1] = 255; stack[sp++] = p - 1; }
      if (px < w - 1 && !out[p + 1] && close((p + 1) * 4)) { out[p + 1] = 255; stack[sp++] = p + 1; }
      if (py > 0 && !out[p - w] && close((p - w) * 4)) { out[p - w] = 255; stack[sp++] = p - w; }
      if (py < h - 1 && !out[p + w] && close((p + w) * 4)) { out[p + w] = 255; stack[sp++] = p + w; }
    }
    return { w, h, data: out };
  }

  /** 테두리 색을 배경으로 보고 연결된 같은 계열을 선택 (단색 배경용). 결과 mask 255=배경 */
  autoBg(tol) {
    const img = this._wandSource();
    const { w, h, d } = img;
    // 테두리 띠의 색 클러스터(대표색 최대 3개)
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.015));
    const samples = [];
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (x < band || y < band || x >= w - band || y >= h - band) { const i = (y * w + x) * 4; samples.push([d[i], d[i + 1], d[i + 2]]); }
    const centers = [];
    const dist2 = (a, b) => (a[0] - b[0]) ** 2 * 0.3 + (a[1] - b[1]) ** 2 * 0.59 + (a[2] - b[2]) ** 2 * 0.11;
    for (const s of samples) {
      let hit = centers.find((c) => dist2(c.c, s) < 40 * 40);
      if (!hit) { if (centers.length < 6) { centers.push({ c: s.slice(), n: 1 }); } continue; }
      hit.c = hit.c.map((v, k) => (v * hit.n + s[k]) / (hit.n + 1)); hit.n++;
    }
    centers.sort((a, b) => b.n - a.n);
    const bgs = centers.filter((c) => c.n > samples.length * 0.12).slice(0, 3).map((c) => c.c);
    if (!bgs.length && centers.length) bgs.push(centers[0].c);
    const th = (tol / 100) * 110 + 8, th2 = th * th;
    const out = new Uint8Array(w * h);
    const isBg = (i) => { const px = [d[i], d[i + 1], d[i + 2]]; for (const b of bgs) if (dist2(b, px) <= th2) return true; return false; };
    const stack = new Int32Array(w * h); let sp = 0;
    const push = (p) => { if (!out[p] && isBg(p * 4)) { out[p] = 255; stack[sp++] = p; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], px = p % w, py = (p / w) | 0;
      if (px > 0) push(p - 1); if (px < w - 1) push(p + 1); if (py > 0) push(p - w); if (py < h - 1) push(p + w);
    }
    return { w, h, data: out };
  }
}
