// AI 수정(영역 선택 · 요청 계획 · OpenAI 요청/오류) 순수 로직 단위 테스트. 실행: node web/tests/ai.unit.mjs
import {
  newMask, rasterPolygon, rectPts, ellipsePts, combine, stampOp, strokeOp, invertMask, bboxOf, coverage,
  growMask, featherU8, sampleMask, contourSegments,
} from '../src/ai/selection.js';
import {
  SIZES, pickSize, planRequest, layerPlacement, rectToCrop, placeInCanvas, apiMaskRGBA, toneOffsets, buildPatch, featherSigma,
} from '../src/ai/plan.js';
import { pickBestImageModel, listImageModels, wrapPrompt, buildMultipart, buildEditRequest, explainError, cleanKey } from '../src/ai/openai.js';
import {
  PROVIDERS, PROVIDER_IDS, SIZES_FREE, SIZES_CF, CF_MODELS, CF_GENERATE_MODELS, CF_MODEL_RE, isCfGenerateModel, modelProfile, hasHangul, translateToEnglish, blobToBase64, base64ToBlob, dataUrlToBlob, sniffType, instruct,
  extractOpenRouterImages, parseOpenRouterModels, pickFreeImageModel, orderOpenRouterModels, parseCfModels, parseCloudflareImage,
} from '../src/ai/providers.js';
import { AiError } from '../src/ai/client.js';
import { aiConfig, pcfg } from '../src/tools/aisettings.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') { if (cond) pass++; else { fail++; console.log('  ✗ FAIL:', name, extra); } }
function near(a, b, eps, name) { ok(Math.abs(a - b) <= eps, name, `(${a} vs ${b})`); }
function section(n) { console.log('▶', n); }
const sum = (m) => { let s = 0; for (let i = 0; i < m.length; i++) s += m[i]; return s / 255; };

section('selection: polygon / shapes');
{
  const W = 60, H = 60;
  const sq = rasterPolygon(rectPts(10, 10, 30, 30), W, H);
  near(sum(sq), 400, 0.5, 'square area');
  ok(sq[20 * W + 20] === 255 && sq[5 * W + 5] === 0 && sq[29 * W + 29] === 255 && sq[30 * W + 30] === 0, 'square inside/outside');
  const half = rasterPolygon(rectPts(10.5, 10, 30.5, 30), W, H);
  near(half[15 * W + 10], 128, 3, 'half-covered edge pixel');
  const tri = rasterPolygon([0, 0, 40, 0, 0, 40], W, H);
  near(sum(tri), 800, 800 * 0.02, 'triangle area');
  const el = rasterPolygon(ellipsePts(30, 30, 15, 10), W, H);
  near(sum(el), Math.PI * 150, Math.PI * 150 * 0.02, 'ellipse area');
  // 8자(자기 교차) 도 nonzero 로 채워짐
  const fig8 = rasterPolygon([5, 5, 25, 25, 25, 5, 5, 25], W, H);
  ok(sum(fig8) > 100 && fig8[15 * W + 6] > 0 && fig8[15 * W + 24] > 0, 'self-intersecting polygon filled');
  ok(sum(rasterPolygon([1, 1, 5, 5], W, H)) === 0, 'degenerate polygon empty');
  // 화면 밖으로 나가는 폴리곤도 안전
  const big = rasterPolygon(rectPts(-20, -20, 80, 80), W, H);
  ok(big.every((v) => v === 255), 'polygon larger than mask fills all');
}

section('selection: combine / brush / invert / bbox');
{
  const W = 50, H = 50;
  const a = newMask(W, H);
  combine(a, rasterPolygon(rectPts(5, 5, 25, 25), W, H), 'add');
  combine(a, rasterPolygon(rectPts(15, 15, 35, 35), W, H), 'add');
  near(sum(a), 400 + 400 - 100, 1, 'union area');
  combine(a, rasterPolygon(rectPts(10, 10, 20, 20), W, H), 'sub');
  near(sum(a), 700 - 100, 1, 'subtract hole');
  ok(a[15 * W + 15] === 0 && a[7 * W + 7] === 255, 'hole + remainder');
  ok(a.every((v) => v >= 0 && v <= 255), 'values stay 0..255');
  const inv = invertMask(a.slice());
  ok(inv[15 * W + 15] === 255 && inv[7 * W + 7] === 0, 'invert');
  near(coverage(a) + coverage(inv), 1, 1e-9, 'coverage complement');
  const bb = bboxOf(a, W, H);
  ok(bb && bb.x0 === 5 && bb.y0 === 5 && bb.x1 === 35 && bb.y1 === 35, 'bbox', JSON.stringify(bb));
  ok(bboxOf(newMask(W, H), W, H) === null, 'bbox empty = null');
  // 브러시: 가로 획 면적 ≈ 2rL + πr² (hard=1)
  const b = newMask(100, 60);
  strokeOp(b, 100, 60, 20, 30, 80, 30, 6, 1, 'add');
  near(sum(b), 2 * 6 * 60 + Math.PI * 36, (2 * 6 * 60 + Math.PI * 36) * 0.05, 'brush stroke area');
  // 빼기 브러시
  strokeOp(b, 100, 60, 40, 30, 60, 30, 3, 1, 'sub');
  ok(b[30 * 100 + 50] === 0 && b[30 * 100 + 30] === 255, 'subtract brush');
  const s = newMask(20, 20); stampOp(s, 20, 20, 10, 10, 5, 0.5, 'add');
  ok(s[10 * 20 + 10] === 255 && s[10 * 20 + 14] > 0 && s[10 * 20 + 14] < 255 && s[0] === 0, 'soft stamp falloff');
}

