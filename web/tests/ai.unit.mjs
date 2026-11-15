// AI 기능(영역 선택 · 요청 계획 · Cloudflare / ModelScope / Gemini / Hugging Face 요청·응답·오류) 순수 로직 단위 테스트. 실행: node web/tests/ai.unit.mjs
import {
  newMask, rasterPolygon, rectPts, ellipsePts, combine, stampOp, strokeOp, invertMask, bboxOf, coverage,
  growMask, featherU8, sampleMask, contourSegments,
} from '../src/ai/selection.js';
import {
  SIZES, pickSize, planRequest, layerPlacement, rectToCrop, placeInCanvas, apiMaskRGBA, toneOffsets, buildPatch, featherSigma,
} from '../src/ai/plan.js';
import { buildMultipart, explainError, cleanKey, MODEL_AUTO } from '../src/ai/common.js';
import {
  PROVIDERS, PROVIDER_IDS, getProvider, SIZES_FREE, SIZES_CF, CF_MODELS, CF_GENERATE_MODELS, CF_MODEL_RE, isCfGenerateModel, modelProfile, hasHangul, translateToEnglish, parseAccountId,
  base64ToBlob, sniffType, ensureImageBlob, instruct, parseCfModels, parseCloudflareImage, dataUrlToBlob, instructOne, GM_MODELS, GM_MODEL_RE, parseGeminiImage, parseGeminiModels, HF_MODEL, parseFalImage, MS_EDIT_TASK,
  MS_MODELS, MS_MODEL_RE, parseModelScopeTask, modelscopeGenerate, sleepAbortable,
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

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPG = () => new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70])], { type: 'image/jpeg' });
const jsonRes = (o) => ({ blob: new Blob([JSON.stringify(o)], { type: 'application/json' }), ctype: 'application/json' });
const imgRes = (ctype = 'application/octet-stream') => ({ blob: new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], { type: ctype }), ctype });
/** 호출을 기록하고, 차례대로 준비한 응답을 돌려주는 가짜 릴레이 (마지막 응답을 반복) */
function scripted(steps) {
  const calls = []; let i = 0;
  const relay = async (provider, req, opts) => { calls.push({ provider, req, opts }); const st = steps[Math.min(i++, steps.length - 1)]; return typeof st === 'function' ? st(provider, req, opts) : st; };
  relay.calls = calls;
  return relay;
}
const throwsAi = async (fn) => { try { await fn(); } catch (e) { return e; } return null; };

section('common: multipart');
{
  const png = new Blob([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 255, 13, 10, 45, 45])], { type: 'image/png' });
  const mp = buildMultipart({ prompt: '한글 프롬프트\n두 번째 줄', width: '960', skip: null }, [{ name: 'input_image_0', filename: 'image.png', type: 'image/png', blob: png }]);
  ok(/^multipart\/form-data; boundary=/.test(mp.contentType) && mp.contentType.endsWith(mp.boundary), 'content-type carries the boundary');
  const fd = await new Response(mp.body, { headers: { 'content-type': mp.contentType } }).formData();
  ok(fd.get('prompt') === '한글 프롬프트\n두 번째 줄' && fd.get('width') === '960' && !fd.has('skip'), 'fields: UTF-8, newline, null skipped');
  const f = fd.get('input_image_0');
  ok(f.name === 'image.png' && f.type === 'image/png' && f.size === png.size, 'file part name/type/size');
  const got = new Uint8Array(await f.arrayBuffer()), exp = new Uint8Array(await png.arrayBuffer());
  ok(got.length === exp.length && got.every((v, i) => v === exp[i]), 'binary part bytes intact (incl. CRLF-like bytes)');
  const mp2 = buildMultipart({ a: '1' }, []);
  const fd2 = await new Response(mp2.body, { headers: { 'content-type': mp2.contentType } }).formData();
  ok(fd2.get('a') === '1' && mp2.boundary !== mp.boundary, 'no files + unique boundaries');
}

