// 체형 보정: 인물을 고르고(올가미/브러시), 폭(허리·팔뚝…) · 길이(다리…) · 확대/축소(눈·턱…)를 조절한다.
// 변형은 "인물 픽셀"에만 걸리고 배경은 움직이지 않는다. 인물이 줄어서 드러난 배경은 주변 배경으로 채워 넣는다(ai/bodywarp.js).
// 결과는 바뀐 부분만 불투명한 잠긴 이미지 레이어("체형 보정")로 합성돼 숨기기·삭제·실행 취소가 된다.
import { h, rafThrottle } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn, uid } from '../store.js';
import { Segmented, Slider, Btn, IconBtn, toast } from '../ui/components.js';
import * as Drafts from '../drafts.js';
import { orientedSize } from '../engine/geometry.js';
import { newMask, rasterPolygon, combine, strokeOp, invertMask, bboxOf, contourSegments, featherU8, sampleMask } from '../ai/selection.js';
import { rectToCrop, layerPlacement } from '../ai/plan.js';
import { warpSubject, amountOf } from '../ai/bodywarp.js';
import { refineMask } from '../ai/autoselect.js';

const G = 1024; // 선택 격자의 긴 변
const MAX_LONG = 1400; // 적용 때 영역을 렌더하는 긴 변
const PREV_LONG = 560; // 미리보기
const SNAP_LONG = 480; // 자동 경계 맞춤 계산 해상도(긴 변)

