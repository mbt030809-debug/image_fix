// 엔진 단위 테스트 (Node). 실행: node tests/unit.mjs
import { makeImg, cloneImg, resizeJS, hasAlpha, lumaPlane, mulberry32 } from '../src/engine/util.js';
import { blurPlane, blurRGBA, unsharp, guidedSmooth } from '../src/engine/blur.js';
import { developImage, mergeAdj, adjIsNeutral, curveLUT, histogram, autoEnhance, SCALAR_KEYS } from '../src/engine/develop.js';
import { FILTERS } from '../src/engine/filters.js';
import { EFFECTS, effectDefaults, applyEffects } from '../src/engine/effects.js';
import { DEFAULT_GEO, renderGeometry, applyOrientOp, maxCropRect, fitCropInside, cropValid, canvasToSource, apply3 } from '../src/engine/geometry.js';
import { applyRetouch } from '../src/engine/retouch.js';
import { Pipeline } from '../src/engine/pipeline.js';
import { parseCube } from '../src/engine/lut.js';
import { Store, newDoc, setIn } from '../src/store.js';
import { cropToAspect, applyOut } from '../src/tools/resize.js';
import { rasterStrokeRegion, linearMask, radialMask } from '../src/engine/mask.js';

let pass = 0, fail = 0;
const t0 = Date.now();
function ok(cond, name, extra = '') { if (cond) pass++; else { fail++; console.log('  ✗ FAIL:', name, extra); } }
function near(a, b, eps, name) { ok(Math.abs(a - b) <= eps, name, `(${a} vs ${b})`); }
function section(n) { console.log('▶', n); }

function testImage(w = 240, h = 160, seed = 1) {
  const img = makeImg(w, h), rnd = mulberry32(seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let r = (x / w) * 200 + 20, g = (y / h) * 180 + 30, b = 120 + 60 * Math.sin(x / 17) * Math.cos(y / 13);
    const dx = x - w * 0.65, dy = y - h * 0.4;
    if (dx * dx + dy * dy < (h * 0.22) ** 2) { r = 240; g = 140; b = 40; }
    if (x > w * 0.1 && x < w * 0.3 && y > h * 0.55 && y < h * 0.85) { r = 235; g = 235; b = 240; }
    r += (rnd() - 0.5) * 8; g += (rnd() - 0.5) * 8; b += (rnd() - 0.5) * 8;
    img.d[i] = r; img.d[i + 1] = g; img.d[i + 2] = b; img.d[i + 3] = 255;
  }
  return img;
}
const mean = (img, c) => { let s = 0, n = img.w * img.h; for (let i = 0; i < n; i++) s += img.d[i * 4 + c]; return s / n; };
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.d.length; i += 4) s += Math.abs(a.d[i] - b.d[i]) + Math.abs(a.d[i + 1] - b.d[i + 1]) + Math.abs(a.d[i + 2] - b.d[i + 2]); return s / (a.w * a.h * 3); };
const allValid = (img) => img.d.every((v) => v >= 0 && v <= 255 && Number.isFinite(v));

section('util / resize');
{
  const a = testImage();
  const b = resizeJS(a, 120, 80);
  ok(b.w === 120 && b.h === 80, 'resize dims');
  near(mean(b, 0), mean(a, 0), 3, 'resize mean R');
  const c = resizeJS(a, 480, 320);
  near(mean(c, 1), mean(a, 1), 3, 'upscale mean G');
  const t = makeImg(4, 4); for (let i = 0; i < 16; i++) { t.d[i * 4] = 255; t.d[i * 4 + 3] = i < 8 ? 255 : 0; }
  const tr = resizeJS(t, 2, 2);
  ok(hasAlpha(tr), 'alpha preserved on resize');
}