section('common: errors / key');
{
  const k = (e) => explainError(e).key;
  ok(k({ status: 401, code: 'invalid_api_key' }) === 'key' && explainError({ status: 401 }).settings, '401 → key (opens settings)');
  ok(k({ status: 403, message: 'forbidden' }) === 'forbidden' && explainError({ status: 403 }).settings, '403 → forbidden');
  ok(k({ status: 404, code: 'model_not_found' }) === 'model' && k({ status: 400, message: 'x is not a valid model ID' }) === 'model' && k({ status: 404, code: '404', message: 'No endpoints found for x/y' }) === 'model', 'model errors');
  ok(k({ status: 429, message: 'quota exceeded' }) === 'quota' && k({ status: 429, code: 'rate_limit_exceeded' }) === 'rate' && k({ status: 402 }) === 'quota', '429 quota / rate, 402 → credits');
  ok(k({ status: 400, code: 'moderation_blocked', message: 'Your request was rejected by the safety system.' }) === 'policy' && k({ status: 403, code: '403', message: 'Your input was flagged by moderation' }) === 'policy', 'moderation (also before the generic 403)');
  ok(k({ status: 500 }) === 'server' && k({ status: 503 }) === 'server', '5xx');
  ok(k({ status: 0, code: 'network' }) === 'offline' && k({ code: 'offline' }) === 'offline' && explainError(null).key === 'offline', 'offline / null does not throw');
  ok(k({ code: 'timeout' }) === 'timeout' && k({ code: 'cancelled' }) === 'cancelled' && k({ code: 'tls' }) === 'tls', 'timeout / cancel / tls');
  ok(k({ code: 'bad_response', status: 200 }) === 'bad', 'bad response');
  const o = explainError({ status: 400, code: 'invalid_value', message: 'Invalid size' });
  ok(o.key === 'other' && /400/.test(o.text) && /Invalid size/.test(o.text), 'other keeps status + message');
  // Cloudflare
  ok(k({ status: 429, code: 'cf_3036', message: 'you have used up your daily free allocation of 10,000 neurons' }) === 'freequota' && k({ status: 429, code: 'cf_3036' }) === 'freequota', 'cloudflare daily free allocation (3036)');
  ok(k({ status: 403, code: 'cf_5035', message: 'This model requires the Workers Paid plan' }) === 'paidplan' && explainError({ status: 403, code: 'cf_5035' }).settings, 'cloudflare paid-plan-only model (5035)');
  ok(k({ status: 429, code: 'cf_3040', message: 'Out of capacity' }) === 'capacity', 'cloudflare out of capacity (3040)');
  ok(k({ code: 'no_account' }) === 'account' && explainError({ code: 'no_account' }).settings && k({ code: 'no_key' }) === 'key', 'missing account ID / key → open settings');
  // ModelScope / Gemini
  ok(k({ code: 'moderation_blocked', status: 200, message: 'blocked: SAFETY' }) === 'policy', 'Gemini safety block → policy message');
  ok(k({ status: 403, message: 'Access to model black-forest-labs/FLUX.1-Fill-dev is restricted. You must be authenticated to access it. (gated)' }) === 'gated' && explainError({ status: 403, message: 'gated repo' }).settings && k({ status: 403, message: 'forbidden' }) === 'forbidden', 'Hugging Face gated model → accept the terms (before the generic 403)');
  const tf = explainError({ code: 'task_failed', status: 200, message: 'content blocked' });
  ok(tf.key === 'taskfail' && /content blocked/.test(tf.text) && k({ code: 'task_failed' }) === 'taskfail', 'ModelScope task failed keeps the reason');
  ok(k({ code: 'no_task', status: 200 }) === 'notask' && k({ code: 'no_image', message: 'I cannot' }) === 'noimage' && /I cannot/.test(explainError({ code: 'no_image', message: 'I cannot' }).text), 'no task id / no image (message kept)');
  ok(k({ status: 401, code: 'key_unreadable' }) === 'keyread' && explainError({ status: 401, code: 'key_unreadable' }).settings && k({ status: 401, code: 'no_key' }) === 'key', 'unreadable stored key → "save the key again", distinct from "no key"');
  ok(!('verify' in { [k({ status: 403, message: 'Your organization must be verified' })]: 1 }), 'no OpenAI-specific "verify" mapping any more');
  // 키 정리
  ok(cleanKey(' cfut_abc12345 \n') === 'cfut_abc12345' && cleanKey('short') === '' && cleanKey('한글키한글키한글키한글키') === '' && cleanKey('a'.repeat(500)) === '', 'cleanKey basics');
  ok(cleanKey('Bearer ms-1a2b3c4d-5e6f') === 'ms-1a2b3c4d-5e6f' && cleanKey('  bearer   ms-1a2b3c4d-5e6f  ') === 'ms-1a2b3c4d-5e6f', 'cleanKey: "Bearer " prefix');
  ok(cleanKey('Authorization: Bearer cfut_abcdef123456') === 'cfut_abcdef123456' && cleanKey('authorization:bearer cfut_abcdef123456') === 'cfut_abcdef123456', 'cleanKey: whole header pasted');
  ok(cleanKey('"cfut_abc12345"') === 'cfut_abc12345' && cleanKey('“cfut_abc12345”,') === 'cfut_abc12345' && cleanKey("'cfut_abc12345';") === 'cfut_abc12345', 'cleanKey: quotes / trailing comma');
  ok(cleanKey('cfut_​abc‍12345﻿') === 'cfut_abc12345' && cleanKey('cfut_abc\n12345') === 'cfut_abc12345', 'cleanKey: zero-width characters and inner line breaks');
  ok(cleanKey('Bearercfut_abc12345') === 'Bearercfut_abc12345', 'cleanKey: only strips "Bearer" followed by whitespace');
  ok(cleanKey('cfut_…abcd') === '' && cleanKey('') === '' && cleanKey(null) === '' && cleanKey(undefined) === '', 'cleanKey: ellipsis / empty / null');
}

section('cloudflare account ID: pasted text');
{
  const ACC = '0123456789abcdef0123456789abcdef';
  ok(parseAccountId(ACC) === ACC && parseAccountId('  ' + ACC.toUpperCase() + '\n') === ACC, 'plain / upper-case / padded');
  ok(parseAccountId('https://dash.cloudflare.com/' + ACC + '/home') === ACC && parseAccountId('https://dash.cloudflare.com/' + ACC) === ACC, 'dashboard URL');
  ok(parseAccountId('Account ID: ' + ACC) === ACC && parseAccountId('계정 ID: ' + ACC + ' (복사됨)') === ACC, 'label around it');
  ok(parseAccountId('1234') === '' && parseAccountId('') === '' && parseAccountId(null) === '' && parseAccountId('xyz'.repeat(20)) === '', 'rejects short / empty / non-hex');
  ok(parseAccountId(ACC + 'a') === '' && parseAccountId('b' + ACC) === '' && parseAccountId(ACC + ACC) === '', 'a longer hex run is not an account ID');
  ok(PROVIDERS.cloudflare.extra.check(ACC) && PROVIDERS.cloudflare.extra.check('see ' + ACC) && !PROVIDERS.cloudflare.extra.check('1234') && PROVIDERS.cloudflare.extra.parse === parseAccountId, 'provider extra.check/parse use it');
}

section('providers: binary helpers');
{
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3, 250, 251, 252]);
  const back = base64ToBlob(Buffer.from(png).toString('base64'), 'application/octet-stream');
  ok(back.type === 'image/png' && back.size === png.length && new Uint8Array(await back.arrayBuffer()).every((v, i) => v === png[i]), 'base64ToBlob sniffs PNG + roundtrips');
  ok(base64ToBlob('AQID', 'image/x-foo').type === 'image/x-foo' && base64ToBlob('AQID').type === 'application/octet-stream', 'unknown bytes keep the given type');
  ok(sniffType(Uint8Array.from([0xff, 0xd8, 1])) === 'image/jpeg' && sniffType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === 'image/webp' && sniffType(Uint8Array.from([1, 2, 3])) === null && sniffType(new Uint8Array(0)) === null, 'sniffType');
  const e1 = await ensureImageBlob(new Blob([png], { type: 'application/octet-stream' }));
  ok(e1.type === 'image/png' && e1.size === png.length, 'ensureImageBlob: re-types by magic bytes (Content-Type is not trusted)');
  const jpg = JPG();
  ok((await ensureImageBlob(jpg)) === jpg, 'ensureImageBlob: correct type → same blob');
  const jpgWrong = await ensureImageBlob(new Blob([await jpg.arrayBuffer()], { type: 'text/html' }));
  ok(jpgWrong.type === 'image/jpeg', 'ensureImageBlob: JPEG labelled as HTML is still accepted');
  const t1 = await throwsAi(() => ensureImageBlob(new Blob(['Rate limit reached, try later'], { type: 'text/plain' })));
  ok(t1 instanceof AiError && t1.info.code === 'no_image' && t1.info.message === 'Rate limit reached, try later', 'plain text body → no_image with the text as the hint');
  const t2 = await throwsAi(() => ensureImageBlob(new Blob(['<html><body>blocked</body></html>'], { type: 'text/html' })));
  const t3 = await throwsAi(() => ensureImageBlob(new Blob(['{"error":"x"}'], { type: 'application/json' })));
  const t4 = await throwsAi(() => ensureImageBlob(new Blob([])));
  ok(t2.info.code === 'no_image' && t2.info.message === '' && t3.info.code === 'no_image' && t3.info.message === '' && t4.info.code === 'no_image', 'HTML / JSON / empty body → no_image without leaking markup');
}

