// 자르기·회전: 비율 프리셋, 핸들 드래그, 90° 회전/뒤집기, 수평 보정(각도), 원근
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { Chips, Slider, IconBtn, Btn } from '../ui/components.js';
import { applyOrientOp, orientedSize, maxCropRect, fitCropInside, cropValid, MAP, mapForAngleChange } from '../engine/geometry.js';

const ASPECTS = [
  ['free', '자유', 'Free', 0], ['orig', '원본', 'Original', -1], ['passport', '여권 3.5×4.5', 'Passport 35×45', 35 / 45], ['1:1', '1:1', '1:1', 1], ['4:5', '4:5', '4:5', 4 / 5], ['5:4', '5:4', '5:4', 5 / 4],
  ['3:4', '3:4', '3:4', 3 / 4], ['4:3', '4:3', '4:3', 4 / 3], ['2:3', '2:3', '2:3', 2 / 3], ['3:2', '3:2', '3:2', 3 / 2], ['9:16', '9:16', '9:16', 9 / 16], ['16:9', '16:9', '16:9', 16 / 9], ['21:9', '21:9', '21:9', 21 / 9],
];

/**
 * 규격 사진 가이드(참고용). 여권: 가로 3.5×세로 4.5cm, 얼굴 길이(정수리~턱) 3.2~3.6cm = 사진 높이의 71~80%
 * (ICAO 기준을 따르는 외교부 여권사진 규격, 지자체 여권 안내문 기준). 정수리 위 여백 3mm 는 일반적인 배치를 보여 주는 참고값이다.
 * 정수리를 topMm 선에 맞추면 턱 끝이 [topMm+faceMin, topMm+faceMax] 띠 안에 들어와야 한다.
 */
export const GUIDES = {
  passport: {
    wmm: 35, hmm: 45, faceMin: 32, faceMax: 36, topMm: 3,
    short: () => t('정수리를 위 선에, 턱 끝을 초록 띠에 맞춰요', 'Crown on the top line, chin inside the green band'),
    long: () => t('여권 규격 기준이에요: 가로 3.5×세로 4.5cm, 얼굴 길이(정수리~턱) 3.2~3.6cm = 사진 높이의 71~80%, 흰 배경 정면. 정수리 선 위치는 참고용이에요. 주민등록증·운전면허 사진도 3.5×4.5cm지만 제출처의 최신 규정을 꼭 확인해 주세요.',
      'Passport spec: 35×45 mm, crown to chin 32–36 mm = 71–80% of the photo height, white background, frontal. The crown line position is a reference. ID card and driver licence photos are also 35×45 mm — always check the latest rules of where you submit.'),
  },
};