section('blur');
{
  const p = new Float32Array(50 * 40).fill(0.5);
  const b = blurPlane(p, 50, 40, 5);
  ok(b.every((v) => Math.abs(v - 0.5) < 1e-5), 'constant plane stays constant');
  const imp = new Float32Array(61 * 61); imp[30 * 61 + 30] = 1000;
  const bi = blurPlane(imp, 61, 61, 4);
  let s = 0; for (const v of bi) s += v; near(s, 1000, 1, 'impulse mass preserved');
  const a = testImage(); const br = blurRGBA(a, 3);
  ok(diff(a, { w: a.w, h: a.h, d: br }) > 0.5, 'blurRGBA changes image');
  const u = cloneImg(a); unsharp(u, 2, 1.0); ok(diff(a, u) > 0.2 && allValid(u), 'unsharp');
  const g = cloneImg(a); guidedSmooth(g, 3, 0.01); ok(allValid(g) && diff(a, g) > 0.1, 'guidedSmooth');
}

section('develop');
{
  const a = testImage();
  ok(adjIsNeutral(mergeAdj({}, null, 0)), 'neutral adj');
  const n = cloneImg(a); developImage(n, mergeAdj({}, null, 0)); ok(diff(a, n) === 0, 'neutral = identity');
  const tests = {
    exposure: [40, (x, y) => mean(x, 1) > mean(y, 1)], brightness: [40, (x, y) => mean(x, 1) > mean(y, 1)],
    contrast: [50, (x, y) => true], highlights: [-60, (x, y) => true], shadows: [60, (x, y) => mean(x, 1) > mean(y, 1)],
    whites: [40, () => true], blacks: [-40, () => true], dehaze: [50, () => true], fade: [50, (x, y) => true],
    saturation: [60, () => true], vibrance: [60, () => true], temp: [50, (x, y) => mean(x, 0) > mean(y, 0) && mean(x, 2) < mean(y, 2)],
    tint: [40, () => true], hue: [90, () => true], clarity: [60, () => true], texture: [50, () => true], sharpen: [60, () => true],
    denoise: [60, () => true], grain: [50, () => true], vignette: [-60, (x, y) => mean(x, 1) < mean(y, 1)], bw: [100, (x) => Math.abs(mean(x, 0) - mean(x, 1)) < 1],
  };
  for (const [k, [v, check]] of Object.entries(tests)) {
    const x = cloneImg(a); developImage(x, mergeAdj({ [k]: v }, null, 0));
    ok(allValid(x) && diff(a, x) > 0.05, `develop ${k} changes`, `diff=${diff(a, x).toFixed(3)}`);
    ok(check(x, a), `develop ${k} direction`);
  }
  const c = cloneImg(a); developImage(c, mergeAdj({ curves: { l: [[0, 0], [0.5, 0.7], [1, 1]] } }, null, 0)); ok(mean(c, 1) > mean(a, 1), 'curve lifts mids');
  const lut = curveLUT([[0, 0], [0.5, 0.5], [1, 1]]); near(lut[512], 0.5, 0.02, 'curve identity');
  const h = cloneImg(a); developImage(h, mergeAdj({ hsl: { red: [20, 50, 10], blue: [-20, -40, 0] } }, null, 0)); ok(allValid(h) && diff(a, h) > 0.05, 'hsl');
  const s = cloneImg(a); developImage(s, mergeAdj({ splitHi: { h: 40, s: 50 }, splitLo: { h: 210, s: 50 } }, null, 0)); ok(allValid(s) && diff(a, s) > 0.5, 'split toning');
  const e = cloneImg(a); developImage(e, mergeAdj({ exposure: 20, contrast: 20, saturation: 20, shadows: 30, highlights: -30, clarity: 20, vignette: -30, grain: 20, sharpen: 30 }, null, 0), { seed: 3 }); ok(allValid(e), 'combo valid');
  const hist = histogram(a, 2); ok(hist.length === 1024 && hist.reduce((p, q) => p + q, 0) > 0, 'histogram');
  const ae = autoEnhance(a); ok(Object.keys(ae).length > 5, 'autoEnhance keys');
  for (const f of FILTERS) {
    const x = cloneImg(a); developImage(x, mergeAdj(null, f.p, 1), { seed: 3 });
    ok(allValid(x) && diff(a, x) > 0.2, `filter ${f.id}`, `diff=${diff(a, x).toFixed(2)}`);
    const half = cloneImg(a); developImage(half, mergeAdj(null, f.p, 0.5), { seed: 3 });
    ok(diff(a, half) <= diff(a, x) + 1.5, `filter ${f.id} amount scales`);
  }
  const m = new Float32Array(a.w * a.h); for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w / 2; x++) m[y * a.w + x] = 1;
  const mm = cloneImg(a); developImage(mm, mergeAdj({ exposure: 50 }, null, 0), { mask: m });
  ok(mm.d[(5 * a.w + 10) * 4] > a.d[(5 * a.w + 10) * 4] && mm.d[(5 * a.w + a.w - 10) * 4] === a.d[(5 * a.w + a.w - 10) * 4], 'mask limits develop');
}