section('selection: grow / shrink / feather / sample');
{
  const W = 60, H = 60;
  const sq = rasterPolygon(rectPts(20, 20, 40, 40), W, H);
  const g = growMask(sq, W, H, 3), bg = bboxOf(g, W, H, 127);
  ok(bg && bg.x0 === 17 && bg.x1 === 43 && bg.y0 === 17 && bg.y1 === 43, 'dilate bbox +3', JSON.stringify(bg));
  ok(sum(g) > sum(sq) + 200 && sum(g) < 26 * 26, 'dilate area plausible (rounded corners)', String(sum(g)));
  const e = growMask(sq, W, H, -3), be = bboxOf(e, W, H, 127);
  ok(be && be.x0 === 23 && be.x1 === 37 && be.y0 === 23 && be.y1 === 37, 'erode bbox -3', JSON.stringify(be));
  ok(growMask(sq, W, H, 0).every((v, i) => v === sq[i]), 'grow 0 = copy');
  const border = newMask(30, 30, 255);
  ok(growMask(border, 30, 30, -4).every((v) => v === 255), 'erode does not eat from image border');
  const f = featherU8(sq, W, H, 3);
  near(sum(f), sum(sq), 8, 'feather preserves mass');
  ok(f[30 * W + 20] > 90 && f[30 * W + 20] < 170, 'feather edge ≈ 50%');
  ok(f[30 * W + 14] > 0 && f[30 * W + 14] < 60 && f[30 * W + 30] > 240, 'feather falloff outside / solid inside');
  ok(featherU8(sq, W, H, 0).every((v, i) => v === sq[i]), 'feather 0 = copy');
  // 샘플링
  const same = sampleMask(sq, W, H, { x: 0, y: 0, w: W, h: H }, W, H);
  ok(same.every((v, i) => Math.abs(v - sq[i]) <= 1), 'sample identity');
  const zoom = sampleMask(sq, W, H, { x: 20, y: 20, w: 20, h: 20 }, 40, 40);
  ok(zoom[20 * 40 + 20] === 255 && zoom[0] > 120 && zoom[0] < 255 && zoom[39 * 40 + 39] > 120, 'sample zoom into selection (bilinear at the edge)');
  const edge = sampleMask(newMask(10, 10, 255), 10, 10, { x: -5, y: -5, w: 10, h: 10 }, 10, 10);
  ok(edge[0] === 255, 'sample clamps outside');
}

section('selection: contour');
{
  const W = 40, H = 40;
  const sq = rasterPolygon(rectPts(10, 10, 30, 30), W, H);
  const segs = contourSegments(sq, W, H);
  let len = 0; for (let i = 0; i < segs.length; i += 4) len += Math.hypot(segs[i + 2] - segs[i], segs[i + 3] - segs[i + 1]);
  near(len, 80 - 4 * 0.293, 0.6, 'rect contour length');
  const cnt = new Map();
  const key = (x, y) => Math.round(x * 100) + ',' + Math.round(y * 100);
  for (let i = 0; i < segs.length; i += 4) { for (const k of [key(segs[i], segs[i + 1]), key(segs[i + 2], segs[i + 3])]) cnt.set(k, (cnt.get(k) || 0) + 1); }
  ok([...cnt.values()].every((c) => c === 2), 'contour is a closed loop (each vertex used twice)');
  ok(contourSegments(newMask(W, H), W, H).length === 0, 'empty mask → no contour');
  const full = contourSegments(newMask(8, 8, 255), 8, 8);
  let fl = 0; for (let i = 0; i < full.length; i += 4) fl += Math.hypot(full[i + 2] - full[i], full[i + 3] - full[i + 1]);
  near(fl, 32 - 4 * 0.293, 0.6, 'mask touching border still closes');
  // 두 덩어리 → 두 루프
  const two = newMask(W, H); combine(two, rasterPolygon(rectPts(2, 2, 10, 10), W, H), 'add'); combine(two, rasterPolygon(rectPts(20, 20, 30, 30), W, H), 'add');
  const sg2 = contourSegments(two, W, H); let l2 = 0; for (let i = 0; i < sg2.length; i += 4) l2 += Math.hypot(sg2[i + 2] - sg2[i], sg2[i + 3] - sg2[i + 1]);
  near(l2, (32 - 1.17) + (40 - 1.17), 1, 'two blobs contour length');
}

section('plan: sizes / request crop');
{
  ok(pickSize(1).str === '1024x1024' && pickSize(1.4).str === '1536x1024' && pickSize(0.7).str === '1024x1536', 'pickSize by aspect');
  ok(pickSize(0.9).str === '1024x1024' && pickSize(1.2).str === '1024x1024' && pickSize(1.3).str === '1536x1024' && pickSize(0.75).str === '1024x1536', 'pickSize nearest (log space)');
  const full = { w: 4000, h: 3000 };
  const p = planRequest({ x0: 0.45, y0: 0.4, x1: 0.55, y1: 0.5 }, full, { context: 0.4 });
  const { rect, size, fit } = p;
  ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= full.w && rect.y + rect.h <= full.h, 'rect inside image', JSON.stringify(rect));
  ok(rect.x <= 0.45 * full.w && rect.y <= 0.4 * full.h && rect.x + rect.w >= 0.55 * full.w && rect.y + rect.h >= 0.5 * full.h, 'rect contains bbox');
  ok(fit.x >= 0 && fit.y >= 0 && fit.x + fit.w <= size.w && fit.y + fit.h <= size.h, 'fit inside size');
  near(rect.w / rect.h, size.w / size.h, 0.02, 'rect aspect matches provider size');
  ok(rect.w >= 320 - 1 && rect.h >= 320 - 1, 'min context side');
  // 모서리 / 가장자리
  const c = planRequest({ x0: 0, y0: 0, x1: 0.05, y1: 0.05 }, full, {});
  ok(c.rect.x === 0 && c.rect.y === 0, 'corner selection clamps rect to image');
  ok(c.rect.x + c.rect.w >= 0.05 * full.w && c.rect.y + c.rect.h >= 0.05 * full.h, 'corner rect still covers bbox');
  const r2 = planRequest({ x0: 0.9, y0: 0.9, x1: 1, y1: 1 }, full, {});
  ok(r2.rect.x + r2.rect.w === full.w && r2.rect.y + r2.rect.h === full.h, 'bottom-right clamps to image');
  // 전체 선택: 이미지보다 큰 요청 → 이미지 전체 + 레터박스
  const wide = { w: 4000, h: 1000 };
  const all = planRequest({ x0: 0, y0: 0, x1: 1, y1: 1 }, wide, { context: 0.4 });
  ok(all.rect.w === 4000 && all.rect.h === 1000, 'full selection = whole image');
  ok(all.fit.w === all.size.w && all.fit.h < all.size.h && all.fit.y > 0, 'panorama is letterboxed inside size', JSON.stringify(all.fit));
  // 작은 이미지
  const small = planRequest({ x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 }, { w: 200, h: 150 }, {});
  ok(small.rect.w <= 200 && small.rect.h <= 150 && small.rect.w >= 1, 'tiny image handled');
  // 세로 사진 → 세로 크기
  const tall = planRequest({ x0: 0.4, y0: 0.2, x1: 0.6, y1: 0.8 }, { w: 3000, h: 4000 }, { context: 0.15 });
  ok(tall.size.str === '1024x1536', 'tall selection picks portrait size', tall.size.str);
  for (const s of SIZES) ok(s.w * s.h > 0 && s.str === `${s.w}x${s.h}`, 'size table consistent ' + s.str);
}

