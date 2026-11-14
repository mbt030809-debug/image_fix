// 자르기·회전: 비율 프리셋, 핸들 드래그, 90° 회전/뒤집기, 수평 보정(각도), 원근
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { Chips, Slider, IconBtn, Btn } from '../ui/components.js';
import { applyOrientOp, orientedSize, maxCropRect, fitCropInside, cropValid, MAP, mapForAngleChange } from '../engine/geometry.js';

const ASPECTS = [
  ['free', '자유', 'Free', 0], ['orig', '원본', 'Original', -1], ['1:1', '1:1', '1:1', 1], ['4:5', '4:5', '4:5', 4 / 5], ['5:4', '5:4', '5:4', 5 / 4],
  ['3:4', '3:4', '3:4', 3 / 4], ['4:3', '4:3', '4:3', 4 / 3], ['2:3', '2:3', '2:3', 2 / 3], ['3:2', '3:2', '3:2', 3 / 2], ['9:16', '9:16', '9:16', 9 / 16], ['16:9', '16:9', '16:9', 16 / 9], ['21:9', '21:9', '21:9', 21 / 9],
];

/** 캔버스 정규화 좌표 매핑을 문서(레이어/로컬)에 적용 */
export function mapDocCoords(doc, fn, dRot = 0, swapXY = false) {
  const mp = (arr) => { const o = arr.slice(); for (let i = 0; i + 1 < o.length; i += 2) { const q = fn(o[i], o[i + 1]); o[i] = q[0]; o[i + 1] = q[1]; } return o; };
  const layers = doc.layers.map((L) => {
    if (L.t === 'draw') return { ...L, strokes: L.strokes.map((s) => ({ ...s, pts: mp(s.pts) })) };
    const [x, y] = fn(L.x, L.y);
    return { ...L, x, y, rot: (L.rot || 0) + dRot };
  });
  const locals = doc.locals.map((L) => {
    const o = { ...L };
    if (L.kind === 'brush') o.strokes = (L.strokes || []).map((s) => ({ ...s, pts: mp(s.pts) }));
    else if (L.kind === 'linear') { const a = fn(L.x1, L.y1), b = fn(L.x2, L.y2); o.x1 = a[0]; o.y1 = a[1]; o.x2 = b[0]; o.y2 = b[1]; }
    else if (L.kind === 'radial') { const c = fn(L.cx, L.cy); o.cx = c[0]; o.cy = c[1]; o.rot = (L.rot || 0) + dRot; if (swapXY) { o.rx = L.ry; o.ry = L.rx; } }
    return o;
  });
  return { ...doc, layers, locals };
}

