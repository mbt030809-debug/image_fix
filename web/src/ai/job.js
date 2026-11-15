// AI 편집 작업(DOM 필요): 선택 영역 → 요청 이미지/마스크(또는 표시 이미지) 준비 → 결과 패치(선택 안쪽만 보이는 RGBA 캔버스) 생성
import { orientedSize } from '../engine/geometry.js';
import { bboxOf, sampleMask, featherU8, contourSegments } from './selection.js';
import { planRequest, rectToCrop, placeInCanvas, apiMaskRGBA, toneOffsets, buildPatch, featherSigma, layerPlacement, CONTEXTS, SIZES } from './plan.js';

const toBlob = (cv, type = 'image/png') => new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type));
const mkCanvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };

/** 요청 이미지에 선택 영역을 마젠타로 표시한 복사본 (마스크가 없는 모델에게 "여기를 고쳐" 라고 알려 주는 두 번째 이미지) */
export function markedCanvas(cv, selFull, size) {
  const m = mkCanvas(size.w, size.h);
  const x = m.getContext('2d');
  x.drawImage(cv, 0, 0);
  const tint = mkCanvas(size.w, size.h);
  const id = new ImageData(size.w, size.h);
  for (let i = 0; i < selFull.length; i++) { const a = selFull[i]; if (a) { id.data[i * 4] = 255; id.data[i * 4 + 1] = 0; id.data[i * 4 + 2] = 255; id.data[i * 4 + 3] = a * 0.45; } }
  tint.getContext('2d').putImageData(id, 0, 0);
  x.drawImage(tint, 0, 0);
  const segs = contourSegments(selFull, size.w, size.h);
  x.strokeStyle = '#ff00ff'; x.lineWidth = Math.max(2, Math.round(Math.max(size.w, size.h) * 0.004)); x.lineJoin = 'round'; x.lineCap = 'round';
  x.beginPath();
  for (let i = 0; i < segs.length; i += 4) { x.moveTo(segs[i], segs[i + 1]); x.lineTo(segs[i + 2], segs[i + 3]); }
  x.stroke();
  return m;
}

/**
 * ed: Editor, sel: {mask, w, h} (격자 마스크, 표시 영역 기준), opts: {ctx: 0..2, feather: 0..100, provider: {sizes, usesMask, maskKind, noPhoto, oneImage}}
 * noPhoto(문구만으로 그리는 모델): 사진을 인코딩/전송하지 않는다 — 영역 위치·크기 계산과 미리보기만 한다.
 * 반환: 요청에 필요한 모든 것 (imageBlob, maskBlob | markedBlob, size, fit, rect, …)
 */