section('providers: Cloudflare request builders / parse');
{
  const img = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
  const marked = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])], { type: 'image/png' });
  const CF = PROVIDERS.cloudflare;
  const creq = await CF.buildEdit({ model: CF_MODELS[0], prompt: '하늘을 바꿔 주세요', size: SIZES_CF[1] }, { image: img, marked });
  ok(creq.method === 'POST' && creq.path === '/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b' && /^multipart\/form-data; boundary=/.test(creq.contentType), 'edit request shape (account placeholder)');
  const fd = await new Response(creq.body, { headers: { 'content-type': creq.contentType } }).formData();
  ok(fd.get('width') === '960' && fd.get('height') === '640' && String(fd.get('prompt')).includes('하늘을 바꿔 주세요') && /Image 2/.test(String(fd.get('prompt'))), 'fields: output size = 2× input class, prompt');
  ok(fd.get('input_image_0').size === img.size && fd.get('input_image_1').size === marked.size && fd.get('input_image_0').type === 'image/png', 'input_image_0 / input_image_1');
  const bad = await throwsAi(() => CF.buildEdit({ model: '@cf/../evil', prompt: 'x', size: SIZES_CF[0] }, { image: img, marked }));
  ok(bad instanceof AiError && bad.info.status === 404, 'rejects malformed model names');
  ok(CF_MODEL_RE.test('@cf/black-forest-labs/flux-2-dev') && !CF_MODEL_RE.test('@cf/a/b/c') && !CF_MODEL_RE.test('@hf/a/b') && !CF_MODEL_RE.test('@cf/./b'), 'CF_MODEL_RE');
  ok(/Image 1/.test(instruct('x')) && /magenta/.test(instruct('x')) && instruct('y'.repeat(5000)).split('Request: ')[1].length === 1500, 'instruct text + truncation');

  const relayImg = scripted([jsonRes({ result: { image: PNG }, success: true })]);
  const edited = await CF.edit(creq, { tag: 1 }, relayImg);
  ok(edited.length === 1 && edited[0].type === 'image/png' && relayImg.calls[0].provider === 'cloudflare' && relayImg.calls[0].req === creq && relayImg.calls[0].opts.tag === 1, 'edit(): relays the request and parses the image');

  const gRelay = scripted([jsonRes({ result: { image: PNG }, success: true })]);
  const gen = await CF.generate({ model: CF_GENERATE_MODELS[0], prompt: 'a red boat' }, {}, gRelay);
  const gc = gRelay.calls[0];
  ok(gen.length === 1 && gen[0].type === 'image/png' && gc.provider === 'cloudflare' && gc.req.method === 'POST' && gc.req.path === '/accounts/{account}/ai/run/@cf/black-forest-labs/flux-1-schnell' && gc.req.contentType === 'application/json' && JSON.parse(await gc.req.body.text()).prompt === 'a red boat', 'generate(): JSON prompt only (no photo)');
  const gBad = await throwsAi(() => CF.generate({ model: 'nope', prompt: 'x' }, {}, gRelay));
  ok(gBad instanceof AiError && gBad.info.status === 404 && gRelay.calls.length === 1, 'generate(): invalid model rejected before any request');
  const longGen = scripted([jsonRes({ result: { image: PNG } })]);
  await CF.generate({ model: CF_GENERATE_MODELS[0], prompt: 'x'.repeat(5000) }, {}, longGen);
  ok(JSON.parse(await longGen.calls[0].req.body.text()).prompt.length === 2000, 'generate(): prompt capped at 2000 chars');

  const j = (o) => new Blob([JSON.stringify(o)], { type: 'application/json' });
  const a = await parseCloudflareImage(j({ result: { image: PNG }, success: true, errors: [], messages: [] }), 'application/json');
  ok(a.length === 1 && a[0].type === 'image/png' && a[0].size > 50, 'result.image base64 → PNG blob');
  const b = await parseCloudflareImage(j({ result: { images: [PNG] }, success: true }), 'application/json');
  ok(b.length === 1, 'result.images[0]');
  const raw = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])], { type: 'image/png' });
  ok((await parseCloudflareImage(raw, 'image/png'))[0] === raw, 'binary image response passes through');
  const e1 = await throwsAi(() => parseCloudflareImage(j({ success: false, errors: [{ code: 3036, message: 'you have used up your daily free allocation' }], result: null }), 'application/json'));
  ok(e1 instanceof AiError && e1.info.code === 'cf_3036' && explainError(e1.info).key === 'freequota', 'success:false → AiError that explains as free-quota');
  const e2 = await throwsAi(() => parseCloudflareImage(j({ success: true, result: {} }), 'application/json'));
  ok(e2 instanceof AiError && e2.info.code === 'no_image', 'missing image → no_image');
  const e3 = await throwsAi(() => parseCloudflareImage(new Blob(['<html>']), 'text/html'));
  ok(e3 instanceof AiError && e3.info.code === 'bad_response', 'non-JSON body → bad_response');
  const names = parseCfModels({ result: [{ name: '@cf/black-forest-labs/flux-2-dev' }, { name: '@cf/meta/llama-3' }, { name: '@cf/runwayml/stable-diffusion-v1-5-inpainting' }, { name: 'bad' }, null] });
  ok(names.join() === '@cf/black-forest-labs/flux-2-dev,@cf/runwayml/stable-diffusion-v1-5-inpainting', 'parseCfModels keeps image-edit models only', names.join());
  ok(parseCfModels(null).length === 0 && parseCfModels({}).length === 0, 'parseCfModels tolerant');
}