export function open(ed, body) {
  const info = ed.info;
  const doc0 = ed.doc();
  let geo = { ...doc0.geo, crop: doc0.geo.crop.slice() };
  let crop = geo.crop.slice();
  let aspectKey = 'free';
  const ops = [];
  let angleBase = geo.a || 0;
  let drag = null;
  let showGrid = ed.app.settings.grid !== false;

  ed.cropOverride = [0, 0, 1, 1];
  const baseDoc = ed.store.getBase();

  const dims = () => orientedSize(info.w, info.h, geo);
  const aspectVal = () => {
    const a = ASPECTS.find((x) => x[0] === aspectKey);
    if (!a || a[3] === 0) return 0;
    if (a[3] === -1) { const [W, H] = dims(); return W / H; }
    return a[3];
  };

  function pushGeo() {
    ed.preview((d) => setIn(d, 'geo', { ...geo, crop: [0, 0, 1, 1] }));
  }
  function flushAngle() {
    if ((geo.a || 0) !== angleBase) { ops.push({ a: (geo.a || 0) - angleBase }); angleBase = geo.a || 0; }
  }

  // ---- 패널 ----------------------------------------------------------
  const chips = Chips({ label: t('비율', 'Aspect ratio'), items: ASPECTS.map(([id, ko, en]) => ({ id, label: t(ko, en) })), value: 'free', onSelect: (id) => {
    aspectKey = id;
    const a = aspectVal();
    if (a) { crop = maxCropRect(geo, a, info.w, info.h); }
    ed.invalidateOverlay();
  } });

  const rotL = IconBtn('rotate-ccw', t('왼쪽으로 90° 회전', 'Rotate left 90°'), () => orient('ccw'));
  const rotR = IconBtn('rotate-cw', t('오른쪽으로 90° 회전', 'Rotate right 90°'), () => orient('cw'));
  const flipH = IconBtn('flip-horizontal', t('좌우 뒤집기', 'Flip horizontal'), () => orient('flipH'));
  const flipV = IconBtn('flip-vertical', t('상하 뒤집기', 'Flip vertical'), () => orient('flipV'));

  const angleS = Slider({ label: t('수평 보정', 'Straighten'), min: -45, max: 45, step: 0.5, value: geo.a || 0, def: 0, unit: '°', onInput: (v) => { geo.a = v; refit(); pushGeo(); }, onChange: () => { flushAngle(); } });
  const vS = Slider({ label: t('수직 원근', 'Vertical perspective'), min: -100, max: 100, value: geo.pv || 0, def: 0, onInput: (v) => { geo.pv = v; refit(); pushGeo(); }, onChange: () => {} });
  const hS = Slider({ label: t('수평 원근', 'Horizontal perspective'), min: -100, max: 100, value: geo.ph || 0, def: 0, onInput: (v) => { geo.ph = v; refit(); pushGeo(); }, onChange: () => {} });

  function refit() {
    crop = fitCropInside(geo, crop, info.w, info.h);
    const a = aspectVal();
    if (a) { /* 비율 유지: 원근/각도 변경 시 다시 최대 */ crop = maxCropRect(geo, a, info.w, info.h); }
    ed.invalidateOverlay();
  }
  function orient(op) {
    flushAngle();
    const r = applyOrientOp({ ...geo, crop }, op);
    geo = r.geo; crop = geo.crop.slice();
    ops.push({ op });
    angleBase = geo.a || 0;
    angleS.set(geo.a || 0); vS.set(geo.pv || 0); hS.set(geo.ph || 0);
    if (aspectKey === 'orig') crop = maxCropRect(geo, aspectVal(), info.w, info.h);
    pushGeo();
    ed.invalidateOverlay();
    ed.announce(t('회전/뒤집기', 'Rotated or flipped'));
  }

  const resetBtn = Btn(t('초기화', 'Reset'), 'text', () => {
    geo = { r: 0, f: 0, a: 0, pv: 0, ph: 0, crop: [0, 0, 1, 1] }; crop = [0, 0, 1, 1]; ops.length = 0; angleBase = 0; aspectKey = 'free'; chips.set('free');
    angleS.set(0); vS.set(0); hS.set(0);
    ed.preview((d) => ({ ...setIn(d, 'geo', { ...geo }), layers: baseDoc.layers, locals: baseDoc.locals }));
    ed.invalidateOverlay();
  });
  const cancelBtn = IconBtn('x', t('취소', 'Cancel'), () => ed.closeTool(false));
  const okBtn = IconBtn('check', t('적용', 'Apply'), () => ed.closeTool(true), 'tint');
  ed.setActions([resetBtn, cancelBtn, okBtn]);
  ed.setPeek(true);

  const gridSw = h('label', { class: 'sr-only' });
  const viewMode = { v: 'main' };
  const lowerGroup = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const row = h('div', { class: 'row wrap', style: { gap: '0' } }, rotL, rotR, flipH, flipV, h('div', { class: 'grow' }));
  body.append(chips.el, row, angleS.el);
  const extra = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, vS.el, hS.el);
  extra.hidden = true;
  body.append(extra);
  void gridSw; void viewMode; void lowerGroup;

  pushGeo();
  crop = fitCropInside(geo, crop, info.w, info.h);

  // ---- 오버레이 / 포인터 -----------------------------------------------
  const MINN = 0.04;
  const toNorm = (ev) => { const f = ed.frameInfo(); const g = ed.geom(); const [x, y] = g.inv(ev.x - f.x, ev.y - f.y); return [x, y]; };
  const rectScreen = () => {
    const [x0, y0] = ed.view.toScreen(...ed.canvasToContent(crop[0], crop[1]));
    const [x1, y1] = ed.view.toScreen(...ed.canvasToContent(crop[0] + crop[2], crop[1] + crop[3]));
    return [x0, y0, x1, y1];
  };
  const HIT = 28;
  function hitTest(sx, sy) {
    const [x0, y0, x1, y1] = rectScreen();
    const near = (a, b) => Math.abs(a - b) <= HIT;
    const w = x1 - x0, hh = y1 - y0;
    const inX = sx > x0 - HIT && sx < x1 + HIT, inY = sy > y0 - HIT && sy < y1 + HIT;
    if (!inX || !inY) return null;
    const small = w < 144 || hh < 144;
    if (near(sx, x0) && near(sy, y0)) return 'tl';
    if (near(sx, x1) && near(sy, y0)) return 'tr';
    if (near(sx, x0) && near(sy, y1)) return 'bl';
    if (near(sx, x1) && near(sy, y1)) return 'br';
    if (!small) {
      if (near(sy, y0) && sx > x0 && sx < x1) return 't';
      if (near(sy, y1) && sx > x0 && sx < x1) return 'b';
      if (near(sx, x0) && sy > y0 && sy < y1) return 'l';
      if (near(sx, x1) && sy > y0 && sy < y1) return 'r';
    }
    if (sx > x0 && sx < x1 && sy > y0 && sy < y1) return 'move';
    return null;
  }
  function clampValid(oldR, newR) {
    if (cropValid(geo, newR, info.w, info.h)) return newR;
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) {
      const m = (lo + hi) / 2;
      const r = oldR.map((v, k) => v + (newR[k] - v) * m);
      if (cropValid(geo, r, info.w, info.h)) lo = m; else hi = m;
    }
    return oldR.map((v, k) => v + (newR[k] - v) * lo);
  }
  function resize(mode, start, px, py) {
    const [Wo, Ho] = dims();
    const a = aspectVal();
    const ratio = a ? (a * Ho) / Wo : 0; // 정규화 w/h
    let [x, y, w, hh] = start;
    let r = [x, y, w, hh];
    const L = x, T = y, R = x + w, B = y + hh;
    if (mode === 'tl' || mode === 'tr' || mode === 'bl' || mode === 'br') {
      const fx = mode[1] === 'l' ? R : L, fy = mode[0] === 't' ? B : T; // 고정 모서리
      let nw = Math.max(MINN, Math.abs(px - fx)), nh = Math.max(MINN, Math.abs(py - fy));
      if (ratio) { if (nw / nh > ratio) nw = nh * ratio; else nh = nw / ratio; }
      const nx = mode[1] === 'l' ? fx - nw : fx, ny = mode[0] === 't' ? fy - nh : fy;
      r = [nx, ny, nw, nh];
    } else {
      let nl = L, nt = T, nr = R, nb = B;
      if (mode === 'l') nl = Math.min(px, R - MINN); if (mode === 'r') nr = Math.max(px, L + MINN);
      if (mode === 't') nt = Math.min(py, B - MINN); if (mode === 'b') nb = Math.max(py, T + MINN);
      r = [nl, nt, nr - nl, nb - nt];
      if (ratio) {
        if (mode === 'l' || mode === 'r') { const nh = r[2] / ratio; r[1] = T + hh / 2 - nh / 2; r[3] = nh; }
        else { const nw = r[3] * ratio; r[0] = L + w / 2 - nw / 2; r[2] = nw; }
      }
    }
    // 캔버스 범위 내로
    if (r[0] < 0) { if (ratio) { const k = (r[0] + r[2]) / r[2]; r = [0, r[1], r[2] * k, r[3] * k]; } else { r[2] += r[0]; r[0] = 0; } }
    if (r[1] < 0) { if (ratio) { const k = (r[1] + r[3]) / r[3]; r = [r[0], 0, r[2] * k, r[3] * k]; } else { r[3] += r[1]; r[1] = 0; } }
    if (r[0] + r[2] > 1) { if (ratio) { const k = (1 - r[0]) / r[2]; r = [r[0], r[1], r[2] * k, r[3] * k]; } else r[2] = 1 - r[0]; }
    if (r[1] + r[3] > 1) { if (ratio) { const k = (1 - r[1]) / r[3]; r = [r[0], r[1], r[2] * k, r[3] * k]; } else r[3] = 1 - r[1]; }
    return r;
  }

  const pointer = {
    down(ev) {
      const m = hitTest(ev.sx, ev.sy);
      if (!m) return false;
      const [nx, ny] = toNorm(ev);
      drag = { mode: m, start: crop.slice(), nx, ny, last: crop.slice() };
      ed.invalidateOverlay();
      return true;
    },
    move(ev) {
      if (!drag) return;
      const [nx, ny] = toNorm(ev);
      let r;
      if (drag.mode === 'move') {
        const dx = nx - drag.nx, dy = ny - drag.ny, s = drag.start;
        r = [Math.min(1 - s[2], Math.max(0, s[0] + dx)), Math.min(1 - s[3], Math.max(0, s[1] + dy)), s[2], s[3]];
      } else r = resize(drag.mode, drag.start, nx, ny);
      crop = clampValid(drag.last, r);
      drag.last = crop.slice();
      ed.invalidateOverlay();
    },
    up() { drag = null; ed.invalidateOverlay(); },
    cancel() { drag = null; ed.invalidateOverlay(); },
  };

  function drawOverlay(ctx, view) {
    const [x0, y0, x1, y1] = rectScreen();
    const w = view.sw, hh = view.sh;
    // 바깥 어둡게
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill('evenodd');
    // 격자
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(x0 + ((x1 - x0) * i) / 3, y0); ctx.lineTo(x0 + ((x1 - x0) * i) / 3, y1);
        ctx.moveTo(x0, y0 + ((y1 - y0) * i) / 3); ctx.lineTo(x1, y0 + ((y1 - y0) * i) / 3);
      }
      ctx.stroke();
    }
    // 테두리
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 2;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    // 모서리 브래킷
    ctx.lineWidth = 3; ctx.lineCap = 'square';
    const L = Math.min(24, (x1 - x0) / 3, (y1 - y0) / 3);
    const br = (x, y, dx, dy) => { ctx.beginPath(); ctx.moveTo(x + dx * L, y); ctx.lineTo(x, y); ctx.lineTo(x, y + dy * L); ctx.stroke(); };
    ctx.strokeStyle = '#fff';
    br(x0, y0, 1, 1); br(x1, y0, -1, 1); br(x0, y1, 1, -1); br(x1, y1, -1, -1);
    // 변 핸들
    if (x1 - x0 >= 144 && y1 - y0 >= 144) {
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, S = 12;
      ctx.beginPath();
      ctx.moveTo(mx - S, y0); ctx.lineTo(mx + S, y0); ctx.moveTo(mx - S, y1); ctx.lineTo(mx + S, y1);
      ctx.moveTo(x0, my - S); ctx.lineTo(x0, my + S); ctx.moveTo(x1, my - S); ctx.lineTo(x1, my + S);
      ctx.stroke();
    }
    ctx.shadowBlur = 0;
    // 크기 표시
    const [Wo, Ho] = dims();
    const label = `${Math.round(crop[2] * Wo)} × ${Math.round(crop[3] * Ho)}`;
    ctx.font = '500 12px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(label).width + 16;
    ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect((x0 + x1) / 2 - tw / 2, y0 - 26 < 4 ? y0 + 8 : y0 - 26, tw, 20, 10) : ctx.rect((x0 + x1) / 2 - tw / 2, y0 - 26 < 4 ? y0 + 8 : y0 - 26, tw, 20); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(label, (x0 + x1) / 2, (y0 - 26 < 4 ? y0 + 8 : y0 - 26) + 10);
  }

  function applyCrop() {
    flushAngle();
    // 레이어/로컬 좌표를 회전·뒤집기·각도 변화에 맞춰 이동
    let d = baseDoc;
    let curGeo = { ...doc0.geo };
    for (const o of ops) {
      if (o.op) {
        const [Wo0, Ho0] = orientedSize(info.w, info.h, curGeo);
        void Wo0; void Ho0;
        d = mapDocCoords(d, MAP[o.op], o.op === 'cw' ? 90 : o.op === 'ccw' ? -90 : 0, o.op === 'cw' || o.op === 'ccw');
        curGeo = applyOrientOp(curGeo, o.op).geo;
      } else if (o.a) {
        const [Wo, Ho] = orientedSize(info.w, info.h, curGeo);
        d = mapDocCoords(d, mapForAngleChange(o.a, Wo, Ho), o.a);
        curGeo = { ...curGeo, a: (curGeo.a || 0) + o.a };
      }
    }
    const finalGeo = { ...geo, crop: crop.map((v) => Math.round(v * 1e5) / 1e5) };
    const same = JSON.stringify(finalGeo) === JSON.stringify(doc0.geo);
    if (same) { ed.store.revert(); return; }
    ed.cropOverride = null;
    ed.apply(() => ({ ...d, geo: finalGeo }), t('자르기', 'Crop'));
  }

  return {
    pointer,
    drawOverlay,
    hideLayers: true,
    hideFrame: true,
    apply: applyCrop,
    cancel() { ed.store.revert(); },
    close() { ed.cropOverride = null; },
    onPeek(peek) { extra.hidden = peek; },
    refresh() {},
    toggleGrid() { showGrid = !showGrid; ed.app.settings.grid = showGrid; ed.app.saveSettings(); ed.invalidateOverlay(); },
  };
}