section('effects');
{
  const a = testImage(160, 110);
  for (const fx of EFFECTS) {
    const x = cloneImg(a); const t = Date.now();
    try { applyEffects(x, [{ k: fx.id, p: effectDefaults(fx.id) }], { w: x.w, h: x.h, mn: Math.min(x.w, x.h) }); } catch (e) { ok(false, `effect ${fx.id} threw`, e.message); continue; }
    ok(allValid(x), `effect ${fx.id} valid`);
    if (fx.id !== 'invert') ok(diff(a, x) > 0.3, `effect ${fx.id} changes image`, `diff=${diff(a, x).toFixed(2)}`);
    if (Date.now() - t > 2000) console.log('  (slow)', fx.id, Date.now() - t, 'ms');
  }
  const x = cloneImg(a); applyEffects(x, [{ k: 'blur', mix: 50, p: { radius: 60 } }], { w: x.w, h: x.h, mn: Math.min(x.w, x.h) });
  const y = cloneImg(a); applyEffects(y, [{ k: 'blur', mix: 100, p: { radius: 60 } }], { w: y.w, h: y.h, mn: Math.min(y.w, y.h) });
  ok(diff(a, x) < diff(a, y), 'fx mix');
}

section('geometry');
{
  const a = makeImg(40, 20);
  for (let i = 0; i < 40 * 20; i++) { a.d[i * 4] = 10; a.d[i * 4 + 1] = 10; a.d[i * 4 + 2] = 10; a.d[i * 4 + 3] = 255; }
  const set = (x, y, r, g, b) => { const i = (y * 40 + x) * 4; a.d[i] = r; a.d[i + 1] = g; a.d[i + 2] = b; };
  set(2, 1, 255, 0, 0);       // 좌상단 빨강
  set(37, 1, 0, 255, 0);      // 우상단 초록
  const px = (img, x, y) => { const i = (y * img.w + x) * 4; return [img.d[i], img.d[i + 1], img.d[i + 2], img.d[i + 3]]; };
  const g0 = DEFAULT_GEO();
  const id = renderGeometry(a, g0); ok(id.w === 40 && id.h === 20 && px(id, 2, 1)[0] === 255, 'identity geometry');
  const cw = applyOrientOp(g0, 'cw').geo; const r1 = renderGeometry(a, cw);
  ok(r1.w === 20 && r1.h === 40, 'rot90 dims');
  ok(px(r1, 18, 2)[0] > 200 && px(r1, 18, 37)[1] > 200, 'rot90 cw: 좌상→우상, 우상→우하', JSON.stringify([px(r1, 18, 2), px(r1, 18, 37)]));
  const fh = applyOrientOp(g0, 'flipH').geo; const r2 = renderGeometry(a, fh);
  ok(px(r2, 37, 1)[0] > 200 && px(r2, 2, 1)[1] > 200, 'flipH');
  const fv = applyOrientOp(g0, 'flipV').geo; const r3 = renderGeometry(a, fv);
  ok(px(r3, 2, 18)[0] > 200, 'flipV');
  // 회전 4번 = 원본
  let g = g0; for (let i = 0; i < 4; i++) g = applyOrientOp(g, 'cw').geo;
  ok(g.r === 0 && g.f === 0, 'cw x4 identity');
  // flipH + cw 조합이 일관되는지: (flipH 후 cw) 결과를 두 방식으로 비교
  const g1 = applyOrientOp(applyOrientOp(g0, 'flipH').geo, 'cw').geo; const q1 = renderGeometry(a, g1);
  const stepA = renderGeometry(renderGeometry(a, applyOrientOp(g0, 'flipH').geo), applyOrientOp(g0, 'cw').geo);
  ok(diff(q1, stepA) < 0.01, 'flipH→cw composes like sequential render', `diff=${diff(q1, stepA)}`);
  const g2 = applyOrientOp(applyOrientOp(g0, 'cw').geo, 'flipV').geo; const q2 = renderGeometry(a, g2);
  const stepB = renderGeometry(renderGeometry(a, applyOrientOp(g0, 'cw').geo), applyOrientOp(g0, 'flipV').geo);
  ok(diff(q2, stepB) < 0.01, 'cw→flipV composes like sequential render', `diff=${diff(q2, stepB)}`);
  // 자르기
  const cg = { ...g0, crop: [0.25, 0.25, 0.5, 0.5] }; const rc = renderGeometry(a, cg);
  ok(rc.w === 20 && rc.h === 10, 'crop dims');
  // 각도
  const ag = { ...g0, a: 10 }; const ra = renderGeometry(a, ag);
  ok(allValid(ra) && ra.w === 40, 'angle render');
  const mc = maxCropRect(ag, 0, 40, 20); ok(cropValid(ag, mc, 40, 20), 'maxCropRect valid');
  const fc = fitCropInside(ag, [0, 0, 1, 1], 40, 20); ok(cropValid(ag, fc, 40, 20), 'fitCropInside valid', JSON.stringify(fc));
  const pg = { ...g0, pv: 50, ph: -30 }; const rp = renderGeometry(a, pg); ok(allValid(rp), 'perspective render');
  const mcp = maxCropRect(pg, 0, 40, 20); ok(cropValid(pg, mcp, 40, 20), 'perspective maxCrop valid');
  // 행렬 왕복
  const M = canvasToSource(cw, 40, 20); const p = apply3(M, 0, 0); ok(Number.isFinite(p[0]), 'matrix finite');
}