section('providers: Gemini (generateContent)');
{
  const G = PROVIDERS.gemini;
  const img = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
  const marked = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])], { type: 'image/png' });
  ok(GM_MODEL_RE.test('gemini-2.5-flash-image') && GM_MODEL_RE.test('gemini-3-pro-image-preview') && GM_MODELS.every((m) => GM_MODEL_RE.test(m)) && !GM_MODEL_RE.test('gpt-4') && !GM_MODEL_RE.test('gemini-../x') && !GM_MODEL_RE.test('gemini-a:generateContent') && !GM_MODEL_RE.test('gemini-'), 'GM_MODEL_RE');
  const req = await G.buildEdit({ model: GM_MODELS[0], prompt: '하늘을 바꿔 주세요', size: SIZES_FREE[0] }, { image: img, marked });
  const body = JSON.parse(await req.body.text());
  const parts = body.contents[0].parts;
  ok(req.method === 'POST' && req.path === '/models/gemini-2.5-flash-image:generateContent' && req.contentType === 'application/json', 'edit request shape');
  ok(parts.length === 3 && /Image 1/.test(parts[0].text) && /Image 2/.test(parts[0].text) && /하늘을 바꿔 주세요$/.test(parts[0].text) && parts[1].inlineData.mimeType === 'image/png' && parts[1].inlineData.data === Buffer.from(await img.arrayBuffer()).toString('base64') && parts[2].inlineData.data === Buffer.from(await marked.arrayBuffer()).toString('base64'), 'parts: instruction + original + marked copy as inlineData');
  ok(body.generationConfig.responseModalities.join() === 'TEXT,IMAGE', 'asks for an image back');
  const bad = await throwsAi(() => G.buildEdit({ model: '../evil', prompt: 'x', size: SIZES_FREE[0] }, { image: img, marked }));
  ok(bad instanceof AiError && bad.info.status === 404, 'malformed model rejected');
  const okJson = { candidates: [{ content: { parts: [{ text: 'here you go' }, { inlineData: { mimeType: 'image/png', data: PNG } }] }, finishReason: 'STOP' }] };
  const r1 = parseGeminiImage(okJson), r2 = parseGeminiImage({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'QQ==' } }] } }] });
  ok(r1.b64 === PNG && r1.type === 'image/png' && r2.b64 === 'QQ==' && r2.type === 'image/jpeg', 'parseGeminiImage: inlineData / inline_data');
  const t1 = parseGeminiImage({ candidates: [{ content: { parts: [{ text: 'I cannot edit that.' }] }, finishReason: 'STOP' }] });
  const t2 = parseGeminiImage({ promptFeedback: { blockReason: 'SAFETY' } });
  const t3 = parseGeminiImage({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] });
  ok(!t1.b64 && !t1.blocked && /cannot edit/.test(t1.reason) && !t2.b64 && t2.blocked && /SAFETY/.test(t2.reason) && t3.blocked && !parseGeminiImage(null).b64, 'text-only / blocked / empty replies carry a reason');
  const relay = scripted([jsonRes(okJson)]);
  const out = await G.edit(req, { tag: 1 }, relay);
  ok(out.length === 1 && out[0].type === 'image/png' && relay.calls[0].provider === 'gemini' && relay.calls[0].req === req && relay.calls[0].opts.tag === 1, 'edit(): relays and returns the image');
  const e1 = await throwsAi(() => G.edit(req, {}, scripted([jsonRes({ candidates: [{ content: { parts: [{ text: 'Sorry, text only.' }] } }] })])));
  const e2 = await throwsAi(() => G.edit(req, {}, scripted([jsonRes({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })])));
  const e3 = await throwsAi(() => G.edit(req, {}, scripted([{ blob: new Blob(['<html>'], { type: 'text/html' }), ctype: 'text/html' }])));
  ok(e1.info.code === 'no_image' && /text only/.test(e1.info.message) && e2.info.code === 'moderation_blocked' && explainError(e2.info).key === 'policy' && e3.info.code === 'bad_response', 'no image → no_image (reason kept) / blocked → policy / not JSON → bad_response');
  const gr = scripted([jsonRes(okJson)]);
  await G.generate({ model: GM_MODELS[0], prompt: 'a red boat', size: SIZES_FREE[1] }, {}, gr);
  const gb = JSON.parse(await gr.calls[0].req.body.text());
  ok(gb.contents[0].parts.length === 1 && gb.contents[0].parts[0].text === 'a red boat' && gb.generationConfig.imageConfig.aspectRatio === '3:2' && gr.calls[0].req.path === '/models/gemini-2.5-flash-image:generateContent', 'generate(): prompt only (no photo), landscape aspect ratio');
  const gr2 = scripted([jsonRes(okJson)]), gr3 = scripted([jsonRes(okJson)]);
  await G.generate({ model: GM_MODELS[0], prompt: 'x', size: SIZES_FREE[0] }, {}, gr2); await G.generate({ model: GM_MODELS[0], prompt: 'x', size: SIZES_FREE[2] }, {}, gr3);
  ok(!('imageConfig' in JSON.parse(await gr2.calls[0].req.body.text()).generationConfig) && JSON.parse(await gr3.calls[0].req.body.text()).generationConfig.imageConfig.aspectRatio === '2:3', 'square: no aspect field; portrait: 2:3');
  ok(parseGeminiModels({ models: [{ name: 'models/gemini-2.5-flash-image' }, { name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-3-pro-image-preview' }, null, { name: 'models/embedding-001' }] }).join() === 'gemini-2.5-flash-image,gemini-3-pro-image-preview' && parseGeminiModels(null).length === 0, 'parseGeminiModels keeps image models only');
  ok(dataUrlToBlob('data:image/png;base64,' + PNG).type === 'image/png' && dataUrlToBlob('data:text/plain,hi') === null && dataUrlToBlob('http://x') === null && dataUrlToBlob(null) === null, 'dataUrlToBlob');
  ok(/magenta/.test(instructOne('x')) && !/Image 2/.test(instructOne('x')) && instructOne('y'.repeat(5000)).split('Request: ')[1].length === 1500, 'single-image instruction');
}

section('providers: Hugging Face (FLUX.1 Fill via fal)');
{
  const H = PROVIDERS.huggingface;
  const img = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' });
  const mask = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 7, 7])], { type: 'image/png' });
  const req = await H.buildEdit({ model: HF_MODEL, prompt: '  a clear blue sky  ', size: SIZES_FREE[0] }, { image: img, mask });
  const body = JSON.parse(await req.body.text());
  ok(req.method === 'POST' && req.path === '/fal-ai/fal-ai/flux-lora-fill' && req.contentType === 'application/json', 'request shape');
  ok(body.prompt === 'a clear blue sky' && body.image_url === 'data:image/png;base64,' + Buffer.from(await img.arrayBuffer()).toString('base64') && body.mask_url === 'data:image/png;base64,' + Buffer.from(await mask.arrayBuffer()).toString('base64') && body.sync_mode === true && body.output_format === 'png', 'prompt + image + mask as data URLs, synchronous');
  ok(H.usesMask && H.maskKind === 'white' && modelProfile('huggingface', HF_MODEL).usesMask && modelProfile('huggingface', HF_MODEL).maskKind === 'white' && modelProfile('huggingface', HF_MODEL).mode === 'edit', 'uses a real (white = fill) mask');
  const relay = scripted([jsonRes({ images: [{ url: 'data:image/png;base64,' + PNG, content_type: 'image/png' }] })]);
  const out = await H.edit(req, {}, relay);
  ok(out.length === 1 && out[0].type === 'image/png' && relay.calls.length === 1 && relay.calls[0].provider === 'huggingface', 'data-URL result decoded, no extra request');
  const relay2 = scripted([jsonRes({ images: [{ url: 'https://v3.fal.media/files/a/x.png' }] }), imgRes()]);
  const phases = [];
  const out2 = await H.edit(req, { onPhase: (p) => phases.push(p) }, relay2);
  ok(out2.length === 1 && relay2.calls.length === 2 && relay2.calls[1].req.method === 'GET' && relay2.calls[1].req.url === 'https://v3.fal.media/files/a/x.png' && !relay2.calls[1].req.path && phases.join() === 'download', 'https result URL is downloaded through the relay (phase "download")');
  const relay3 = scripted([jsonRes({ image: { url: 'data:image/png;base64,' + PNG } })]);
  ok((await H.edit(req, {}, relay3)).length === 1, '{image:{url}} form accepted');
  const n1 = await throwsAi(() => H.edit(req, {}, scripted([jsonRes({ images: [] })])));
  const n2 = await throwsAi(() => H.edit(req, {}, scripted([jsonRes({ images: [{ url: 'data:text/plain;base64,aGk=' }] })])));
  const n3 = await throwsAi(() => H.edit(req, {}, scripted([{ blob: new Blob(['<html>'], { type: 'text/html' }), ctype: 'text/html' }])));
  ok(n1.info.code === 'no_image' && n2.info.code === 'no_image' && n3.info.code === 'bad_response', 'no image / non-image data / not JSON');
  const d1 = await throwsAi(() => H.edit(req, {}, scripted([jsonRes({ images: [{ url: 'https://v3.fal.media/x.png' }] }), { blob: new Blob(['<html>expired</html>'], { type: 'text/html' }), ctype: 'text/html' }])));
  ok(d1.info.code === 'no_image', 'downloaded file that is not an image → no_image');
}

