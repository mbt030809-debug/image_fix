// AI 편집 작업(DOM 필요): 선택 영역 → 요청 이미지/마스크 준비 → 결과 패치(선택 안쪽만 보이는 RGBA 캔버스) 생성
import { orientedSize } from '../engine/geometry.js';
import { bboxOf, sampleMask, featherU8 } from './selection.js';
import { planRequest, rectToCrop, placeInCanvas, apiMaskRGBA, toneOffsets, buildPatch, featherSigma, layerPlacement, CONTEXTS } from './plan.js';

const toBlob = (cv, type = 'image/png') => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type));
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/**
 * ed: Editor, sel: {mask, w, h} (격자 마스크, 표시 영역 기준), opts: {ctx: 0..2, feather: 0..100}
 * 반환: 요청에 필요한 모든 것 (imageBlob, maskBlob, size, fit, rect, …)
 */
export async function prepareRequest(ed, sel, opts) {
  const bb = bboxOf(sel.mask, sel.w, sel.h);
  if (!bb) throw new Error('empty selection');
  const doc = ed.doc(), info = ed.info;
  const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
  const crop = doc.geo.crop;
  const full = { w: crop[2] * Wo, h: crop[3] * Ho };
  const plan = planRequest({ x0: bb.x0 / sel.w, y0: bb.y0 / sel.h, x1: bb.x1 / sel.w, y1: bb.y1 / sel.h }, full, { context: CONTEXTS[opts.ctx == null ? 1 : opts.ctx] });
  const { rect, size, fit } = plan;
  const selFit = sampleMask(sel.mask, sel.w, sel.h, { x: (rect.x / full.w) * sel.w, y: (rect.y / full.h) * sel.h, w: (rect.w / full.w) * sel.w, h: (rect.h / full.h) * sel.h }, fit.w, fit.h);
  const selFull = placeInCanvas(selFit, size, fit);

  // 영역을 작업 해상도로 합성(보정 + 레이어 + 배경, 프레임 제외)
  const region = await ed.renderRegion(rectToCrop(rect, full, crop), Math.max(fit.w, fit.h));
  const cv = mkCanvas(size.w, size.h);
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, size.w, size.h); // 투명한 영역이 있어도 모델에는 불투명한 이미지를 보낸다
  if (fit.w < size.w || fit.h < size.h) { // 극단적인 비율: 빈 곳은 흐린 확대본으로 채움(모델이 투명/단색 막대를 보지 않게)
    c.save(); c.filter = 'blur(14px)'; c.drawImage(region, -16, -16, size.w + 32, size.h + 32); c.restore();
  }
  c.drawImage(region, fit.x, fit.y, fit.w, fit.h);
  const origData = c.getImageData(0, 0, size.w, size.h);
  const sigmaReq = featherSigma(opts.feather == null ? 30 : opts.feather, full, plan.k);
  const dil = Math.max(3, Math.min(Math.round(0.04 * Math.max(size.w, size.h)), Math.round(sigmaReq * 2) + 3));
  const maskRGBA = apiMaskRGBA(selFull, size, dil);
  const mcv = mkCanvas(size.w, size.h);
  mcv.getContext('2d').putImageData(new ImageData(maskRGBA, size.w, size.h), 0, 0);
  const [imageBlob, maskBlob] = await Promise.all([toBlob(cv), toBlob(mcv)]);
  const place = layerPlacement(rect, full, crop, Wo, Ho);
  return { plan, size, fit, rect, full, crop, selFit, selFull, origData, imageBlob, maskBlob, preview: cv, dil, place };
}

/** AI 결과 PNG → 패치 캔버스(fit 크기, alpha = 부드러운 선택 마스크). opts: {feather, tone} */
export async function makePatch(blob, prep, opts) {
  const { size, fit, plan } = prep;
  const bmp = await createImageBitmap(blob);
  const cv = mkCanvas(size.w, size.h);
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingQuality = 'high';
  c.drawImage(bmp, 0, 0, size.w, size.h);
  if (bmp.close) bmp.close();
  const ai = c.getImageData(0, 0, size.w, size.h).data;
  const off = opts.tone === false ? null : toneOffsets(ai, prep.origData.data, prep.selFull, size, fit, prep.dil + 2);
  const sigma = featherSigma(opts.feather == null ? 30 : opts.feather, prep.full, plan.k);
  const alpha = featherU8(prep.selFit, fit.w, fit.h, sigma);
  const patch = buildPatch(ai, size, fit, alpha, off);
  const pc = mkCanvas(fit.w, fit.h);
  pc.getContext('2d').putImageData(new ImageData(patch, fit.w, fit.h), 0, 0);
  return pc;
}

/** 요청 이미지에 선택 영역을 색으로 덧칠한 작은 미리보기(보내는 이미지 확인용) */
export function sentPreview(prep, maxSide = 200) {
  const { size, selFull } = prep;
  const k = Math.min(1, maxSide / Math.max(size.w, size.h));
  const w = Math.max(1, Math.round(size.w * k)), h = Math.max(1, Math.round(size.h * k));
  const out = mkCanvas(w, h);
  const c = out.getContext('2d');
  c.imageSmoothingQuality = 'high';
  c.drawImage(prep.preview, 0, 0, w, h);
  const t = mkCanvas(size.w, size.h);
  const id = new ImageData(size.w, size.h);
  for (let i = 0; i < selFull.length; i++) { const a = selFull[i]; if (a) { id.data[i * 4] = 79; id.data[i * 4 + 1] = 140; id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = a * 0.5; } }
  t.getContext('2d').putImageData(id, 0, 0);
  c.drawImage(t, 0, 0, w, h);
  return out;
}
