// 렌더 워커: 메인 스레드를 막지 않고 픽셀 파이프라인 실행
import { Pipeline } from './pipeline.js';

const pipe = new Pipeline();
let curLoadId = 0;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

async function loadBitmap(m) {
  const bmp = m.bitmap;
  let w = bmp.width, h = bmp.height;
  const maxSide = m.maxSide || 4096;
  const k = Math.min(1, maxSide / Math.max(w, h));
  const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
  const cv = new OffscreenCanvas(nw, nh);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, nw, nh);
  bmp.close && bmp.close();
  const id = ctx.getImageData(0, 0, nw, nh);
  pipe.setSource({ w: nw, h: nh, d: id.data });
  return { w: nw, h: nh, alpha: pipe.alpha, origW: w, origH: h };
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.t) {
      case 'load': {
        curLoadId = m.id;
        const r = await loadBitmap(m);
        post({ t: 'loaded', id: m.id, ...r });
        break;
      }
      case 'loadBuf': {
        pipe.setSource({ w: m.w, h: m.h, d: new Uint8ClampedArray(m.buffer) });
        post({ t: 'loaded', id: m.id, w: m.w, h: m.h, alpha: pipe.alpha, origW: m.w, origH: m.h });
        break;
      }
      case 'asset': {
        if (m.kind === 'mask') pipe.setAsset(m.key, { w: m.w, h: m.h, data: new Uint8Array(m.buffer) });
        else if (m.kind === 'lut') pipe.setAsset(m.key, { size: m.size, data: new Float32Array(m.buffer) });
        else if (m.kind === 'drop') pipe.setAsset(m.key, null);
        post({ t: 'ack', id: m.id });
        break;
      }
      case 'render': {
        const t0 = performance.now();
        const r = pipe.render(m.doc, m.opts || {});
        post({ t: 'result', id: m.id, w: r.w, h: r.h, buffer: r.d.buffer, hist: r.hist ? r.hist.buffer : null, ms: performance.now() - t0 }, r.hist ? [r.d.buffer, r.hist.buffer] : [r.d.buffer]);
        break;
      }
      case 'plan': {
        post({ t: 'plan', id: m.id, plan: pipe.plan(m.doc, m.opts || {}) });
        break;
      }
      case 'analyze': {
        post({ t: 'analysis', id: m.id, adj: pipe.analyze(m.doc) });
        break;
      }
      case 'thumbs': {
        const list = pipe.thumbs(m.doc, m.ids, m.size);
        post({ t: 'thumbs', id: m.id, list }, list.map((x) => x.d.buffer));
        break;
      }
      case 'thumbsFx': {
        const list = pipe.thumbsFx(m.doc, m.ids, m.size);
        post({ t: 'thumbs', id: m.id, list }, list.map((x) => x.d.buffer));
        break;
      }
      case 'wand': {
        const r = m.auto ? pipe.autoBg(m.tol) : pipe.wand(m.x, m.y, m.tol, m.contiguous !== false);
        post({ t: 'mask', id: m.id, w: r.w, h: r.h, buffer: r.data.buffer }, [r.data.buffer]);
        break;
      }
      default: break;
    }
  } catch (err) {
    post({ t: 'error', id: m.id, message: String(err && err.stack ? err.stack : err) });
  }
};