section('providers: ModelScope (async task + download)');
{
  ok(MS_MODEL_RE.test('Qwen/Qwen-Image-Edit') && MS_MODEL_RE.test('Qwen/Qwen-Image-Edit-2509') && MS_MODEL_RE.test('black-forest-labs/FLUX.1-Krea-dev') && MS_MODELS.every((m) => MS_MODEL_RE.test(m)), 'MS_MODEL_RE accepts the presets');
  ok(!MS_MODEL_RE.test('') && !MS_MODEL_RE.test('Qwen') && !MS_MODEL_RE.test('a/b/c') && !MS_MODEL_RE.test('../x') && !MS_MODEL_RE.test('a/../b') && !MS_MODEL_RE.test('/b') && !MS_MODEL_RE.test('a b/c') && !MS_MODEL_RE.test('a/b?x=1'), 'MS_MODEL_RE rejects malformed names');

  const ptask = parseModelScopeTask;
  const d = ptask({ task_status: 'SUCCEED', output_images: ['ftp://x/1.png', 5, null, 'https://muse.oss-cn-hangzhou.aliyuncs.com/a.png'] });
  ok(d.state === 'done' && d.images.join() === 'https://muse.oss-cn-hangzhou.aliyuncs.com/a.png', 'SUCCEED → done, only http(s) string URLs');
  ok(ptask({ task_status: 'succeed', output_images: [] }).state === 'done' && ptask({ status: 'SUCCEEDED', output_images: ['https://a/b.png'] }).images.length === 1, 'case-insensitive; "status" fallback');
  ok(ptask({ task_status: 'FAILED', errors: { message: 'prompt blocked', code: 400 } }).message === 'prompt blocked' && ptask({ task_status: 'FAILED', errors: [{ message: 'array form' }] }).message === 'array form' && ptask({ task_status: 'FAILED', message: 'top-level' }).message === 'top-level', 'FAILED keeps the reason (object / array / top-level)');
  ok(ptask({ task_status: 'FAILED', message: 'y'.repeat(500) }).message.length === 160 && ptask({ task_status: 'CANCELED' }).state === 'failed', 'reason capped; CANCELED = failed');
  ok(['PENDING', 'RUNNING', 'PROCESSING', '', undefined].every((s) => ptask({ task_status: s }).state === 'pending') && ptask(null).state === 'pending' && ptask({}).state === 'pending' && ptask('x').state === 'pending', 'anything else = still pending');

  // 정상: 작업 만들기 → 두 번 기다림 → 성공 → 내려받기
  const TASK = 'task-0001-abcdef';
  const URL1 = 'https://muse-ai.oss-cn-hangzhou.aliyuncs.com/img/a.png?Expires=1&Signature=abc%3D';
  const phases = [], waits = [];
  const wait = async (ms) => { waits.push(ms); };
  const relay = scripted([
    jsonRes({ task_id: TASK, request_id: 'r1' }),
    jsonRes({ task_status: 'PENDING' }), jsonRes({ task_status: 'RUNNING' }),
    jsonRes({ task_status: 'SUCCEED', output_images: [URL1] }),
    imgRes(),
  ]);
  const res = await modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: '한글 프롬프트', size: SIZES_FREE[1] }, { onPhase: (p) => phases.push(p) }, relay, wait);
  const [c0, c1, c2, c3, c4] = relay.calls;
  ok(res.length === 1 && res[0].type === 'image/png' && relay.calls.length === 5, 'async flow → one PNG (type from the bytes)');
  ok(c0.provider === 'modelscope' && c0.req.method === 'POST' && c0.req.path === '/images/generations' && c0.req.contentType === 'application/json', 'submit = POST /images/generations (JSON)');
  const sub = JSON.parse(await c0.req.body.text());
  ok(sub.model === 'Qwen/Qwen-Image' && sub.prompt === '한글 프롬프트' && sub.size === '1152x768', 'submit body: model / prompt / size');
  ok([c1, c2, c3].every((c) => c.req.method === 'GET' && c.req.path === '/tasks/' + TASK && !c.req.body), 'status checks = GET /tasks/{id}');
  ok(c4.req.method === 'GET' && c4.req.url === URL1 && !c4.req.path && c4.provider === 'modelscope', 'download = GET <result url> (no path)');
  ok(waits.join() === '3000,4000,4000' && phases.join() === 'download', 'poll interval 3 s then 4 s; "download" phase reported once');

  // 동기 응답(images[0].url 이 바로 옴): 기다리지 않는다
  const w2 = [], rSync = scripted([jsonRes({ images: [{ url: URL1 }] }), imgRes()]);
  const syncOut = await modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, rSync, async (ms) => { w2.push(ms); });
  const syncBody = JSON.parse(await rSync.calls[0].req.body.text());
  ok(syncOut.length === 1 && w2.length === 0 && rSync.calls.length === 2 && rSync.calls[1].req.url === URL1 && syncBody.size === '1024x1024', 'direct result URL: no polling; default size 1024x1024');
  const rLong = scripted([jsonRes({ images: [{ url: URL1 }] }), imgRes()]);
  await modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'p'.repeat(5000) }, {}, rLong, wait);
  ok(JSON.parse(await rLong.calls[0].req.body.text()).prompt.length === 2000, 'prompt capped at 2000 chars');

  // 실패 · 이상 응답
  const tFail = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes({ task_id: TASK }), jsonRes({ task_status: 'FAILED', errors: { message: 'prompt blocked' } })]), wait));
  ok(tFail instanceof AiError && tFail.info.code === 'task_failed' && tFail.info.message === 'prompt blocked' && explainError(tFail.info).key === 'taskfail', 'FAILED → task_failed with the reason');
  for (const [name, first] of [['missing', {}], ['numeric', { task_id: 123456789 }], ['path escape', { task_id: '../evil/../x' }], ['too short', { task_id: 'abc' }], ['slash', { task_id: 'task/0001-abcdef' }]]) {
    const e = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes(first)]), wait));
    ok(e instanceof AiError && e.info.code === 'no_task', 'task id ' + name + ' → no_task');
  }
  const noImg = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes({ task_id: TASK }), jsonRes({ task_status: 'SUCCEED', output_images: [] })]), wait));
  ok(noImg instanceof AiError && noImg.info.code === 'no_image', 'SUCCEED without images → no_image');
  const notJson = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([{ blob: new Blob(['<html>'], { type: 'text/html' }), ctype: 'text/html' }]), wait));
  const notJson2 = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes({ task_id: TASK }), { blob: new Blob(['oops']), ctype: 'text/plain' }]), wait));
  ok(notJson.info.code === 'bad_response' && notJson2.info.code === 'bad_response', 'non-JSON submit / status → bad_response');
  const dl = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes({ images: [{ url: URL1 }] }), { blob: new Blob(['<html>expired</html>'], { type: 'text/html' }), ctype: 'text/html' }]), wait));
  ok(dl instanceof AiError && dl.info.code === 'no_image', 'downloaded body that is not an image → no_image');
  const never = scripted([jsonRes({ task_id: TASK })]);
  const badModel = await throwsAi(() => modelscopeGenerate({ model: '../evil', prompt: 'x' }, {}, never, wait));
  ok(badModel instanceof AiError && badModel.info.status === 404 && badModel.info.code === 'model_not_found' && never.calls.length === 0, 'invalid model name: rejected before any request');
  const native401 = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, async () => { throw new AiError({ status: 401, code: 'http_401', message: 'Invalid token' }); }, wait));
  ok(native401 instanceof AiError && native401.info.status === 401 && explainError(native401.info).key === 'key', 'native errors (401) pass through');

  // 시간 초과 · 취소
  const tmo = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, { pollTimeoutMs: 60 }, scripted([jsonRes({ task_id: TASK }), jsonRes({ task_status: 'RUNNING' })]), () => new Promise((r) => setTimeout(r, 25))));
  ok(tmo instanceof AiError && tmo.info.code === 'timeout', 'still running after pollTimeoutMs → timeout');
  const cx = await throwsAi(() => modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, scripted([jsonRes({ task_id: TASK })]), async () => { throw new AiError({ code: 'cancelled' }); }));
  ok(cx instanceof AiError && cx.info.code === 'cancelled', 'cancel while waiting');
  const ac = new AbortController(); ac.abort();
  const pre = await throwsAi(() => sleepAbortable(10000, ac.signal));
  const ac2 = new AbortController(); const mid = throwsAi(() => sleepAbortable(10000, ac2.signal)); setTimeout(() => ac2.abort(), 15);
  const t0 = Date.now(); const midErr = await mid;
  ok(pre instanceof AiError && pre.info.code === 'cancelled' && midErr instanceof AiError && midErr.info.code === 'cancelled' && Date.now() - t0 < 2000, 'sleepAbortable: pre-aborted / aborted mid-wait');
  const tt = Date.now(); await sleepAbortable(20, new AbortController().signal); await sleepAbortable(5);
  ok(Date.now() - tt >= 15, 'sleepAbortable: resolves after the delay (signal optional)');

  // 편집(Qwen-Image-Edit): 표시한 사진 1장 → image/image_url(data URI) + 작업 종류 image-to-image-generation, size 없음
  const PM = PROVIDERS.modelscope;
  const marked = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])], { type: 'image/png' });
  const ereq = await PM.buildEdit({ model: MS_MODELS[0], prompt: '하늘을 바꿔 주세요', size: SIZES_FREE[0] }, { image: new Blob(['x']), marked });
  ok(ereq.model === MS_MODELS[0] && /magenta/.test(ereq.prompt) && /하늘을 바꿔 주세요$/.test(ereq.prompt) && ereq.image === 'data:image/png;base64,' + Buffer.from(await marked.arrayBuffer()).toString('base64'), 'buildEdit: marked photo as a data URL + single-image instruction');
  const phE = [], rE = scripted([jsonRes({ task_id: TASK }), jsonRes({ task_status: 'SUCCEED', output_images: [URL1] }), imgRes()]);
  const edited = await PM.edit(ereq, { onPhase: (p) => phE.push(p) }, rE);
  const eb = JSON.parse(await rE.calls[0].req.body.text());
  ok(edited.length === 1 && edited[0].type === 'image/png' && eb.model === MS_MODELS[0] && eb.image === ereq.image && eb.image_url === ereq.image && !('size' in eb) && rE.calls[0].req.tt === MS_EDIT_TASK && rE.calls[1].req.tt === MS_EDIT_TASK && rE.calls[2].req.tt === undefined && MS_EDIT_TASK === 'image-to-image-generation', 'edit(): submit + poll carry the image-to-image task type; the download does not');
  const bm = await throwsAi(() => PM.buildEdit({ model: '../x', prompt: 'x', size: SIZES_FREE[0] }, { image: marked, marked }));
  ok(bm instanceof AiError && bm.info.status === 404, 'buildEdit rejects malformed model names');
  const rG = scripted([jsonRes({ images: [{ url: URL1 }] }), imgRes()]);
  await modelscopeGenerate({ model: 'Qwen/Qwen-Image', prompt: 'x' }, {}, rG, wait);
  ok(rG.calls[0].req.tt === undefined, 'plain generation requests carry no task type');
}