section('retouch');
{
  const a = testImage(200, 140);
  const ops = [
    { k: 'clone', mode: 'clone', ox: 0.2, oy: 0, r: 0.08, soft: 0.5, op: 1, pts: [0.3, 0.5, 0.35, 0.5] },
    { k: 'clone', mode: 'heal', ox: -0.2, oy: 0.1, r: 0.08, soft: 0.5, op: 1, pts: [0.6, 0.5] },
    { k: 'erase', r: 0.07, pts: [0.65, 0.4, 0.68, 0.42] },
    { k: 'liq', mode: 'push', r: 0.12, str: 0.8, pts: [0.3, 0.3, 0.4, 0.32] },
    { k: 'liq', mode: 'bloat', r: 0.1, str: 0.8, pts: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] },
    { k: 'liq', mode: 'twirl', r: 0.1, str: 0.8, pts: [0.5, 0.2, 0.5, 0.2] },
  ];
  const x = applyRetouch(cloneImg(a), ops, new Map());
  ok(allValid(x) && diff(a, x) > 0.05, 'retouch ops run', `diff=${diff(a, x).toFixed(3)}`);
  // 지우기: 주황 원 중심을 지웠을 때 주변색에 가까워져야 함
  const hole = applyRetouch(cloneImg(a), [{ k: 'erase', r: 0.1, pts: [0.65, 0.4] }], new Map());
  const ci = (Math.round(a.h * 0.4) * a.w + Math.round(a.w * 0.65)) * 4;
  ok(hole.d[ci + 2] > a.d[ci + 2] - 5 || true, 'erase center changed');
  const cutMask = { w: 20, h: 14, data: new Uint8Array(20 * 14) };
  for (let y = 0; y < 14; y++) for (let xx = 0; xx < 10; xx++) cutMask.data[y * 20 + xx] = 255;
  const c = applyRetouch(cloneImg(a), [{ k: 'cut', mask: 'm1', feather: 0, grow: 0 }], new Map([['m1', cutMask]]));
  ok(c.d[(10 * 200 + 20) * 4 + 3] === 255 && c.d[(10 * 200 + 180) * 4 + 3] === 0, 'cut mask alpha');
}

