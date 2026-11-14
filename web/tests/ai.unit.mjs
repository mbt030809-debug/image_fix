// AI 수정(영역 선택 · 요청 계획 · OpenAI 요청/오류) 순수 로직 단위 테스트. 실행: node web/tests/ai.unit.mjs
import {
  newMask, rasterPolygon, rectPts, ellipsePts, combine, stampOp, strokeOp, invertMask, bboxOf, coverage,
  growMask, featherU8, sampleMask, contourSegments,
} from '../src/ai/selection.js';
import {
  SIZES, pickSize, planRequest, layerPlacement, rectToCrop, placeInCanvas, apiMaskRGBA, toneOffsets, buildPatch, featherSigma,
} from '../src/ai/plan.js';
import { pickBestImageModel, listImageModels, wrapPrompt, buildMultipart, buildEditRequest, explainError, cleanKey } from '../src/ai/openai.js';

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

console.log(`\nAI unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