section('plan: placement / masks / tone / patch');
{
  const full = { w: 3000, h: 2000 }, crop = [0.1, 0.2, 0.5, 0.6], Wo = 6000, Ho = 4000;
  // full = crop*oriented: (0.5*6000, 0.6*4000) = (3000, 2400)  → 테스트용으로 일치시킴
  const f2 = { w: crop[2] * Wo, h: crop[3] * Ho };
  const rect = { x: 600, y: 480, w: 1200, h: 800 };
  const pl = layerPlacement(rect, f2, crop, Wo, Ho);
  near(pl.x, 0.1 + ((600 + 600) / 3000) * 0.5, 1e-9, 'placement x');
  near(pl.y, 0.2 + ((480 + 400) / 2400) * 0.6, 1e-9, 'placement y');
  near(pl.w * Math.min(Wo, Ho), 1200, 1e-6, 'placement width in px (unit = short side)');
  const rc = rectToCrop(rect, f2, crop);
  near(rc[0], 0.1 + (600 / 3000) * 0.5, 1e-9, 'rectToCrop x'); near(rc[2], (1200 / 3000) * 0.5, 1e-9, 'rectToCrop w');
  void full;

  const size = { w: 40, h: 30 }, fit = { x: 0, y: 5, w: 40, h: 20 };
  const selFit = newMask(40, 20); combine(selFit, rasterPolygon(rectPts(10, 5, 30, 15), 40, 20), 'add');
  const selFull = placeInCanvas(selFit, size, fit);
  ok(selFull.length === 1200 && selFull[(5 + 10) * 40 + 20] === 255 && selFull[0] === 0, 'placeInCanvas offsets by fit');
  const m = apiMaskRGBA(selFull, size, 0);
  ok(m[((5 + 10) * 40 + 20) * 4 + 3] === 0 && m[3] === 255, 'api mask: selection transparent, elsewhere opaque');
  const md = apiMaskRGBA(selFull, size, 2);
  ok(md[((5 + 10) * 40 + 8) * 4 + 3] === 0 && m[((5 + 10) * 40 + 8) * 4 + 3] === 255, 'api mask dilation expands edit area');

  // 톤 맞춤: 선택 밖 전역 밝기 drift(+10) 를 평균 차이로 추정
  const S2 = { w: 120, h: 120 }, F2 = { x: 0, y: 0, w: 120, h: 120 };
  const sel2 = newMask(120, 120); combine(sel2, rasterPolygon(rectPts(45, 45, 75, 75), 120, 120), 'add');
  const orig = new Uint8ClampedArray(120 * 120 * 4), ai = new Uint8ClampedArray(120 * 120 * 4);
  for (let i = 0; i < 120 * 120; i++) { orig[i * 4] = 100; orig[i * 4 + 1] = 120; orig[i * 4 + 2] = 140; orig[i * 4 + 3] = 255; ai[i * 4] = 110; ai[i * 4 + 1] = 108; ai[i * 4 + 2] = 140; ai[i * 4 + 3] = 255; }
  const off = toneOffsets(ai, orig, sel2, S2, F2, 5, 12);
  ok(off && Math.abs(off[0] + 10) < 0.5 && Math.abs(off[1] - 12) < 0.5 && Math.abs(off[2]) < 0.5, 'tone offsets recover global drift', JSON.stringify(off));
  for (let i = 0; i < 120 * 120; i++) ai[i * 4] = 200; // 큰 drift → 클램프
  const off2 = toneOffsets(ai, orig, sel2, S2, F2, 5, 12, 24);
  ok(off2 && off2[0] === -24, 'tone offsets clamp', JSON.stringify(off2));
  ok(toneOffsets(ai, orig, newMask(120, 120, 255), S2, F2, 5, 12) === null, 'no ring (select all) → null');

  const alpha = new Uint8Array(40 * 20).fill(128);
  const aiBuf = new Uint8ClampedArray(40 * 30 * 4); for (let i = 0; i < 40 * 30; i++) { aiBuf[i * 4] = 250; aiBuf[i * 4 + 1] = 10; aiBuf[i * 4 + 2] = 100; aiBuf[i * 4 + 3] = 255; }
  const patch = buildPatch(aiBuf, size, fit, alpha, [10, -20, 5]);
  ok(patch.length === 40 * 20 * 4 && patch[0] === 255 && patch[1] === 0 && patch[2] === 105 && patch[3] === 128, 'patch applies offsets (clamped) + alpha', Array.from(patch.slice(0, 4)).join(','));
  near(featherSigma(100, { w: 4000, h: 3000 }, 0.5), 0.03 * 3000 * 0.5, 1e-9, 'feather sigma');
  ok(featherSigma(0, { w: 4000, h: 3000 }, 1) === 0, 'feather 0 → sigma 0');
}