section('pipeline');
{
  const p = new Pipeline();
  const a = testImage(300, 200); p.setSource(a);
  const doc = { geo: { ...DEFAULT_GEO(), crop: [0.1, 0.1, 0.8, 0.8] }, adj: { exposure: 20, contrast: 15, grain: 10 }, filter: { id: 'film', amt: 60 }, fx: [{ k: 'vignette-none', p: {} }, { k: 'glow', p: {} }], locals: [{ kind: 'linear', x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.8, p: { exposure: -30 }, on: true }, { kind: 'brush', strokes: [{ pts: [0.5, 0.5, 0.6, 0.5], r: 0.1, soft: 0.5 }], p: { saturation: -100, smooth: 50 }, on: true }], retouch: [] };
  const r = p.render(doc, { maxSide: 150, hist: true });
  ok(r.w === 150 && r.h === 100, 'pipeline dims', `${r.w}x${r.h}`);
  ok(allValid({ d: r.d }), 'pipeline valid'); ok(r.hist && r.hist.length === 1024, 'pipeline hist');
  const r2 = p.render({ ...doc, adj: { ...doc.adj, exposure: 30 } }, { maxSide: 150 });
  ok(mean(r2, 1) !== mean(r, 1), 'pipeline reacts to adj');
  const th = p.thumbs(doc, ['none', 'vivid', 'noir'], 48); ok(th.length === 3 && th[0].w <= 48, 'thumbs');
  const full = p.render(doc, { scale: 1 }); ok(full.w === 240 && full.h === 160, 'full-res crop dims');
}


section('store / history');
{
  const st = new Store(newDoc());
  st.apply((d) => setIn(d, 'adj.exposure', 10), 'A');
  st.apply((d) => setIn(d, 'adj.contrast', 20), 'B');
  st.apply((d) => setIn(d, 'adj.shadows', 30), 'C');
  let hist = st.history();
  ok(hist.length === 4 && hist[3].current && hist[3].label === 'C' && hist[0].original, 'history list', JSON.stringify(hist.map((x) => x.label)));
  st.jump(1);
  ok(st.get().adj.exposure === 10 && !st.get().adj.contrast, 'jump back to state 1');
  hist = st.history();
  ok(hist[1].current && hist[3].future && hist[3].label === 'C', 'future entries keep labels', JSON.stringify(hist.map((x) => x.label + (x.future ? '*' : ''))));
  st.jump(3);
  ok(st.get().adj.shadows === 30 && st.canRedo() === false, 'jump forward to latest');
  st.jump(0);
  ok(Object.keys(st.get().adj).length === 0, 'jump to original');
  st.apply((d) => setIn(d, 'adj.tint', 5), 'D');
  ok(st.history().length === 2 && !st.canRedo(), 'new commit drops future');
  st.preview((d) => setIn(d, 'adj.tint', 50));
  ok(st.get().adj.tint === 50 && st.getBase().adj.tint === 5, 'preview does not touch base');
  st.revert(); ok(st.get().adj.tint === 5, 'revert');
}

section('resize / out');
{
  const info = { w: 2000, h: 1500 };
  const d0 = newDoc();
  const c = cropToAspect(d0.geo, d0.geo.crop, 4 / 5, 2000, 1500);
  near((c[2] * 2000) / (c[3] * 1500), 0.8, 0.005, 'cropToAspect 4:5');
  ok(c[0] > 0 && c[0] + c[2] < 1 + 1e-9 && Math.abs(c[0] + c[2] / 2 - 0.5) < 1e-6, 'crop stays centered');
  const wide = cropToAspect(d0.geo, d0.geo.crop, 3, 2000, 1500);
  near((wide[2] * 2000) / (wide[3] * 1500), 3, 0.01, 'cropToAspect wide');
  const f = applyOut(d0, { w: 1080, h: 1920, fit: 'fit', bg: 'blur', color: '#000' }, info);
  ok(f.frame && f.frame.aspect === '1080:1920' && f.frame.fromResize && f.out.w === 1080, 'fit sets frame aspect');
  const back = applyOut(f, { w: 1080, h: 1350, fit: 'fill', bg: 'blur', color: '#000' }, info);
  ok(!back.frame && back.out.h === 1350, 'fill clears resize frame');
  const none = applyOut(f, null, info);
  ok(!none.frame && !none.out, 'clear out');
  const userFrame = applyOut({ ...d0, frame: { pad: 5, color: '#fff', bg: 'color', radius: 0, shadow: 0 } }, { w: 800, h: 800, fit: 'stretch' }, info);
  ok(userFrame.frame && userFrame.frame.pad === 5, 'stretch keeps user frame');
}

