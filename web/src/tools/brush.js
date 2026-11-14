// 브러시(로컬 보정): 브러시/선형/원형 그라데이션/색 범위 마스크 + 보정값. 인물 보정·컬러 스플래시 프리셋 포함
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn, uid } from '../store.js';
import { Segmented, Chips, Slider, Switch, Btn, IconBtn, toast } from '../ui/components.js';
import { ParamPanel } from './panel.js';
import { hexToRgb } from '../ui/color.js';

const PRESETS = {
  dodge: ['밝게', 'Dodge', { exposure: 35 }],
  burn: ['어둡게', 'Burn', { exposure: -35 }],
  saturate: ['채도 올리기', 'Saturate', { saturation: 45 }],
  desat: ['채도 낮추기', 'Desaturate', { saturation: -60 }],
  warm: ['따뜻하게', 'Warm', { temp: 35 }],
  cool: ['차갑게', 'Cool', { temp: -35 }],
  sharpen: ['선명하게', 'Sharpen', { sharpen: 60, clarity: 25 }],
  blur: ['흐리게', 'Blur', { blur: 45 }],
  smooth: ['피부 매끄럽게', 'Smooth skin', { smooth: 65, clarity: -12 }],
  teeth: ['치아 미백', 'Whiten teeth', { exposure: 8, hsl: { yellow: [0, -65, 22], orange: [0, -30, 10] } }],
  eyes: ['눈 밝게', 'Brighten eyes', { exposure: 22, contrast: 14, clarity: 22 }],
  redeye: ['적목 제거', 'Remove red-eye', { hsl: { red: [0, -92, -55], magenta: [0, -70, -35] } }],
  splash: ['컬러 스플래시', 'Color splash', { saturation: -100 }, { inv: true }],
};
const FACE_IDS = ['smooth', 'teeth', 'eyes', 'redeye'];

const LP = (key, ko, en, min = -100, max = 100, def = 0) => ({ key, ko, en, min, max, def });
const LOCAL_PARAMS = [LP('exposure', '노출', 'Exposure'), LP('contrast', '대비', 'Contrast'), LP('highlights', '하이라이트', 'Highlights'), LP('shadows', '그림자', 'Shadows'), LP('saturation', '채도', 'Saturation'), LP('vibrance', '생동감', 'Vibrance'), LP('temp', '색온도', 'Warmth'), LP('tint', '틴트', 'Tint'), LP('sharpen', '선명도', 'Sharpen', 0, 100), LP('clarity', '명료도', 'Clarity'), LP('blur', '흐림', 'Blur', 0, 100), LP('smooth', '피부 스무딩', 'Smooth', 0, 100)];