section('openai: models / prompt / multipart');
{
  ok(pickBestImageModel(['gpt-4o', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5', 'gpt-image-2', 'gpt-image-2-2026-01-01']) === 'gpt-image-2', 'best model = newest');
  ok(pickBestImageModel(['gpt-image-1', 'gpt-image-1-mini', 'gpt-image-1.5']) === 'gpt-image-1.5', 'best model 1.5 > 1');
  ok(pickBestImageModel(['gpt-image-1-mini', 'gpt-image-1']) === 'gpt-image-1', 'prefer full over mini at same version');
  ok(pickBestImageModel(['gpt-image-1-2025-04-15', 'gpt-image-1']) === 'gpt-image-1', 'prefer alias over dated snapshot');
  ok(pickBestImageModel(['gpt-image-1-mini']) === 'gpt-image-1-mini', 'mini only');
  ok(pickBestImageModel(['dall-e-3', 'gpt-4o']) === null && pickBestImageModel([]) === null && pickBestImageModel(null) === null, 'no image models → null');
  ok(pickBestImageModel(['gpt-image-10', 'gpt-image-9']) === 'gpt-image-10', 'numeric (not lexicographic) version order');
  const list = listImageModels(['gpt-4o', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini', 'chatgpt-image-latest']);
  ok(list.join() === 'gpt-image-1.5,gpt-image-1,gpt-image-1-mini', 'listImageModels order', list.join());

  const wp = wrapPrompt('  셔츠를 파란색으로  ');
  ok(wp.startsWith('셔츠를 파란색으로\n') && /masked/.test(wp) && /unchanged/.test(wp), 'wrapPrompt');
  ok(wrapPrompt('x'.repeat(5000)).split('\n')[0].length === 1500, 'wrapPrompt truncates');

  const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255, 13, 10, 45, 45])], { type: 'image/png' });
  const mask = new Blob([Uint8Array.from([137, 80, 78, 71, 9, 9, 9])], { type: 'image/png' });
  const req = buildEditRequest({ model: 'gpt-image-1', prompt: '한글 프롬프트\n두 번째 줄', size: '1536x1024', quality: 'high', n: 2 }, png, mask);
  ok(req.method === 'POST' && req.path === '/images/edits' && /^multipart\/form-data; boundary=/.test(req.contentType), 'edit request shape');
  const fd = await new Response(req.body, { headers: { 'content-type': req.contentType } }).formData();
  ok(fd.get('model') === 'gpt-image-1' && fd.get('size') === '1536x1024' && fd.get('quality') === 'high' && fd.get('n') === '2', 'multipart fields');
  ok(String(fd.get('prompt')).startsWith('한글 프롬프트\n두 번째 줄') && /masked/.test(String(fd.get('prompt'))), 'multipart prompt (UTF-8, newline)');
  const fimg = fd.get('image'), fmask = fd.get('mask');
  ok(fimg.name === 'image.png' && fimg.type === 'image/png' && fimg.size === png.size, 'multipart image part');
  ok(fmask.name === 'mask.png' && fmask.size === mask.size, 'multipart mask part');
  const got = new Uint8Array(await fimg.arrayBuffer()), exp = new Uint8Array(await png.arrayBuffer());
  ok(got.length === exp.length && got.every((v, i) => v === exp[i]), 'binary part bytes intact (incl. CRLF-like bytes)');
  const mp = buildMultipart({ a: '1', b: null }, []);
  const fd2 = await new Response(mp.body, { headers: { 'content-type': mp.contentType } }).formData();
  ok(fd2.get('a') === '1' && !fd2.has('b'), 'null fields skipped');
}

section('openai: errors / key');
{
  const k = (e) => explainError(e).key;
  ok(k({ status: 401, code: 'invalid_api_key' }) === 'key' && explainError({ status: 401 }).settings, '401 → key');
  ok(k({ status: 403, message: 'Your organization must be verified to use the model `gpt-image-1`.' }) === 'verify', '403 verify');
  ok(k({ status: 403, message: 'forbidden' }) === 'forbidden', '403 other');
  ok(k({ status: 404, code: 'model_not_found' }) === 'model', '404 → model');
  ok(k({ status: 429, code: 'insufficient_quota' }) === 'quota', '429 quota');
  ok(k({ status: 429, code: 'rate_limit_exceeded' }) === 'rate', '429 rate');
  ok(k({ status: 400, code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' }) === 'policy', '400 moderation');
  ok(k({ status: 500 }) === 'server' && k({ status: 503 }) === 'server', '5xx');
  ok(k({ status: 0, code: 'network' }) === 'offline' && k({ code: 'offline' }) === 'offline', 'offline');
  ok(k({ code: 'timeout' }) === 'timeout' && k({ code: 'cancelled' }) === 'cancelled' && k({ code: 'tls' }) === 'tls', 'timeout/cancel/tls');
  ok(k({ code: 'bad_response', status: 200 }) === 'bad', 'bad response');
  const o = explainError({ status: 400, code: 'invalid_value', message: 'Invalid size' });
  ok(o.key === 'other' && /400/.test(o.text) && /Invalid size/.test(o.text), 'other keeps status + message');
  ok(explainError(null).key === 'offline', 'null error does not throw');
  ok(cleanKey(' sk-proj-abc123 \n') === 'sk-proj-abc123' && cleanKey('short') === '' && cleanKey('한글키한글키한글키한글키') === '' && cleanKey('a'.repeat(500)) === '', 'cleanKey');
}

section('providers: binary helpers');
{
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 250, 251, 252]);
  const b64 = await blobToBase64(new Blob([png]));
  ok(b64 === Buffer.from(png).toString('base64'), 'blobToBase64 matches Buffer');
  const back = base64ToBlob(b64, 'application/octet-stream');
  ok(back.type === 'image/png' && new Uint8Array(await back.arrayBuffer()).every((v, i) => v === png[i]), 'base64ToBlob sniffs PNG + roundtrips');
  ok(sniffType(Uint8Array.from([0xff, 0xd8, 1])) === 'image/jpeg' && sniffType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === 'image/webp' && sniffType(Uint8Array.from([1, 2, 3])) === null, 'sniffType');
  const big = new Uint8Array(300000).map((_, i) => (i * 7) & 255); big.set([0x89, 0x50, 0x4e, 0x47]);
  const bb = await blobToBase64(new Blob([big]));
  ok(bb === Buffer.from(big).toString('base64'), 'blobToBase64 handles large blobs (chunked)');
  const du = dataUrlToBlob('data:image/png;base64,' + b64);
  ok(du && du.type === 'image/png' && du.size === png.length, 'dataUrlToBlob');
  ok(dataUrlToBlob('data:text/plain,hello') === null && dataUrlToBlob('http://x/y.png') === null && dataUrlToBlob(null) === null, 'dataUrlToBlob rejects non-base64 / non-data');
}

section('providers: OpenRouter parse / models');
{
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r1 = extractOpenRouterImages({ choices: [{ message: { role: 'assistant', content: 'done', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] } }] });
  ok(r1.length === 1 && r1[0].type === 'image/png' && r1[0].size > 50, 'message.images[] data URL');
  const r2 = extractOpenRouterImages({ choices: [{ message: { content: [{ type: 'text', text: 'x' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }] } }] });
  ok(r2.length === 1, 'content[] image_url part');
  const r3 = extractOpenRouterImages({ choices: [{ message: { content: 'here ![img](data:image/png;base64,' + PNG + ') ok' } }] });
  ok(r3.length === 1, 'markdown data URL in text content');
  ok(extractOpenRouterImages({ choices: [{ message: { content: 'sorry, text only' } }] }).length === 0 && extractOpenRouterImages({}).length === 0 && extractOpenRouterImages(null).length === 0, 'no images → empty');
  ok(extractOpenRouterImages({ choices: [{ message: { images: [{ image_url: { url: 'https://x/y.png' } }] } }] }).length === 0, 'remote URLs are ignored (only data URLs)');

  const models = { data: [
    { id: 'a/text-only', created: 5, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'old/img-edit:free', created: 100, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'new/img-edit:free', created: 300, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'zero/priced', created: 250, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0', completion: '0', image: '0', request: '0' } },
    { id: 'free/t2i-only:free', created: 400, architecture: { input_modalities: ['text'], output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } },
    { id: 'paid/nano', created: 500, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image', 'text'] }, pricing: { prompt: '0.0000003', completion: '0.0000025', image: '0.001', request: '0' } },
    { id: 'half/zero', created: 260, architecture: { input_modalities: ['image'], output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0.00002' } },
    { name: 'broken' }, null,
  ] };
  const list = parseOpenRouterModels(models);
  ok(list.map((m) => m.id).join() === 'paid/nano,free/t2i-only:free,new/img-edit:free,half/zero,zero/priced,old/img-edit:free', 'image-output models only, newest first', list.map((m) => m.id).join());
  const by = Object.fromEntries(list.map((m) => [m.id, m]));
  ok(by['new/img-edit:free'].free && by['zero/priced'].free && !by['paid/nano'].free && !by['half/zero'].free, 'free = :free suffix or all-zero pricing');
  ok(by['paid/nano'].edit && !by['free/t2i-only:free'].edit, 'edit = image input supported');
  ok(pickFreeImageModel(list) === 'new/img-edit:free', 'auto pick = newest FREE model that accepts image input (skips text-to-image only)');
  ok(pickFreeImageModel([]) === null && pickFreeImageModel(null) === null && pickFreeImageModel(list.filter((m) => !m.free)) === null, 'no free edit model → null');
  const ord = orderOpenRouterModels(list);
  ok(ord.meta['new/img-edit:free'].join() === 'image' && ord.meta['paid/nano'].join() === 'image,text' && Object.keys(ord.meta).length === ord.ids.length, 'meta carries each model\'s output modalities');
  ok(ord.ids.join() === 'new/img-edit:free,zero/priced,old/img-edit:free,paid/nano,half/zero' && ord.free.join() === 'new/img-edit:free,zero/priced,old/img-edit:free', 'UI order: free edit models first', ord.ids.join());
}

section('providers: OpenRouter / Cloudflare request builders');
{
  const img = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
  const marked = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])], { type: 'image/png' });
  const OR = PROVIDERS.openrouter;
  const req = await OR.buildEdit({ model: 'new/img-edit:free', prompt: '  셔츠를 파란색으로  ', size: SIZES_FREE[0], quality: 'high', n: 3 }, { image: img, marked });
  ok(req.method === 'POST' && req.path === '/chat/completions' && req.contentType === 'application/json', 'openrouter request shape');
  const body = JSON.parse(await req.body.text());
  ok(body.model === 'new/img-edit:free' && body.stream === false && body.modalities.join() === 'image,text', 'openrouter body: model / modalities / non-stream');
  const parts = body.messages[0].content;
  ok(parts.length === 3 && parts[0].type === 'text' && /Image 1/.test(parts[0].text) && /Image 2/.test(parts[0].text) && /셔츠를 파란색으로$/.test(parts[0].text), 'openrouter prompt = instruction + user request');
  ok(parts[1].image_url.url === 'data:image/png;base64,' + Buffer.from(await img.arrayBuffer()).toString('base64') && parts[2].image_url.url.startsWith('data:image/png;base64,'), 'openrouter images as data URLs (original, marked)');
  ok(!('n' in body) && !('quality' in body), 'openrouter body has no OpenAI-only params');
  const reqImgOnly = await OR.buildEdit({ model: 'img/only', prompt: 'x', size: SIZES_FREE[0], outputs: ['image'] }, { image: img, marked });
  ok(JSON.parse(await reqImgOnly.body.text()).modalities.join() === 'image', 'image-only models are asked for modalities ["image"]');
  const reqBoth = await OR.buildEdit({ model: 'img/both', prompt: 'x', size: SIZES_FREE[0], outputs: ['image', 'text'] }, { image: img, marked });
  ok(JSON.parse(await reqBoth.body.text()).modalities.join() === 'image,text', 'image+text models keep both modalities');

  const CF = PROVIDERS.cloudflare;
  const creq = await CF.buildEdit({ model: CF_MODELS[0], prompt: '하늘을 바꿔 주세요', size: SIZES_CF[1], quality: 'low', n: 1 }, { image: img, marked });
  ok(creq.method === 'POST' && creq.path === '/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b' && /^multipart\/form-data; boundary=/.test(creq.contentType), 'cloudflare request shape (account placeholder)');
  const fd = await new Response(creq.body, { headers: { 'content-type': creq.contentType } }).formData();
  ok(fd.get('width') === '960' && fd.get('height') === '640' && String(fd.get('prompt')).includes('하늘을 바꿔 주세요') && /Image 2/.test(String(fd.get('prompt'))), 'cloudflare fields: output size = 2× input class, prompt');
  ok(fd.get('input_image_0').size === img.size && fd.get('input_image_1').size === marked.size && fd.get('input_image_0').type === 'image/png', 'cloudflare input_image_0/1');
  let threw = null; try { await CF.buildEdit({ model: '@cf/../evil', prompt: 'x', size: SIZES_CF[0] }, { image: img, marked }); } catch (e) { threw = e; }
  ok(threw instanceof AiError && threw.info.status === 404, 'cloudflare rejects malformed model names');
  ok(CF_MODEL_RE.test('@cf/black-forest-labs/flux-2-dev') && !CF_MODEL_RE.test('@cf/a/b/c') && !CF_MODEL_RE.test('@hf/a/b') && !CF_MODEL_RE.test('@cf/./b'), 'CF_MODEL_RE');
  const oreq = await PROVIDERS.openai.buildEdit({ model: 'gpt-image-1', prompt: 'x', size: SIZES[1], quality: 'low', n: 2 }, { image: img, mask: marked });
  const ofd = await new Response(oreq.body, { headers: { 'content-type': oreq.contentType } }).formData();
  ok(oreq.path === '/images/edits' && ofd.get('size') === '1536x1024' && ofd.get('n') === '2' && ofd.get('mask').size === marked.size, 'openai builder unchanged through the provider interface');
  ok(/Image 1/.test(instruct('x')) && /magenta/.test(instruct('x')) && instruct('y'.repeat(5000)).split('Request: ')[1].length === 1500, 'instruct text + truncation');
}

section('providers: Cloudflare parse / models');
{
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const j = (o) => new Blob([JSON.stringify(o)], { type: 'application/json' });
  const a = await parseCloudflareImage(j({ result: { image: PNG }, success: true, errors: [], messages: [] }), 'application/json');
  ok(a.length === 1 && a[0].type === 'image/png' && a[0].size > 50, 'result.image base64 → PNG blob');
  const b = await parseCloudflareImage(j({ result: { images: [PNG] }, success: true }), 'application/json');
  ok(b.length === 1, 'result.images[0]');
  const raw = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' });
  ok((await parseCloudflareImage(raw, 'image/png'))[0] === raw, 'binary image response passes through');
  let e1 = null; try { await parseCloudflareImage(j({ success: false, errors: [{ code: 3036, message: 'you have used up your daily free allocation' }], result: null }), 'application/json'); } catch (e) { e1 = e; }
  ok(e1 instanceof AiError && e1.info.code === 'cf_3036' && explainError(e1.info).key === 'freequota', 'success:false → AiError that explains as free-quota');
  let e2 = null; try { await parseCloudflareImage(j({ success: true, result: {} }), 'application/json'); } catch (e) { e2 = e; }
  ok(e2 instanceof AiError && e2.info.code === 'no_image', 'missing image → no_image');
  let e3 = null; try { await parseCloudflareImage(new Blob(['<html>']), 'text/html'); } catch (e) { e3 = e; }
  ok(e3 instanceof AiError && e3.info.code === 'bad_response', 'non-JSON body → bad_response');
  const names = parseCfModels({ result: [{ name: '@cf/black-forest-labs/flux-2-dev' }, { name: '@cf/meta/llama-3' }, { name: '@cf/runwayml/stable-diffusion-v1-5-inpainting' }, { name: 'bad' }, null] });
  ok(names.join() === '@cf/black-forest-labs/flux-2-dev,@cf/runwayml/stable-diffusion-v1-5-inpainting', 'parseCfModels keeps image-edit models only', names.join());
  ok(parseCfModels(null).length === 0 && parseCfModels({}).length === 0, 'parseCfModels tolerant');
}

section('providers: registry / sizes / errors / config');
{
  ok(PROVIDER_IDS.join() === 'openai,openrouter,cloudflare', 'provider ids');
  for (const id of PROVIDER_IDS) {
    const P = PROVIDERS[id];
    ok(P.id === id && typeof P.buildEdit === 'function' && typeof P.edit === 'function' && typeof P.discover === 'function' && typeof P.test === 'function' && typeof P.name() === 'string' && typeof P.howto() === 'string' && typeof P.privacy('h') === 'string' && P.sizes.length === 3, 'provider interface: ' + id);
  }
  ok(PROVIDERS.openai.usesMask && !PROVIDERS.openrouter.usesMask && !PROVIDERS.cloudflare.usesMask, 'only OpenAI uses a real mask');
  ok(!PROVIDERS.openai.free && PROVIDERS.openrouter.free && PROVIDERS.cloudflare.free, 'free flags');
  ok(PROVIDERS.openai.maxN === 3 && PROVIDERS.openrouter.maxN === 1 && PROVIDERS.cloudflare.maxN === 1 && PROVIDERS.openai.hasQuality && !PROVIDERS.openrouter.hasQuality, 'variants/quality capabilities');
  ok(PROVIDERS.cloudflare.extra.check('0123456789abcdef0123456789ABCDEF') && !PROVIDERS.cloudflare.extra.check('short') && !PROVIDERS.cloudflare.extra.check(''), 'cloudflare account id check');
  ok(PROVIDERS.cloudflare.autoModel === CF_MODELS[0] && PROVIDERS.openrouter.autoModel === null, 'auto model: static for cloudflare, discovered for openrouter');
  ok(PROVIDERS.openrouter.host() === 'openrouter.ai' && PROVIDERS.cloudflare.host() === 'api.cloudflare.com' && PROVIDERS.openai.host({ base: 'https://gw.example.com/v1' }) === 'gw.example.com' && PROVIDERS.openai.host(null) === 'api.openai.com', 'provider hosts');
  ok(/저장·개선/.test(PROVIDERS.openrouter.privacy('openrouter.ai')) && !/저장·개선/.test(PROVIDERS.openai.privacy('api.openai.com')), 'free providers carry a data-use warning');
  for (const s of SIZES_FREE) ok(Math.abs(s.ar - s.w / s.h) < 1e-9 && s.str === `${s.w}x${s.h}`, 'SIZES_FREE ' + s.str);
  for (const s of SIZES_CF) ok(s.out.w === s.w * 2 && s.out.h === s.h * 2 && s.out.w <= 1024 && s.out.h <= 1024 && s.w % 16 === 0 && s.h % 16 === 0 && s.out.w % 16 === 0 && s.out.h % 16 === 0 && Math.max(s.w, s.h) < 512, 'SIZES_CF: inputs < 512, multiples of 16, output = 2×, ≤1024: ' + s.w + 'x' + s.h);
  ok(pickSize(1.45, SIZES_CF).w === 480 && pickSize(1.45, SIZES_CF).h === 320 && pickSize(0.7, SIZES_CF).h === 480 && pickSize(1, SIZES_FREE).w === 1024, 'pickSize with provider size lists');
  const pc = planRequest({ x0: 0.4, y0: 0.4, x1: 0.5, y1: 0.5 }, { w: 3000, h: 2000 }, { context: 0.4, sizes: SIZES_CF });
  ok(pc.size.out && pc.size.w <= 512 && pc.fit.w <= pc.size.w && Math.abs(pc.rect.w / pc.rect.h - pc.size.w / pc.size.h) < 0.03, 'planRequest honours provider sizes (cloudflare 512 input classes)');

  const k = (e) => explainError(e).key;
  ok(k({ status: 429, code: '429', message: 'Rate limit exceeded: free-models-per-day | upstream' }) === 'freequota', 'openrouter free daily limit');
  ok(k({ status: 429, code: 'cf_3036', message: 'you have used up your daily free allocation of 10,000 neurons' }) === 'freequota' && k({ status: 429, code: 'cf_3036' }) === 'freequota', 'cloudflare daily free allocation (3036)');
  ok(k({ status: 403, code: 'cf_5035', message: 'This model requires the Workers Paid plan' }) === 'paidplan' && explainError({ status: 403, code: 'cf_5035' }).settings && k({ status: 429, code: 'cf_3040', message: 'Out of capacity' }) === 'capacity', 'cloudflare paid-plan-only model (5035) and out-of-capacity (3040)');
  ok(k({ status: 402, code: '402', message: 'Insufficient credits' }) === 'quota' && explainError({ status: 402 }).settings, 'openrouter 402 → credits');
  ok(k({ status: 404, code: '404', message: 'No endpoints found for x/y' }) === 'model' && k({ status: 400, message: 'x is not a valid model ID' }) === 'model', 'openrouter model errors');
  ok(k({ status: 403, code: '403', message: 'Your input was flagged by moderation' }) === 'policy', 'moderation before generic 403');
  ok(k({ code: 'no_free_model' }) === 'nofree' && k({ code: 'no_account' }) === 'account' && k({ code: 'no_image', message: 'I cannot' }) === 'noimage' && k({ code: 'no_key' }) === 'key', 'new local error codes');
  ok(k({ status: 429, code: 'rate_limit_exceeded', message: 'Rate limit reached for requests per day (RPD)' }) === 'rate', 'a paid OpenAI rate limit is NOT mislabeled as free quota');
  ok(k({ status: 403, message: 'Your organization must be verified' }) === 'verify' && k({ status: 401 }) === 'key', 'previous mappings intact');

  // 설정 이전 / 멱등성
  const app = { settings: { ai: { model: 'manual', custom: 'gpt-image-x', resolved: 'gpt-image-1.5', models: ['gpt-image-1.5'], quality: 'high', n: 2, consent: { base: 'https://api.openai.com/v1', ts: 1 } } } };
  const c1 = aiConfig(app);
  ok(c1 === aiConfig(app) && c1 === app.settings.ai, 'aiConfig returns the same live object');
  ok(c1.p.openai.model === 'manual' && c1.p.openai.custom === 'gpt-image-x' && c1.p.openai.resolved === 'gpt-image-1.5' && c1.consents.openai === 'https://api.openai.com/v1' && c1.quality === 'high' && c1.n === 2, 'v1.1.0 settings migrated into p.openai / consents');
  ok(!('model' in c1) && !('consent' in c1) && c1.provider === 'openai' && c1.feather === 30 && c1.tone === true, 'old keys removed, defaults filled');
  const pcOr = pcfg(c1, 'openrouter');
  ok(pcOr.model === 'auto' && Array.isArray(pcOr.models) && Array.isArray(pcOr.free) && pcfg(c1, 'openrouter') === pcOr, 'pcfg creates defaults once');
  const app2 = { settings: {} };
  ok(aiConfig(app2).provider === 'openai' && aiConfig(app2).p && aiConfig(app2).consents, 'fresh settings');
  const app3 = { settings: { ai: { provider: 'nope' } } };
  ok(aiConfig(app3).provider === 'openai', 'unknown provider falls back');
}

section('providers: generation-only models / translation');
{
  const SCH = '@cf/black-forest-labs/flux-1-schnell';
  ok(isCfGenerateModel(SCH) && isCfGenerateModel('@cf/stabilityai/stable-diffusion-xl-base-1.0') && isCfGenerateModel('@cf/lykon/dreamshaper-8-lcm') && !isCfGenerateModel(CF_MODELS[0]) && !isCfGenerateModel('') && !isCfGenerateModel(null), 'isCfGenerateModel: text-to-image models only');
  ok(CF_GENERATE_MODELS[0] === SCH && PROVIDERS.cloudflare.generateModel === SCH && PROVIDERS.cloudflare.modelPresets.includes(SCH) && CF_MODELS.every((m) => !isCfGenerateModel(m)), 'schnell is the Cloudflare generation model and is selectable');
  const g = modelProfile('cloudflare', SCH);
  ok(g.mode === 'generate' && g.noPhoto === true && g.usesMask === false && g.sizes === SIZES_FREE, 'profile: Cloudflare schnell = generate, no photo, no mask');
  const e1 = modelProfile('cloudflare', CF_MODELS[0]), e2 = modelProfile('openai', 'gpt-image-1'), e3 = modelProfile('openrouter', 'a/b:free'), e4 = modelProfile('nope', 'x');
  ok(e1.mode === 'edit' && !e1.noPhoto && e1.sizes === SIZES_CF && !e1.usesMask, 'profile: FLUX.2 = edit with marked image (CF sizes)');
  ok(e2.mode === 'edit' && e2.usesMask && e2.sizes === SIZES && e3.mode === 'edit' && !e3.usesMask && e3.sizes === SIZES_FREE && e4.mode === 'edit' && e4.usesMask, 'profile: OpenAI mask edit, OpenRouter marked edit, unknown provider → OpenAI');
  ok(typeof PROVIDERS.openai.generate === 'function' && typeof PROVIDERS.cloudflare.generate === 'function' && PROVIDERS.openrouter.generate === undefined, 'generation capability per provider');
  ok(/api\.cloudflare\.com/.test(PROVIDERS.cloudflare.privacyText('api.cloudflare.com')) && /사진은 보내지 않아요/.test(PROVIDERS.cloudflare.privacyText('x')) && /청구/.test(PROVIDERS.openai.privacyText('api.openai.com')), 'text-only privacy notes');

  ok(hasHangul('노을') && hasHangul('a 가 b') && hasHangul('ㅋㅋ') && !hasHangul('sunset') && !hasHangul('') && !hasHangul(null), 'hasHangul');
  const asJson = (o) => ({ blob: new Blob([JSON.stringify(o)], { type: 'application/json' }), ctype: 'application/json' });
  const calls = [];
  const okRelay = async (prov, req) => { calls.push([prov, req]); return asJson({ result: { translated_text: 'a small sailboat' }, success: true }); };
  const r1 = await translateToEnglish('작은 돛단배', {}, okRelay);
  const sent = JSON.parse(await calls[0][1].body.text());
  ok(r1.text === 'a small sailboat' && r1.translated === true && calls[0][0] === 'cloudflare' && calls[0][1].method === 'POST' && calls[0][1].path === '/accounts/{account}/ai/run/@cf/meta/m2m100-1.2b' && calls[0][1].contentType === 'application/json' && sent.source_lang === 'ko' && sent.target_lang === 'en' && sent.text === '작은 돛단배', 'translate: request shape + result');
  const none = await translateToEnglish('already english', {}, async () => { throw new Error('must not be called'); });
  ok(none.text === 'already english' && none.translated === false, 'translate: nothing to do without Hangul (no network call)');
  ok((await translateToEnglish('   ', {}, okRelay)).text === '', 'translate: blank input');
  const bad = [async () => asJson({ result: { translated_text: '여전히 한국어' } }), async () => asJson({ result: {} }), async () => ({ blob: new Blob(['<html>']), ctype: 'text/html' }), async () => { throw new AiError({ status: 400, code: 'bad_request' }); }, async () => asJson({ result: { translated_text: '   ' } })];
  for (const [i, relay] of bad.entries()) { const r = await translateToEnglish('고양이', {}, relay); ok(r.text === '고양이' && r.translated === false, 'translate falls back to the original on failure #' + i); }
  let rethrown = null; try { await translateToEnglish('고양이', {}, async () => { throw new AiError({ code: 'cancelled' }); }); } catch (e) { rethrown = e; }
  ok(rethrown instanceof AiError && rethrown.info.code === 'cancelled', 'translate: cancellation is not swallowed');
  const long = await translateToEnglish('가'.repeat(900), {}, async (p, req) => { calls.push([p, req]); return asJson({ result: { translated_text: 'x'.repeat(2000) } }); });
  const lastBody = JSON.parse(await calls.at(-1)[1].body.text());
  ok(lastBody.text.length === 500 && long.text.length === 800, 'translate: input capped at 500 chars, output at 800');
}

console.log(`\nAI unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