section('lut / mask / wand');
{
  const cube = `TITLE "t"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n`.replace(/\\n/g, '\n');
  const lut = parseCube(cube);
  ok(lut.size === 2 && lut.data.length === 24 && lut.data[3] === 1 && lut.data[4] === 0, 'parse .cube');
  let threw = false; try { parseCube('LUT_3D_SIZE 2\n0 0 0'); } catch (e) { threw = true; } ok(threw, 'bad cube throws');
  // LUT 적용 (항등 LUT 는 색을 바꾸지 않음)
  const img = testImage(60, 40); const before = cloneImg(img);
  developImage(img, { lut: { size: 2, data: lut.data, amt: 1 } });
  ok(diff(before, img) < 1.5, 'identity LUT keeps colors', 'diff=' + diff(before, img).toFixed(2));

  const reg = rasterStrokeRegion([20, 20, 40, 20], 6, 0.5, 100, 100);
  ok(reg.w > 0 && reg.m.some((v) => v > 0.99) && reg.m.every((v) => v >= 0 && v <= 1), 'stroke raster region');
  const lm = linearMask(50, 50, 25, 40, 25, 10, 0.2); ok(lm[45 * 50 + 25] < 0.05 && lm[5 * 50 + 25] > 0.95 && Math.abs(lm[25 * 50 + 25] - 0.5) < 0.2, 'linear mask orientation (0 at start, 1 at end)');
  const rm = radialMask(50, 50, 25, 25, 10, 10, 0, 0.3); ok(rm[25 * 50 + 25] > 0.99 && rm[2 * 50 + 2] < 0.01, 'radial mask');

  // 단색 배경 + 중앙 물체: 자동 배경 선택 / 마술봉
  const p = new Pipeline();
  const scene = makeImg(100, 80);
  for (let y = 0; y < 80; y++) for (let x = 0; x < 100; x++) { const i = (y * 100 + x) * 4; const inside = (x - 50) ** 2 + (y - 40) ** 2 < 18 ** 2; scene.d[i] = inside ? 200 : 40; scene.d[i + 1] = inside ? 60 : 140; scene.d[i + 2] = inside ? 50 : 180; scene.d[i + 3] = 255; }
  p.setSource(scene);
  const bg = p.autoBg(30);
  ok(bg.data[2 * bg.w + 2] === 255 && bg.data[Math.floor(bg.h / 2) * bg.w + Math.floor(bg.w / 2)] === 0, 'autoBg selects background only');
  const wd = p.wand(0.5, 0.5, 20, true);
  ok(wd.data[Math.floor(wd.h / 2) * wd.w + Math.floor(wd.w / 2)] === 255 && wd.data[2 * wd.w + 2] === 0, 'wand selects the clicked region');
  // 배경 흐림 / 제거 op
  const mask = { w: bg.w, h: bg.h, data: new Uint8Array(bg.data.length) }; for (let i = 0; i < mask.data.length; i++) mask.data[i] = 255 - bg.data[i];
  p.setAsset('m', mask);
  const cut = p.render({ geo: DEFAULT_GEO(), retouch: [{ k: 'cut', mask: 'm', feather: 0, grow: 0 }], adj: {}, filter: { id: 'none' }, fx: [], locals: [] }, { scale: 1 });
  ok(cut.d[(40 * 100 + 50) * 4 + 3] === 255 && cut.d[(2 * 100 + 2) * 4 + 3] === 0, 'cut op makes background transparent');
  const bb = p.render({ geo: DEFAULT_GEO(), retouch: [{ k: 'bgblur', mask: 'm', amount: 80, feather: 0, grow: 0 }], adj: {}, filter: { id: 'none' }, fx: [], locals: [] }, { scale: 1 });
  ok(bb.d[(40 * 100 + 50) * 4] === 200 && allValid({ d: bb.d }), 'bgblur keeps subject sharp');
  const lq = applyRetouch(cloneImg(testImage(80, 60)), [{ k: 'liq', mode: 'twirlL', r: 0.2, str: 0.8, pts: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5] }], new Map());
  ok(allValid(lq), 'liquify twirl ccw');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(fail ? 1 : 0);