section('providers: registry / sizes / config');
{
  ok(PROVIDER_IDS.join() === 'cloudflare,modelscope,gemini,huggingface', 'provider ids: Cloudflare, ModelScope, Gemini, Hugging Face');
  ok(!('openai' in PROVIDERS) && !('openrouter' in PROVIDERS) && !('pollinations' in PROVIDERS), 'OpenAI / OpenRouter / Pollinations are gone');
  for (const id of PROVIDER_IDS) {
    const P = PROVIDERS[id];
    ok(P.id === id && P.free === true && typeof P.name() === 'string' && typeof P.tag() === 'string' && typeof P.desc() === 'string' && typeof P.howto() === 'string' && typeof P.host() === 'string' && typeof P.privacy('h') === 'string' && typeof P.privacyText('h') === 'string' && P.sizes.length === 3 && Array.isArray(P.modelPresets), 'provider interface: ' + id);
    const all = [P.name(), P.tag(), P.desc(), P.howto(), P.privacy('h'), P.privacyText('h')].join(' ');
    ok(!/openai|openrouter|gpt-image/i.test(all), 'no stale OpenAI/OpenRouter wording: ' + id);
  }
  const { cloudflare: CF, modelscope: MS, gemini: GM, huggingface: HF } = PROVIDERS;
  ok(PROVIDER_IDS.every((id) => !PROVIDERS[id].noKey && !PROVIDERS[id].genOnly), 'every provider needs a key; none is generation-only');
  ok(PROVIDER_IDS.every((id) => typeof PROVIDERS[id].buildEdit === 'function' && typeof PROVIDERS[id].edit === 'function'), 'every provider can edit');
  ok(typeof CF.generate === 'function' && typeof GM.generate === 'function' && MS.generate === undefined && HF.generate === undefined && CF.canFill && GM.canFill && !MS.canFill && !HF.canFill, 'text-to-image / "fill from prompt": Cloudflare and Gemini only');
  ok(CF.extra && CF.extra.id === 'account' && MS.extra === null && GM.extra === null && HF.extra === null, 'only Cloudflare needs an account ID');
  ok(!CF.usesMask && !MS.usesMask && !GM.usesMask && HF.usesMask && MS.oneImage && !CF.oneImage, 'only Hugging Face uses a real mask; ModelScope takes one marked photo');
  ok(CF.autoModel === CF_MODELS[0] && MS.autoModel === MS_MODELS[0] && GM.autoModel === GM_MODELS[0] && HF.autoModel === HF_MODEL && MS.modelPresets === MS_MODELS && GM.modelPresets === GM_MODELS && HF.modelPresets.length === 0, 'auto models + presets');
  ok(CF.host() === 'api.cloudflare.com' && MS.host() === 'api-inference.modelscope.cn' && GM.host() === 'generativelanguage.googleapis.com' && HF.host() === 'router.huggingface.co', 'provider hosts');
  ok(/저장·개선/.test(MS.privacy('h')) && /Google/.test(GM.privacy('h')) && /fal/.test(HF.privacy('h')) && !/저장·개선/.test(CF.privacy('h')), 'data-use warnings (trial service / Google free tier / fal via HF)');
  ok(PROVIDER_IDS.every((id) => /h/.test(PROVIDERS[id].privacyText('h'))) && /사진은 보내지 않아요/.test(CF.privacyText('h')) && /사진은 보내지 않아요/.test(GM.privacyText('h')) && /알리바바/.test(MS.privacy('h')), 'privacy notes');
  ok(getProvider('nope') === CF && getProvider(undefined) === CF && getProvider('modelscope') === MS, 'getProvider falls back to Cloudflare');

  for (const s of SIZES_FREE) ok(Math.abs(s.ar - s.w / s.h) < 1e-9 && s.str === `${s.w}x${s.h}`, 'SIZES_FREE ' + s.str);
  for (const s of SIZES_CF) ok(s.out.w === s.w * 2 && s.out.h === s.h * 2 && s.out.w <= 1024 && s.out.h <= 1024 && s.w % 16 === 0 && s.h % 16 === 0 && s.out.w % 16 === 0 && s.out.h % 16 === 0 && Math.max(s.w, s.h) < 512, 'SIZES_CF: inputs < 512, multiples of 16, output = 2×, ≤1024: ' + s.w + 'x' + s.h);
  ok(pickSize(1.45, SIZES_CF).w === 480 && pickSize(1.45, SIZES_CF).h === 320 && pickSize(0.7, SIZES_CF).h === 480 && pickSize(1, SIZES_FREE).w === 1024, 'pickSize with provider size lists');
  const pc = planRequest({ x0: 0.4, y0: 0.4, x1: 0.5, y1: 0.5 }, { w: 3000, h: 2000 }, { context: 0.4, sizes: SIZES_CF });
  ok(pc.size.out && pc.size.w <= 512 && pc.fit.w <= pc.size.w && Math.abs(pc.rect.w / pc.rect.h - pc.size.w / pc.size.h) < 0.03, 'planRequest honours provider sizes (cloudflare 512 input classes)');

  // 설정 이전 / 멱등성: 삭제된 제공자의 설정·동의는 지우고 Cloudflare 설정은 지킨다
  const app = { settings: { ai: {
    provider: 'openai', genProvider: 'openrouter', quality: 'high', n: 2, model: 'manual', custom: 'gpt-image-x', resolved: 'gpt-image-1.5', models: ['gpt-image-1.5'], consent: { base: 'https://api.openai.com/v1', ts: 1 },
    p: { openai: { model: 'manual' }, openrouter: { model: 'auto', free: [] }, cloudflare: { model: 'auto', custom: '@cf/x/y', models: ['@cf/x/y'] } },
    consents: { openai: 'https://api.openai.com/v1', 'openai:text': 'api.openai.com', openrouter: 'openrouter.ai', 'openrouter:text': 'openrouter.ai', cloudflare: 'api.cloudflare.com' },
  } } };
  const c1 = aiConfig(app);
  ok(c1 === aiConfig(app) && c1 === app.settings.ai, 'aiConfig returns the same live object');
  ok(c1.provider === 'cloudflare' && !('openai' in c1.p) && !('openrouter' in c1.p) && c1.p.cloudflare.custom === '@cf/x/y' && c1.p.cloudflare.models[0] === '@cf/x/y', 'removed providers\' settings dropped, Cloudflare settings kept');
  ok(c1.consents.cloudflare === 'api.cloudflare.com' && Object.keys(c1.consents).join() === 'cloudflare', 'removed providers\' consents dropped');
  ok(['quality', 'n', 'model', 'custom', 'resolved', 'models', 'consent', 'genProvider'].every((x) => !(x in c1)) && c1.feather === 30 && c1.tone === true && c1.translate === true && c1.ctx === 1, 'old keys removed, defaults filled');
  const keep = aiConfig({ settings: { ai: { provider: 'gemini', genProvider: 'gemini', feather: 10, tone: false } } });
  ok(keep.provider === 'gemini' && keep.genProvider === 'gemini' && keep.feather === 10 && keep.tone === false, 'valid choices survive');
  ok(aiConfig({ settings: {} }).provider === 'cloudflare' && aiConfig({ settings: { ai: { provider: 'nope' } } }).provider === 'cloudflare' && aiConfig({ settings: { ai: 5 } }).provider === 'cloudflare', 'fresh / unknown / corrupt settings → Cloudflare');
  const pcm = pcfg(c1, 'modelscope');
  ok(pcm.model === MODEL_AUTO && MODEL_AUTO === 'auto' && pcm.custom === '' && Array.isArray(pcm.models) && pcfg(c1, 'modelscope') === pcm, 'pcfg creates defaults once');
}