export async function prepareRequest(ed, sel, opts) {
  const P = opts.provider || { sizes: SIZES, usesMask: true };
  const bb = bboxOf(sel.mask, sel.w, sel.h);
  if (!bb) throw new Error('empty selection');
  const doc = ed.doc(), info = ed.info;
  const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
  const crop = doc.geo.crop;
  const full = { w: crop[2] * Wo, h: crop[3] * Ho };
  const plan = planRequest({ x0: bb.x0 / sel.w, y0: bb.y0 / sel.h, x1: bb.x1 / sel.w, y1: bb.y1 / sel.h }, full, { context: CONTEXTS[opts.ctx == null ? 1 : opts.ctx], sizes: P.sizes });
  const { rect, size, fit } = plan;
  const gridRect = { x: (rect.x / full.w) * sel.w, y: (rect.y / full.h) * sel.h, w: (rect.w / full.w) * sel.w, h: (rect.h / full.h) * sel.h };
  const selFit = sampleMask(sel.mask, sel.w, sel.h, gridRect, fit.w, fit.h);
  const selFull = placeInCanvas(selFit, size, fit);
  // 출력 해상도가 요청 해상도와 다른 제공자(예: Cloudflare 입력 512 → 출력 1024): 패치는 출력 해상도로 만든다
  const kx = size.out ? size.out.w / size.w : 1, ky = size.out ? size.out.h / size.h : 1;
  const fitO = size.out ? { x: Math.round(fit.x * kx), y: Math.round(fit.y * ky), w: Math.max(1, Math.round(fit.w * kx)), h: Math.max(1, Math.round(fit.h * ky)) } : fit;
  const selFitO = size.out ? sampleMask(sel.mask, sel.w, sel.h, gridRect, fitO.w, fitO.h) : selFit;

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
  const noPhoto = !!P.noPhoto;
  const imageBlob = noPhoto ? null : await toBlob(cv);
  let maskBlob = null, markedBlob = null;
  if (noPhoto) { /* 사진은 보내지 않는다 */ } else if (P.usesMask) {
    const maskRGBA = apiMaskRGBA(selFull, size, dil);
    if (P.maskKind === 'white') { // 흰색 = 채울 곳, 검정 = 그대로 (불투명 흑백 마스크 — FLUX Fill 계열)
      for (let i = 0; i < maskRGBA.length; i += 4) { const v = maskRGBA[i + 3] === 0 ? 255 : 0; maskRGBA[i] = v; maskRGBA[i + 1] = v; maskRGBA[i + 2] = v; maskRGBA[i + 3] = 255; }
    }
    const mcv = mkCanvas(size.w, size.h);
    mcv.getContext('2d').putImageData(new ImageData(maskRGBA, size.w, size.h), 0, 0);
    maskBlob = await toBlob(mcv);
  } else {
    markedBlob = await toBlob(markedCanvas(cv, selFull, size));
  }
  const place = layerPlacement(rect, full, crop, Wo, Ho);
  return { plan, size, fit, fitO, rect, full, crop, selFit, selFitO, selFull, origData, imageBlob, maskBlob, markedBlob, preview: cv, dil, place, kx, ky, noPhoto };
}

/** AI 결과 이미지 → 패치 캔버스(fitO 크기, alpha = 부드러운 선택 마스크). opts: {feather, tone, cover(문구로 그린 이미지: 영역을 덮도록 잘라 맞춤)} */
export async function makePatch(blob, prep, opts) {
  const { size, fit, fitO, plan, kx, ky } = prep;
  const bmp = await createImageBitmap(blob);
  const S = mkCanvas(size.w, size.h);
  const sc = S.getContext('2d', { willReadFrequently: true });
  sc.imageSmoothingQuality = 'high';
  const place = (ctx2, W, H) => { // 보통은 늘려 맞추고, 문구로 그린 이미지(cover)는 비율을 지키며 영역을 덮도록 가운데를 잘라 맞춘다
    if (!opts.cover) { ctx2.drawImage(bmp, 0, 0, W, H); return; }
    const k = Math.max(W / bmp.width, H / bmp.height), dw = bmp.width * k, dh = bmp.height * k;
    ctx2.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  };
  place(sc, size.w, size.h);
  const aiS = sc.getImageData(0, 0, size.w, size.h).data;
  const out = size.out || size;
  let aiO = aiS;
  if (size.out) {
    const O = mkCanvas(out.w, out.h);
    const oc = O.getContext('2d', { willReadFrequently: true });
    oc.imageSmoothingQuality = 'high';
    place(oc, out.w, out.h);
    aiO = oc.getImageData(0, 0, out.w, out.h).data;
  }
  if (bmp.close) bmp.close();
  const off = opts.tone === false ? null : toneOffsets(aiS, prep.origData.data, prep.selFull, size, fit, prep.dil + 2);
  const sigma = featherSigma(opts.feather == null ? 30 : opts.feather, prep.full, plan.k) * kx;
  const alpha = featherU8(prep.selFitO, fitO.w, fitO.h, sigma);
  const patch = buildPatch(aiO, out, fitO, alpha, off);
  const pc = mkCanvas(fitO.w, fitO.h);
  pc.getContext('2d').putImageData(new ImageData(patch, fitO.w, fitO.h), 0, 0);
  void ky;
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