export function open(ed, body) {
  const st = Object.assign({ size: 10, soft: 60, erase: false, showMask: true }, ed.app.settings.brush || {});
  let selId = null, cur = null, last = 0, cursor = null, handle = null;
  const save = () => { ed.app.settings.brush = { size: st.size, soft: st.soft }; ed.app.saveSettings(); };
  const locals = () => ed.doc().locals;
  const curL = () => locals().find((l) => l.id === selId) || null;
  const patchLocal = (id, patch, commit, label) => {
    ed.preview((d) => setIn(d, 'locals', d.locals.map((l) => (l.id === id ? { ...l, ...patch } : l))));
    if (commit) ed.commit(label || t('브러시 보정', 'Local adjust'));
  };
  const name = (l, i) => (l.name ? t(...l.name) : t(`마스크 ${i + 1}`, `Mask ${i + 1}`));

  const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  function addLocal(kind, extra = {}, preset) {
    const base = { id: uid('m'), kind, on: true, p: {}, amt: 100, inv: false };
    if (kind === 'brush') Object.assign(base, { strokes: [], feather: 0 });
    if (kind === 'linear') Object.assign(base, { x1: 0.5, y1: 0.55, x2: 0.5, y2: 0.25, feather: 0.6 });
    if (kind === 'radial') Object.assign(base, { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, rot: 0, feather: 0.5 });
    if (kind === 'color') Object.assign(base, { rgb: [200, 160, 120], tol: 40 });
    if (preset) { base.p = JSON.parse(JSON.stringify(PRESETS[preset][2])); base.name = [PRESETS[preset][0], PRESETS[preset][1]]; if (PRESETS[preset][3]) Object.assign(base, PRESETS[preset][3]); }
    Object.assign(base, extra);
    ed.apply((d) => setIn(d, 'locals', [...d.locals, base]), t('브러시 보정 추가', 'Add local adjust'));
    selId = base.id;
    render(); ed.invalidateOverlay();
    return base;
  }

  function render() {
    root.replaceChildren();
    ed.setPeek(false);
    const list = locals();
    const L = curL();
    // 목록
    if (list.length) {
      root.append(Chips({ label: t('마스크 목록', 'Masks'), items: list.map((l, i) => ({ id: l.id, label: name(l, i) })), value: selId, onSelect: (id) => { selId = id; render(); ed.invalidateOverlay(); } }).el);
    }
    // 새로 만들기
    const kinds = Chips({ label: t('새 마스크', 'New mask'), items: [{ id: 'brush', label: t('브러시', 'Brush'), icon: 'brush' }, { id: 'linear', label: t('선형', 'Linear'), icon: 'panel-top' }, { id: 'radial', label: t('원형', 'Radial'), icon: 'circle' }, { id: 'color', label: t('색 범위', 'Color range'), icon: 'pipette' }], onSelect: (k) => { addLocal(k); } });
    const pres = Chips({ label: t('프리셋', 'Presets'), items: Object.entries(PRESETS).map(([id, v]) => ({ id, label: t(v[0], v[1]) })), onSelect: (id) => startPreset(id) });
    if (!L) {
      root.append(h('div', { class: 'sheet-sec' }, t('새 마스크 만들기', 'New mask')), kinds.el, h('div', { class: 'sheet-sec' }, t('프리셋으로 시작', 'Start from a preset')), pres.el);
      ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
      return;
    }
    // 선택된 마스크 편집
    root.append(h('div', { class: 'sheet-sec' }, t('마스크', 'Mask')));
    if (L.kind === 'brush') {
      root.append(Segmented({ label: t('브러시 모드', 'Brush mode'), items: [{ id: 'paint', label: t('칠하기', 'Paint'), icon: 'brush' }, { id: 'erase', label: t('지우개', 'Eraser'), icon: 'eraser' }], value: st.erase ? 'erase' : 'paint', onChange: (v) => { st.erase = v === 'erase'; } }).el,
        Slider({ label: t('브러시 크기', 'Brush size'), min: 1, max: 60, value: st.size, def: 10, bipolar: false, onInput: (v) => { st.size = v; }, onChange: save }).el,
        Slider({ label: t('부드러움', 'Softness'), min: 0, max: 100, value: st.soft, def: 60, unit: '%', bipolar: false, onInput: (v) => { st.soft = v; }, onChange: save }).el,
        Switch({ label: t('칠한 영역 보기', 'Show painted area'), value: st.showMask, onChange: (v) => { st.showMask = v; ed.invalidateOverlay(); } }).el,
        h('div', { class: 'row' }, Btn(t('마스크 지우기', 'Clear mask'), 'outlined', () => { patchLocal(L.id, { strokes: [] }, true); ed.invalidateOverlay(); })));
    } else if (L.kind === 'linear' || L.kind === 'radial') {
      root.append(h('p', { class: 'sheet-note' }, L.kind === 'linear' ? t('사진 위의 두 점을 끌어 효과가 시작되고 끝나는 위치를 정하세요.', 'Drag the two points on the photo to set where the effect starts and ends.') : t('가운데 점과 가장자리 점을 끌어 범위를 정하세요.', 'Drag the center and edge points to set the area.')),
        Slider({ label: t('번짐', 'Feather'), min: 0, max: 100, value: Math.round((L.feather == null ? 0.5 : L.feather) * 100), def: 50, unit: '%', bipolar: false, onInput: (v) => patchLocal(L.id, { feather: v / 100 }, false), onChange: () => ed.commit(t('번짐', 'Feather')) }).el);
    } else if (L.kind === 'color') {
      root.append(Btn(t('사진에서 색 고르기', 'Pick color from photo'), 'outlined', () => ed.pickColorFromCanvas((hex) => { if (hex) patchLocal(L.id, { rgb: hexToRgb(hex) }, true); }), 'pipette'),
        Slider({ label: t('허용 범위', 'Tolerance'), min: 5, max: 120, value: L.tol || 40, def: 40, bipolar: false, onInput: (v) => patchLocal(L.id, { tol: v }, false), onChange: () => ed.commit(t('허용 범위', 'Tolerance')) }).el);
    }
    root.append(Switch({ label: t('영역 반전', 'Invert mask'), value: !!L.inv, onChange: (v) => { patchLocal(L.id, { inv: v }, true); ed.invalidateOverlay(); } }).el,
      Slider({ label: t('적용 강도', 'Amount'), min: 0, max: 100, value: L.amt == null ? 100 : L.amt, def: 100, unit: '%', bipolar: false, onInput: (v) => patchLocal(L.id, { amt: v }, false), onChange: () => ed.commit(t('적용 강도', 'Amount')) }).el,
      h('div', { class: 'sheet-sec' }, t('보정', 'Adjustments')));
    const panel = ParamPanel(ed, {
      params: LOCAL_PARAMS,
      get: (k) => { const l = curL(); return l && l.p[k]; },
      set: (k, v, commit) => {
        const l = curL(); if (!l) return;
        const p = { ...l.p }; if (!v) delete p[k]; else p[k] = v;
        patchLocal(l.id, { p }, commit, t('브러시 보정', 'Local adjust'));
      },
    });
    panel.render(true);
    root.append(panel.el);
    root.append(h('div', { class: 'row', style: { marginTop: '8px' } },
      Btn(L.on === false ? t('켜기', 'Turn on') : t('끄기', 'Turn off'), 'outlined', () => { patchLocal(L.id, { on: L.on === false }, true); render(); }, L.on === false ? 'eye' : 'eye-off'),
      Btn(t('삭제', 'Delete'), 'outlined', () => { ed.apply((d) => setIn(d, 'locals', d.locals.filter((l) => l.id !== L.id)), t('마스크 삭제', 'Delete mask')); selId = null; render(); ed.invalidateOverlay(); }, 'trash-2')));
    ed.setActions([IconBtn('plus', t('마스크 추가', 'New mask'), () => { selId = null; render(); }), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  }

  function startPreset(id) { addLocal('brush', {}, id); toast(t('보정할 부분을 사진에서 칠해 주세요', 'Paint over the area to adjust')); }

  // ---------------- 포인터 ----------------
  const unit = () => ed.unit();
  const toCanvas = (ev) => ed.contentToCanvas(ev.x, ev.y);
  const scr = (cx, cy) => ed.view.toScreen(...ed.canvasToContent(cx, cy));
  function handlesOf(L) {
    if (L.kind === 'linear') return [['p1', ...scr(L.x1, L.y1)], ['p2', ...scr(L.x2, L.y2)]];
    if (L.kind === 'radial') { const c = scr(L.cx, L.cy), g = ed.geom(); void g; return [['c', ...c], ['rx', ...scr(L.cx + L.rx, L.cy)], ['ry', ...scr(L.cx, L.cy + L.ry)]]; }
    return [];
  }

  const pointer = {
    down(ev) {
      const L = curL();
      if (!L || L.on === false) return false;
      cursor = [ev.sx, ev.sy];
      if (L.kind === 'brush') {
        const [x, y] = toCanvas(ev);
        cur = { id: L.id, base: L.strokes, stroke: { pts: [x, y], r: st.size / 300, soft: st.soft / 100, erase: !!st.erase } };
        last = 0; ed.invalidateOverlay();
        return true;
      }
      if (L.kind === 'linear' || L.kind === 'radial') {
        let best = null, bd = 44;
        for (const [k, sx, sy] of handlesOf(L)) { const d = Math.hypot(sx - ev.sx, sy - ev.sy); if (d < bd) { bd = d; best = k; } }
        if (best) { handle = { id: L.id, k: best }; return true; }
      }
      return false;
    },
    move(ev) {
      cursor = [ev.sx, ev.sy];
      if (cur) {
        const [x, y] = toCanvas(ev), p = cur.stroke.pts, n = p.length;
        if (Math.hypot(p[n - 2] - x, p[n - 1] - y) < (cur.stroke.r * 0.12)) return;
        p.push(x, y);
        const now = performance.now();
        if (now - last > 90) { last = now; const s = { ...cur.stroke, pts: p.slice() }; patchLocal(cur.id, { strokes: [...cur.base, s] }, false); }
        ed.invalidateOverlay();
        return;
      }
      if (handle) {
        const [x, y] = toCanvas(ev), L = curL(); if (!L) return;
        const patch = {};
        if (handle.k === 'p1') { patch.x1 = x; patch.y1 = y; } else if (handle.k === 'p2') { patch.x2 = x; patch.y2 = y; }
        else if (handle.k === 'c') { patch.cx = x; patch.cy = y; }
        else if (handle.k === 'rx') patch.rx = Math.max(0.02, Math.abs(x - L.cx));
        else if (handle.k === 'ry') patch.ry = Math.max(0.02, Math.abs(y - L.cy));
        patchLocal(L.id, patch, false); ed.invalidateOverlay();
      }
    },
    up() {
      if (cur) { const c = cur; cur = null; patchLocal(c.id, { strokes: [...c.base, { ...c.stroke, pts: c.stroke.pts.slice() }] }, true, t('브러시 칠하기', 'Paint')); ed.invalidateOverlay(); }
      else if (handle) { handle = null; ed.commit(t('마스크 편집', 'Edit mask')); }
    },
    cancel() { cur = null; handle = null; ed.store.revert(); ed.invalidateOverlay(); },
  };

  function drawOverlay(ctx, view) {
    const L = curL();
    if (!L) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 3;
    if (L.kind === 'brush') {
      if (st.showMask) {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const all = [...(L.strokes || [])];
        for (const s of all) {
          ctx.strokeStyle = s.erase ? 'rgba(80,160,255,.0)' : 'rgba(255,60,60,.32)';
          if (s.erase) continue;
          ctx.lineWidth = Math.max(2, s.r * unit() * view.s * 2);
          ctx.beginPath();
          for (let i = 0; i < s.pts.length; i += 2) { const [sx, sy] = scr(s.pts[i], s.pts[i + 1]); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); }
          if (s.pts.length === 2) { const [sx, sy] = scr(s.pts[0], s.pts[1]); ctx.lineTo(sx + 0.1, sy); }
          ctx.stroke();
        }
      }
      if (cursor && cur) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cursor[0], cursor[1], (st.size / 300) * unit() * view.s, 0, Math.PI * 2); ctx.stroke(); }
    } else if (L.kind === 'linear') {
      const a = scr(L.x1, L.y1), b = scr(L.x2, L.y2);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, W = Math.max(view.sw, view.sh);
      ctx.setLineDash([6, 5]);
      for (const p of [a, b]) { ctx.beginPath(); ctx.moveTo(p[0] - nx * W, p[1] - ny * W); ctx.lineTo(p[0] + nx * W, p[1] + ny * W); ctx.stroke(); }
      ctx.setLineDash([]);
    } else if (L.kind === 'radial') {
      const c = scr(L.cx, L.cy), rx = scr(L.cx + L.rx, L.cy), ry = scr(L.cx, L.cy + L.ry);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.ellipse(c[0], c[1], Math.abs(rx[0] - c[0]), Math.abs(ry[1] - c[1]), 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    for (const [, sx, sy] of handlesOf(L)) {
      ctx.beginPath(); ctx.arc(sx, sy, 12, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.stroke();
    }
    ctx.restore();
  }

  ed.setPeek(false);
  body.append(root);
  if (locals().length) selId = locals()[locals().length - 1].id;
  render();
  return { pointer, drawOverlay, refresh() { if (!curL()) selId = null; render(); }, startPreset };
}