section('providers: model profiles / translation');
{
  const SCH = '@cf/black-forest-labs/flux-1-schnell';
  ok(isCfGenerateModel(SCH) && isCfGenerateModel('@cf/stabilityai/stable-diffusion-xl-base-1.0') && isCfGenerateModel('@cf/lykon/dreamshaper-8-lcm') && !isCfGenerateModel(CF_MODELS[0]) && !isCfGenerateModel('') && !isCfGenerateModel(null), 'isCfGenerateModel: text-to-image models only');
  ok(CF_GENERATE_MODELS[0] === SCH && PROVIDERS.cloudflare.generateModel === SCH && PROVIDERS.cloudflare.modelPresets.includes(SCH) && CF_MODELS.every((m) => !isCfGenerateModel(m)), 'schnell is the Cloudflare generation model and is selectable');
  const g = modelProfile('cloudflare', SCH);
  ok(g.mode === 'generate' && g.noPhoto === true && g.usesMask === false && g.sizes === SIZES_FREE, 'profile: Cloudflare schnell = generate, no photo');
  const e1 = modelProfile('cloudflare', CF_MODELS[0]);
  ok(e1.mode === 'edit' && !e1.noPhoto && e1.sizes === SIZES_CF && !e1.usesMask, 'profile: FLUX.2 = edit with the marked image (CF sizes)');
  const p1 = modelProfile('gemini', GM_MODELS[0], { mode: 'generate' }), m1 = modelProfile('modelscope', MS_MODELS[0]), u1 = modelProfile('nope', 'x'), g0 = modelProfile('gemini', GM_MODELS[0], { mode: 'edit' });
  ok(p1.mode === 'generate' && p1.noPhoto && p1.sizes === SIZES_FREE && g0.mode === 'edit' && !g0.noPhoto && m1.mode === 'edit' && !m1.noPhoto && m1.oneImage && !m1.usesMask, 'profile: Gemini edit/generate by mode; ModelScope = edit with one marked photo');
  ok(u1.mode === 'edit' && u1.sizes === SIZES_CF, 'profile: unknown provider → Cloudflare');
  ok(/api\.cloudflare\.com/.test(PROVIDERS.cloudflare.privacyText('api.cloudflare.com')) && /사진은 보내지 않아요/.test(PROVIDERS.cloudflare.privacyText('x')), 'text-only privacy note');

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
  const rethrown = await throwsAi(() => translateToEnglish('고양이', {}, async () => { throw new AiError({ code: 'cancelled' }); }));
  ok(rethrown instanceof AiError && rethrown.info.code === 'cancelled', 'translate: cancellation is not swallowed');
  const long = await translateToEnglish('가'.repeat(900), {}, async (p, req) => { calls.push([p, req]); return asJson({ result: { translated_text: 'x'.repeat(2000) } }); });
  const lastBody = JSON.parse(await calls.at(-1)[1].body.text());
  ok(lastBody.text.length === 500 && long.text.length === 800, 'translate: input capped at 500 chars, output at 800');
}

console.log(`\nAI unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