/** 가이드 선 위치(자르기 사각형 화면 좌표 기준): 정수리 선, 턱 끝 허용 띠(min~max), 얼굴 타원 */
export function guideLayout(G, x0, y0, x1, y1) {
  const w = x1 - x0, hh = y1 - y0, f = (mm) => y0 + (hh * mm) / G.hmm;
  const yTop = f(G.topMm), yMin = f(G.topMm + G.faceMin), yMax = f(G.topMm + G.faceMax), yMid = (yMin + yMax) / 2;
  return { x0, y0, x1, y1, w, h: hh, cx: (x0 + x1) / 2, yTop, yMin, yMax, yMid, ell: { cx: (x0 + x1) / 2, cy: (yTop + yMid) / 2, rx: w * 0.34, ry: (yMid - yTop) / 2 } };
}

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
  // 규격 사진(여권)을 고르면 얼굴 크기 기준을 캔버스에 겹쳐 보여 주고, 한 줄 안내를 붙인다
  const guideNote = h('p', { class: 'sheet-note crop-guide-note', hidden: true });
  const guideLong = h('p', { class: 'sheet-note', hidden: true });
  function showGuideNote() {
    const G = GUIDES[aspectKey];
    guideNote.hidden = !G;
    guideLong.hidden = !G || !!ed.peek;
    if (G) { guideNote.textContent = G.short(); guideLong.textContent = G.long(); }
  }
  const chips = Chips({ label: t('비율', 'Aspect ratio'), items: ASPECTS.map(([id, ko, en]) => ({ id, label: t(ko, en) })), value: 'free', onSelect: (id) => {
    aspectKey = id;
    const a = aspectVal();
    if (a) { crop = maxCropRect(geo, a, info.w, info.h); }
    showGuideNote();
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
    geo = { r: 0, f: 0, a: 0, pv: 0, ph: 0, crop: [0, 0, 1, 1] }; crop = [0, 0, 1, 1]; ops.length = 0; angleBase = 0; aspectKey = 'free'; chips.set('free'); showGuideNote();
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
  body.append(chips.el, guideNote, row, angleS.el);
  const extra = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } }, vS.el, hS.el);
  extra.hidden = true;
  body.append(extra, guideLong);
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

  /** 정수리 선 + 턱 끝 허용 띠 + 중앙선 + 얼굴 타원(참고). 프레임 안쪽에만 그린다 */
  function drawGuide(ctx, G, x0, y0, x1, y1) {
    const L = guideLayout(G, x0, y0, x1, y1);
    if (L.w < 40 || L.h < 40) return;
    const line = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, y0, L.w, L.h); ctx.clip();
    ctx.fillStyle = 'rgba(70, 220, 130, .24)'; ctx.fillRect(x0, L.yMin, L.w, L.yMax - L.yMin); // 턱 끝 허용 띠
    ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 2; ctx.lineWidth = 1.5; ctx.setLineDash([7, 4]);
    ctx.strokeStyle = 'rgba(120, 255, 175, .95)';
    line(x0, L.yTop, x1, L.yTop); line(x0, L.yMin, x1, L.yMin); line(x0, L.yMax, x1, L.yMax);
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1; line(L.cx, y0, L.cx, y1); // 가로 중앙
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(L.ell.cx, L.ell.cy, L.ell.rx, L.ell.ry, 0, 0, Math.PI * 2); ctx.stroke(); // 얼굴 틀(참고)
    ctx.setLineDash([]); ctx.shadowBlur = 0;
    if (L.w >= 120) { // 라벨
      ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const tag = (txt, y) => { const tw = ctx.measureText(txt).width + 12; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x1 - 6 - tw, y - 9, tw, 18, 9) : ctx.rect(x1 - 6 - tw, y - 9, tw, 18); ctx.fill(); ctx.fillStyle = '#9dffc4'; ctx.fillText(txt, x1 - 12, y + 0.5); };
      tag(t('정수리', 'Crown'), Math.max(y0 + 12, L.yTop - 11));
      tag(L.w >= 170 ? t(`턱 끝 · 얼굴 ${G.faceMin / 10}~${G.faceMax / 10}cm`, `Chin · face ${G.faceMin}–${G.faceMax} mm`) : t('턱 끝', 'Chin'), (L.yMin + L.yMax) / 2);
    }
    ctx.restore();
  }

  function drawOverlay(ctx, view) {
    const [x0, y0, x1, y1] = rectScreen();
    const w = view.sw, hh = view.sh;
    // 바깥 어둡게
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath(); ctx.rect(0, 0, w, hh); ctx.rect(x0, y0, x1 - x0, y1 - y0); ctx.fill('evenodd');
    // 격자 (규격 사진 가이드가 있을 때는 선이 겹쳐 복잡하니 끈다)
    if (showGrid && !GUIDES[aspectKey]) {
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(x0 + ((x1 - x0) * i) / 3, y0); ctx.lineTo(x0 + ((x1 - x0) * i) / 3, y1);
        ctx.moveTo(x0, y0 + ((y1 - y0) * i) / 3); ctx.lineTo(x1, y0 + ((y1 - y0) * i) / 3);
      }
      ctx.stroke();
    }
    // 규격 사진 가이드(얼굴 크기 기준)
    if (GUIDES[aspectKey]) drawGuide(ctx, GUIDES[aspectKey], x0, y0, x1, y1);
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
    onPeek(peek) { extra.hidden = peek; guideLong.hidden = peek || !GUIDES[aspectKey]; },
    /** 테스트/디버그: 현재 가이드(없으면 null) — 화면 좌표의 선 위치 */
    guideInfo() { const G = GUIDES[aspectKey]; if (!G) return null; const [a, b, c, d] = rectScreen(); return { key: aspectKey, ...guideLayout(G, a, b, c, d) }; },
    cropRect() { return crop.slice(); },
    refresh() {},
    toggleGrid() { showGrid = !showGrid; ed.app.settings.grid = showGrid; ed.app.saveSettings(); ed.invalidateOverlay(); },
  };
}
