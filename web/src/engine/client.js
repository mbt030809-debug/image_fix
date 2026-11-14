// 메인 스레드 쪽 엔진 클라이언트: 워커(기본) 또는 메인 스레드(폴백)에서 파이프라인 실행
import { Pipeline } from './pipeline.js';

export class Engine {
  constructor() {
    this.seq = 1;
    this.pending = new Map();
    this.worker = null;
    this.local = null;
    this.renderTicket = 0;
    this.info = null; // {w,h,alpha,origW,origH}
    try {
      if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no worker');
      this.worker = new Worker('worker.js');
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => { console.error('worker error', e.message); };
    } catch (err) {
      this.worker = null;
      this.local = new Pipeline();
    }
  }

  _onMessage(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.t === 'error') p.reject(new Error(m.message)); else p.resolve(m);
  }

  _call(msg, transfer) {
    const id = this.seq++;
    msg.id = id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage(msg, transfer || []);
    });
  }

  /** ImageBitmap 로 원본 로드 */
  async loadBitmap(bitmap, maxSide) {
    if (this.worker) {
      const r = await this._call({ t: 'load', bitmap, maxSide }, [bitmap]);
      this.info = { w: r.w, h: r.h, alpha: r.alpha, origW: r.origW, origH: r.origH };
    } else {
      const w = bitmap.width, h = bitmap.height, k = Math.min(1, maxSide / Math.max(w, h));
      const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
      const cv = document.createElement('canvas'); cv.width = nw; cv.height = nh;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, nw, nh);
      const id = ctx.getImageData(0, 0, nw, nh);
      this.local.setSource({ w: nw, h: nh, d: id.data });
      this.info = { w: nw, h: nh, alpha: this.local.alpha, origW: w, origH: h };
    }
    this.layersEpoch = (this.layersEpoch || 0) + 1;
    return this.info;
  }

  async loadBuffer(w, h, buffer) {
    if (this.worker) {
      const r = await this._call({ t: 'loadBuf', w, h, buffer }, [buffer]);
      this.info = { w: r.w, h: r.h, alpha: r.alpha, origW: w, origH: h };
    } else {
      this.local.setSource({ w, h, d: new Uint8ClampedArray(buffer) });
      this.info = { w, h, alpha: this.local.alpha, origW: w, origH: h };
    }
    return this.info;
  }

  async setAsset(key, kind, payload) {
    if (this.worker) {
      const msg = { t: 'asset', key, kind, ...payload };
      const tr = payload && payload.buffer ? [payload.buffer] : [];
      await this._call(msg, tr);
    } else if (kind === 'drop') this.local.setAsset(key, null);
    else if (kind === 'mask') this.local.setAsset(key, { w: payload.w, h: payload.h, data: new Uint8Array(payload.buffer) });
    else if (kind === 'lut') this.local.setAsset(key, { size: payload.size, data: new Float32Array(payload.buffer) });
  }

  /** 렌더 (최신 요청만 유효: 늦게 끝난 오래된 요청은 null) */
  async render(doc, opts) {
    const ticket = ++this.renderTicket;
    let res;
    if (this.worker) {
      const m = await this._call({ t: 'render', doc, opts });
      res = { w: m.w, h: m.h, data: new Uint8ClampedArray(m.buffer), hist: m.hist ? new Uint32Array(m.hist) : null, ms: m.ms };
    } else {
      await new Promise((r) => setTimeout(r, 0));
      const t0 = performance.now();
      const r = this.local.render(doc, opts);
      res = { w: r.w, h: r.h, data: r.d, hist: r.hist || null, ms: performance.now() - t0 };
    }
    res.stale = ticket !== this.renderTicket;
    return res;
  }

  async plan(doc, opts) {
    if (this.worker) return (await this._call({ t: 'plan', doc, opts })).plan;
    return this.local.plan(doc, opts || {});
  }

  async analyze(doc) {
    if (this.worker) return (await this._call({ t: 'analyze', doc })).adj;
    return this.local.analyze(doc);
  }

  async thumbs(doc, ids, size) {
    if (this.worker) return (await this._call({ t: 'thumbs', doc, ids, size })).list;
    return this.local.thumbs(doc, ids, size);
  }

  async thumbsFx(doc, ids, size) {
    if (this.worker) return (await this._call({ t: 'thumbsFx', doc, ids, size })).list;
    return this.local.thumbsFx(doc, ids, size);
  }

  /** 마술봉/자동 배경: 결과 {w,h,data:Uint8Array} (255=선택) */
  async wand(o) {
    if (this.worker) { const m = await this._call({ t: 'wand', ...o }); return { w: m.w, h: m.h, data: new Uint8Array(m.buffer) }; }
    const r = o.auto ? this.local.autoBg(o.tol) : this.local.wand(o.x, o.y, o.tol, o.contiguous !== false);
    return r;
  }
}