export function open(ed, body) {
  const lp0 = ed.logical;
  const wide = lp0.pw >= lp0.ph;
  const mw = wide ? G : Math.max(16, Math.round((G * lp0.pw) / lp0.ph));
  const mh = wide ? Math.max(16, Math.round((G * lp0.ph) / lp0.pw)) : G;
  // kind: width | height | bulge. t/b = 인물 높이 대비 위·아래 경계(0..1), v = 강도(-100..100), px/py = 확대 지점(인물 상자 비율), r = 범위(인물 큰 변 비율)
  const S = { tab: 'select', shape: 'lasso', mode: 'add', brush: 14, feather: 25, auto: true, snap: 4, kind: 'width', t: 0.4, b: 0.65, v: 0, px: 0.5, py: 0.2, r: 0.2, ops: [], busy: false };
  let closed = false, mask = newMask(mw, mh), undo = [], cur = null, cursor = null, work = null;
  let tintCv = null, tintData = null, tintAll = true, dirty = null, contour = null, contourDirty = true;
  let prep = null, previewKey = null, token = 0, snapSrc = null;

  const note = (s) => h('p', { class: 'sheet-note' }, s);
  const redraw = rafThrottle(() => { if (!closed) ed.invalidateOverlay(); });
  const invalidatePrep = () => { prep = null; clearPreview(); };
  function afterSelChange() { tintAll = true; contourDirty = true; invalidatePrep(); syncBtns(); redraw(); }
  const pushUndo = (m) => { undo.push(m); if (undo.length > 20) undo.shift(); };
  let undoBtn = null, clrBtn = null;
  function syncBtns() { if (undoBtn) undoBtn.disabled = !undo.length; if (clrBtn) clrBtn.disabled = !bboxOf(mask, mw, mh); }

  // ------------------------------------------------------------ 포인터 (인물 선택 / 확대 지점)
  const toMask = (ev) => { const lp = ed.logical; return [(ev.x / lp.pw) * mw, (ev.y / lp.ph) * mh]; };
  const brushR = () => (S.brush / 300) * Math.min(mw, mh);
  function markDirty(x0, y0, x1, y1) { x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(mw, Math.ceil(x1)); y1 = Math.min(mh, Math.ceil(y1)); if (x1 <= x0 || y1 <= y0) return; dirty = dirty ? { x0: Math.min(dirty.x0, x0), y0: Math.min(dirty.y0, y0), x1: Math.max(dirty.x1, x1), y1: Math.max(dirty.y1, y1) } : { x0, y0, x1, y1 }; }
  function brushTo(a, b2) { const r = brushR(); strokeOp(work, mw, mh, a[0], a[1], b2[0], b2[1], r, 0.7, S.mode); const pad = Math.ceil(r) + 1; markDirty(Math.min(a[0], b2[0]) - pad, Math.min(a[1], b2[1]) - pad, Math.max(a[0], b2[0]) + pad, Math.max(a[1], b2[1]) + pad); }
  const pointer = {
    down(ev) {
      if (S.busy) return false;
      const p = toMask(ev);
      if (S.tab === 'adjust') {
        if (S.kind !== 'bulge') return false;
        const bb = bboxOf(mask, mw, mh); if (!bb) return false;
        S.px = Math.max(-0.2, Math.min(1.2, (p[0] - bb.x0) / Math.max(1, bb.x1 - bb.x0)));
        S.py = Math.max(-0.2, Math.min(1.2, (p[1] - bb.y0) / Math.max(1, bb.y1 - bb.y0)));
        redraw(); schedulePreview(); return true;
      }
      cursor = [ev.sx, ev.sy];
      if (S.shape === 'brush') { work = mask.slice(); cur = { kind: 'brush', last: p }; brushTo(p, p); redraw(); return true; }
      cur = { kind: 'lasso', pts: [p[0], p[1]] };
      return true;
    },
    move(ev) {
      if (!cur) return;
      const p = toMask(ev); cursor = [ev.sx, ev.sy];
      if (cur.kind === 'brush') { brushTo(cur.last, p); cur.last = p; }
      else { const lp = ed.logical, sc = (ed.view.s * lp.pw) / mw, n = cur.pts.length; if (Math.hypot(p[0] - cur.pts[n - 2], p[1] - cur.pts[n - 1]) >= Math.max(0.6, 2 / sc)) cur.pts.push(p[0], p[1]); }
      redraw();
    },
    up() {
      if (!cur) return;
      const c = cur; cur = null; cursor = null;
      if (c.kind === 'brush') { pushUndo(mask); mask = work; work = null; afterSelChange(); return; }
      if (c.pts.length >= 6) {
        const cov = rasterPolygon(c.pts, mw, mh);
        if (S.auto) { snapLasso(cov); return; }
        pushUndo(mask); const m = mask.slice(); combine(m, cov, S.mode); mask = m;
      }
      afterSelChange();
    },
    cancel() { cur = null; cursor = null; work = null; tintAll = true; redraw(); },
  };

  // ------------------------------------------------------------ 인물 경계 자동 맞춤 (올가미 = 힌트)
  /** 편집 중인 사진을 선택 격자와 같은 비율의 작은 해상도로 렌더(도구가 열려 있는 동안 한 번만) */
  async function getSnapSrc() {
    if (snapSrc) return snapSrc;
    const doc = ed.doc(), info = ed.info, [Wo, Ho] = orientedSize(info.w, info.h, doc.geo), crop = doc.geo.crop;
    const full = { w: crop[2] * Wo, h: crop[3] * Ho };
    const region = await ed.renderRegion(rectToCrop({ x: 0, y: 0, w: full.w, h: full.h }, full, crop), SNAP_LONG);
    const k = Math.min(1, SNAP_LONG / Math.max(mw, mh)), ww = Math.max(16, Math.round(mw * k)), wh = Math.max(16, Math.round(mh * k));
    const cv = document.createElement('canvas'); cv.width = ww; cv.height = wh;
    const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(region, 0, 0, ww, wh);
    snapSrc = { ww, wh, rgba: cx.getImageData(0, 0, ww, wh).data };
    return snapSrc;
  }
  async function snapLasso(cov) {
    S.busy = true; const my = mask; let res = null;
    try {
      const sp = await getSnapSrc(); if (closed) return;
      await new Promise((r) => setTimeout(r, 0)); // 계산 중 화면이 먼저 갱신되도록
      const rough = sampleMask(cov, mw, mh, { x: 0, y: 0, w: mw, h: mh }, sp.ww, sp.wh);
      const r = refineMask(sp.rgba, sp.ww, sp.wh, rough, { band: Math.max(2, (S.snap / 100) * Math.max(sp.ww, sp.wh)) });
      if (r.ok) res = featherU8(sampleMask(r.mask, sp.ww, sp.wh, { x: 0, y: 0, w: sp.ww, h: sp.wh }, mw, mh), mw, mh, 0.8);
    } catch (e) { res = null; }
    S.busy = false; if (closed || mask !== my) return; // 닫혔거나 그 사이 선택이 바뀜
    pushUndo(mask); const m = mask.slice(); combine(m, res || cov, S.mode); mask = m;
    afterSelChange();
    toast(res ? t('인물 경계에 맞춰 선택했어요. 어긋난 곳은 브러시로 고쳐요.', 'Snapped to the person’s edge. Fix leftovers with the brush.')
      : t('경계를 찾지 못해 그린 대로 선택했어요(배경과 색이 비슷해요).', 'Could not find an edge; used your outline as drawn.'));
  }

  // ------------------------------------------------------------ 오버레이
  function flushTint(src) {
    if (!tintCv) { tintCv = document.createElement('canvas'); tintCv.width = mw; tintCv.height = mh; tintData = tintCv.getContext('2d').createImageData(mw, mh); tintAll = true; }
    let x0 = 0, y0 = 0, x1 = mw, y1 = mh;
    if (!tintAll) { if (!dirty) return; ({ x0, y0, x1, y1 } = dirty); }
    const d = tintData.data;
    for (let y = y0; y < y1; y++) for (let x = x0, i = y * mw + x0; x < x1; x++, i++) { const j = i * 4; d[j] = 79; d[j + 1] = 140; d[j + 2] = 255; d[j + 3] = (src[i] * 0.32) | 0; }
    tintCv.getContext('2d').putImageData(tintData, 0, 0, x0, y0, x1 - x0, y1 - y0);
    tintAll = false; dirty = null;
  }
  function outline(ctx, path, dashed) { ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 4; path(); ctx.stroke(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; if (dashed) ctx.setLineDash([7, 5]); path(); ctx.stroke(); ctx.restore(); }
  function drawOverlay(ctx, view) {
    const lp = ed.logical, sc = (view.s * lp.pw) / mw;
    const [ox, oy] = view.toScreen(0, 0);
    const P = (x, y) => [ox + x * sc, oy + y * sc];
    if (S.tab === 'select') {
      flushTint(work || mask);
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(tintCv, ox, oy, mw * sc, mh * sc); ctx.restore();
      if (!work) {
        if (contourDirty) { const segs = contourSegments(mask, mw, mh); const p = new Path2D(); for (let i = 0; i < segs.length; i += 4) { p.moveTo(segs[i], segs[i + 1]); p.lineTo(segs[i + 2], segs[i + 3]); } contour = p; contourDirty = false; }
        if (contour) { ctx.save(); ctx.translate(ox, oy); ctx.scale(sc, sc); ctx.lineJoin = 'round'; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 4 / sc; ctx.stroke(contour); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2 / sc; ctx.setLineDash([7 / sc, 5 / sc]); ctx.stroke(contour); ctx.restore(); }
      }
      if (cur && cur.kind === 'lasso') { const pts = cur.pts; outline(ctx, () => { ctx.beginPath(); for (let i = 0; i < pts.length; i += 2) { const [x, y] = P(pts[i], pts[i + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } }, false); }
      else if (cur && cur.kind === 'brush' && cursor) outline(ctx, () => { ctx.beginPath(); ctx.arc(cursor[0], cursor[1], Math.max(2, brushR() * sc), 0, Math.PI * 2); }, false);
      return;
    }
    // 조절 탭: 경계선(폭·길이) 또는 확대 범위(원)
    const bb = bboxOf(mask, mw, mh); if (!bb) return;
    const bw = bb.x1 - bb.x0, bh = bb.y1 - bb.y0;
    if (S.kind === 'bulge') {
      const [cx, cy] = P(bb.x0 + S.px * bw, bb.y0 + S.py * bh);
      outline(ctx, () => { ctx.beginPath(); ctx.arc(cx, cy, Math.max(4, S.r * Math.max(bw, bh) * sc * 0.5), 0, Math.PI * 2); }, true);
      outline(ctx, () => { ctx.beginPath(); ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6); }, false);
    } else {
      for (const f of [S.t, S.b]) { const y = bb.y0 + f * bh; const [x0, yy] = P(bb.x0 - bw * 0.15, y), [x1] = P(bb.x1 + bw * 0.15, y); outline(ctx, () => { ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); }, true); }
    }
  }

  // ------------------------------------------------------------ 준비(영역 렌더 · 마스크 표본) · 미리보기 · 적용
  async function ensurePrep() {
    if (prep) return prep;
    const bb = bboxOf(mask, mw, mh);
    if (!bb) return null;
    const doc = ed.doc(), info = ed.info, [Wo, Ho] = orientedSize(info.w, info.h, doc.geo), crop = doc.geo.crop;
    const full = { w: crop[2] * Wo, h: crop[3] * Ho };
    const bw = ((bb.x1 - bb.x0) / mw) * full.w, bh = ((bb.y1 - bb.y0) / mh) * full.h, m = Math.max(24, 0.22 * Math.max(bw, bh));
    const x0 = Math.max(0, (bb.x0 / mw) * full.w - m), y0 = Math.max(0, (bb.y0 / mh) * full.h - m), x1 = Math.min(full.w, (bb.x1 / mw) * full.w + m), y1 = Math.min(full.h, (bb.y1 / mh) * full.h + m);
    const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const region = await ed.renderRegion(rectToCrop(rect, full, crop), MAX_LONG);
    const rw = region.width, rh = region.height;
    const src = region.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, rw, rh).data;
    const gridRect = { x: (rect.x / full.w) * mw, y: (rect.y / full.h) * mh, w: (rect.w / full.w) * mw, h: (rect.h / full.h) * mh };
    const m0 = featherU8(sampleMask(mask, mw, mh, gridRect, rw, rh), rw, rh, Math.max(1, 0.003 * Math.max(rw, rh)) * (0.5 + S.feather / 50));
    const bR = bboxOf(m0, rw, rh) || { x0: 0, y0: 0, x1: rw, y1: rh };
    const k = Math.min(1, PREV_LONG / Math.max(rw, rh)), pw = Math.max(8, Math.round(rw * k)), ph = Math.max(8, Math.round(rh * k));
    const pc = document.createElement('canvas'); pc.width = pw; pc.height = ph; pc.getContext('2d').drawImage(region, 0, 0, pw, ph);
    const psrc = pc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, pw, ph).data;
    const pm = sampleMask(m0, rw, rh, { x: 0, y: 0, w: rw, h: rh }, pw, ph);
    prep = { rect, full, crop, Wo, Ho, rw, rh, src, m0, bR, pw, ph, psrc, pm, place: layerPlacement(rect, full, crop, Wo, Ho), gridRect };
    return prep;
  }
  /** 저장된 조절(ops) + 지금 조절 → 영역 픽셀 좌표의 변형 목록 (scale: 미리보기 배율) */
  function opsPx(P, scale) {
    const all = S.ops.concat(S.v ? [curOp()] : []);
    const { x0, y0, x1, y1 } = P.bR, bw = x1 - x0, bh = y1 - y0;
    return all.map((o) => (o.kind === 'bulge'
      ? { kind: 'bulge', cx: (x0 + o.px * bw) * scale, cy: (y0 + o.py * bh) * scale, r: Math.max(4, o.r * Math.max(bw, bh) * 0.5 * scale), amt: amountOf('bulge', o.v) }
      : { kind: o.kind, y0: (y0 + Math.min(o.t, o.b - 0.02) * bh) * scale, y1: (y0 + o.b * bh) * scale, amt: amountOf(o.kind, o.v) }));
  }
  const curOp = () => ({ kind: S.kind, t: S.t, b: S.b, v: S.v, px: S.px, py: S.py, r: S.r });
  function patchCanvas(res, w, hh) { const c = document.createElement('canvas'); c.width = w; c.height = hh; c.getContext('2d').putImageData(new ImageData(res.rgba, w, hh), 0, 0); return c; }
  function clearPreview() { if (previewKey) { ed.dropAsset(previewKey); previewKey = null; } if (ed.store.revert) ed.store.revert(); }
  function layerOf(key, P) { return { id: uid(), t: 'image', asset: key, x: P.place.x, y: P.place.y, w: P.place.w, rot: 0, opacity: 1, lock: true, fx: { kind: 'body', ops: S.ops.length + (S.v ? 1 : 0) } }; }
  const schedulePreview = rafThrottle(async () => {
    if (closed || S.tab !== 'adjust') return;
    const my = ++token, P = await ensurePrep();
    if (!P || closed || my !== token) return;
    if (!S.ops.length && !S.v) { clearPreview(); return; }
    const res = warpSubject(P.psrc, P.pw, P.ph, P.pm, opsPx(P, P.pw / P.rw));
    if (closed || my !== token) return;
    const old = previewKey;
    previewKey = ed.addCanvasAsset(patchCanvas(res, P.pw, P.ph));
    const layer = layerOf(previewKey, P);
    ed.preview((d) => setIn(d, 'layers', [...d.layers, layer]));
    if (old) ed.dropAsset(old);
  });
  async function apply() {
    if (S.busy) return;
    const P = await ensurePrep();
    if (!P || (!S.ops.length && !S.v)) { toast(t('먼저 인물을 고르고 조절해 주세요', 'Select the person and adjust first')); return; }
    S.busy = true; renderAll();
    await new Promise((r) => setTimeout(r, 30)); // "처리 중" 표시가 먼저 그려지게
    try {
      const res = warpSubject(P.src, P.rw, P.rh, P.m0, opsPx(P, 1));
      const cv = patchCanvas(res, P.rw, P.rh), key = ed.addCanvasAsset(cv);
      if (previewKey) { ed.dropAsset(previewKey); previewKey = null; }
      if (ed.store.revert) ed.store.revert();
      const layer = layerOf(key, P);
      ed.preview((d) => setIn(d, 'layers', [...d.layers, layer]));
      ed.commit(t('체형 보정', 'Body reshape'));
      try { cv.toBlob((b) => { if (b) Drafts.put('asset:' + key, b); }, 'image/png'); } catch (e) { /* 자동 복구만 못 함 */ }
      mask = newMask(mw, mh); undo = []; S.ops = []; S.v = 0; S.tab = 'select'; prep = null; ed.sel = null;
      tintAll = true; contourDirty = true;
      toast(t('체형 보정을 적용했어요. 레이어 목록에서 끄거나 지울 수 있어요.', 'Body reshape applied. You can hide or delete it from Layers.'));
    } catch (e) { console.error(e); toast(t('적용하지 못했어요', "Couldn't apply")); }
    S.busy = false; renderAll();
  }

  // ------------------------------------------------------------ UI
  function setHeader() {
    if (S.busy) { ed.setActions([]); return; }
    if (S.tab === 'select') ed.setActions([Btn(t('다음: 조절', 'Next: adjust'), 'filled', goAdjust, 'chevron-right'), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
    else ed.setActions([Btn(t('적용', 'Apply'), 'filled', apply, 'check'), IconBtn('x', t('취소', 'Cancel'), () => ed.closeTool(false))]);
  }
  function renderAll() { if (closed) return; setHeader(); renderBody(); redraw(); }
  async function goAdjust() {
    if (!bboxOf(mask, mw, mh)) { toast(t('먼저 인물을 선택해 주세요', 'Select the person first')); return; }
    S.busy = true; renderAll();
    const P = await ensurePrep();
    S.busy = false;
    if (!P || closed) { if (!closed) renderAll(); return; }
    S.tab = 'adjust'; renderAll(); schedulePreview();
  }
  function renderBody() {
    if (closed) return;
    body.replaceChildren();
    undoBtn = clrBtn = null;
    ed.setPeek(S.tab === 'select' && !S.busy);
    if (S.busy) { body.append(h('div', { class: 'ai-busy' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('처리 중', 'Working') }), h('div', { class: 'ai-phase num' }, t('처리 중…', 'Working…')))); return; }
    body.append(Segmented({ label: t('단계', 'Step'), items: [{ id: 'select', label: t('인물 선택', 'Select person') }, { id: 'adjust', label: t('조절', 'Adjust') }], value: S.tab, onChange: (v) => { if (v === 'adjust') goAdjust(); else { S.tab = 'select'; clearPreview(); renderAll(); } } }).el);
    if (S.tab === 'select') renderSelect(); else renderAdjust();
    syncBtns();
  }
  function renderSelect() {
    undoBtn = IconBtn('undo-2', t('선택 되돌리기', 'Undo selection'), () => { if (!undo.length) return; mask = undo.pop(); afterSelChange(); });
    clrBtn = IconBtn('trash-2', t('선택 해제', 'Clear selection'), () => { pushUndo(mask); mask = newMask(mw, mh); afterSelChange(); });
    body.append(Segmented({ label: t('선택 방식', 'Selection tool'), items: [{ id: 'lasso', label: t('올가미', 'Lasso') }, { id: 'brush', label: t('브러시', 'Brush') }], value: S.shape, onChange: (v) => { S.shape = v; renderBody(); } }).el,
      h('div', { class: 'row' }, Segmented({ label: t('모드', 'Mode'), items: [{ id: 'add', label: t('추가', 'Add') }, { id: 'sub', label: t('빼기', 'Subtract') }], value: S.mode, onChange: (v) => { S.mode = v; } }).el, h('div', { class: 'grow' }), undoBtn,
        IconBtn('eclipse', t('선택 반전', 'Invert selection'), () => { pushUndo(mask); mask = invertMask(mask.slice()); afterSelChange(); }), clrBtn));
    if (S.shape === 'lasso') body.append(Segmented({ label: t('경계 자동 맞춤', 'Auto edge snap'), items: [{ id: 'on', label: t('켜짐', 'On') }, { id: 'off', label: t('꺼짐', 'Off') }], value: S.auto ? 'on' : 'off', onChange: (v) => { S.auto = v === 'on'; renderBody(); } }).el);
    if (S.shape === 'lasso' && S.auto) body.append(Slider({ label: t('맞춤 범위', 'Snap range'), min: 1, max: 10, value: S.snap, def: 4, bipolar: false, onInput: (v) => { S.snap = v; } }).el);
    if (S.shape === 'brush') body.append(Slider({ label: t('브러시 크기', 'Brush size'), min: 2, max: 60, value: S.brush, def: 14, bipolar: false, onInput: (v) => { S.brush = v; } }).el);
    body.append(note(S.auto && S.shape === 'lasso' ? t('인물을 대충 빙 둘러 그리세요. 올가미 선 근처만 몸 경계에 맞춰 자동으로 다듬어요. 틀린 곳은 빼기·브러시로 고쳐요. 두 손가락으로 확대·이동할 수 있어요.', 'Draw loosely around the person; the area near your line snaps to the body edge. Fix mistakes with Subtract or the brush. Pinch to zoom and pan.') : t('보정할 인물을 따라 빙 둘러 그리세요(배경이 섞이지 않게 몸 선을 따라가요). 인물만 변형되고 배경은 그대로 있어요. 두 손가락으로 확대·이동할 수 있어요.', 'Draw around the person, following the body outline. Only the person is reshaped; the background stays put. Pinch to zoom and pan.')),
      Slider({ label: t('경계 부드럽게', 'Edge softness'), min: 0, max: 100, value: S.feather, def: 25, bipolar: false, onInput: (v) => { S.feather = v; }, onChange: () => invalidatePrep() }).el);
  }
  function renderAdjust() {
    const kinds = [{ id: 'width', label: t('폭', 'Width') }, { id: 'height', label: t('길이', 'Length') }, { id: 'bulge', label: t('확대·축소', 'Bulge') }];
    body.append(Segmented({ label: t('조절 종류', 'Adjustment'), items: kinds, value: S.kind, onChange: (v) => { S.kind = v; S.v = 0; renderBody(); redraw(); schedulePreview(); } }).el);
    const help = { width: t('흰 선 두 줄 사이(허리·팔뚝·허벅지·턱선 등)의 가로 폭을 줄이거나 늘려요.', 'Narrows or widens the part between the two white lines (waist, arm, thigh, jaw…).'),
      height: t('흰 선 두 줄 사이를 세로로 늘이거나 줄여요(다리 길이 등). 위쪽은 그대로, 아래쪽이 따라 움직여요.', 'Stretches or shortens the part between the lines (e.g. legs). The top stays; the lower part follows.'),
      bulge: t('사진을 눌러 위치를 정하고(눈·코·턱 등) 범위와 강도로 키우거나 줄여요.', 'Tap the photo to set the spot (eye, nose, chin…), then set range and strength.') };
    body.append(note(help[S.kind]));
    if (S.kind !== 'bulge') body.append(
      Slider({ label: t('위쪽 선', 'Top line'), min: 0, max: 100, value: Math.round(S.t * 100), def: 40, bipolar: false, unit: '%', onInput: (v) => { S.t = Math.min(v / 100, S.b - 0.04); redraw(); schedulePreview(); } }).el,
      Slider({ label: t('아래쪽 선', 'Bottom line'), min: 0, max: 100, value: Math.round(S.b * 100), def: 65, bipolar: false, unit: '%', onInput: (v) => { S.b = Math.max(v / 100, S.t + 0.04); redraw(); schedulePreview(); } }).el);
    else body.append(Slider({ label: t('범위', 'Range'), min: 5, max: 60, value: Math.round(S.r * 100), def: 20, bipolar: false, unit: '%', onInput: (v) => { S.r = v / 100; redraw(); schedulePreview(); } }).el);
    body.append(Slider({ label: S.kind === 'width' ? t('폭 (− 줄이기 / + 늘리기)', 'Width (− narrower / + wider)') : S.kind === 'height' ? t('길이 (− 줄이기 / + 늘이기)', 'Length (− shorter / + longer)') : t('강도 (− 줄이기 / + 키우기)', 'Strength (− shrink / + enlarge)'), min: -100, max: 100, value: S.v, def: 0, onInput: (v) => { S.v = v; schedulePreview(); } }).el,
      h('div', { class: 'row wrap' }, Btn(t('이 조절 추가', 'Add this'), 'tonal', () => { if (!S.v) { toast(t('먼저 강도를 조절해 주세요', 'Set a strength first')); return; } S.ops.push(curOp()); S.v = 0; renderBody(); redraw(); schedulePreview(); }, 'plus'),
        Btn(t('되돌리기', 'Undo'), 'outlined', () => { if (S.v) S.v = 0; else S.ops.pop(); renderBody(); schedulePreview(); }, 'undo-2')),
      note(S.ops.length ? t(`추가한 조절 ${S.ops.length}개 + 지금 조절이 함께 적용돼요.`, `${S.ops.length} saved adjustment(s) plus the current one will be applied.`) : t('여러 부분을 고치려면 하나 조절한 뒤 “이 조절 추가”를 누르고 다음 부분을 조절하세요. 마지막에 “적용”.', 'To adjust several parts, tap "Add this" after each, then Apply.')));
  }

  ed.setPeek(true);
  setHeader(); renderBody();
  return {
    pointer, drawOverlay, hideFrame: true,
    /** 테스트/디버그용 */
    selection() { return { w: mw, h: mh, mask, tab: S.tab, busy: S.busy, ops: S.ops.length, v: S.v, kind: S.kind, hasPrep: !!prep }; },
    state() { return S; },
    refresh() { if (closed) return; invalidatePrep(); renderAll(); },
    apply() { /* 도구를 나갈 때는 확정하지 않는다 — 미리보기는 close() 에서 걷어 내고, 확정은 "적용" 버튼으로만 */ },
    cancel() { /* close() 에서 정리 */ },
    close() { closed = true; token++; if (previewKey) { ed.dropAsset(previewKey); previewKey = null; } if (ed.store.revert) ed.store.revert(); },
  };
}
