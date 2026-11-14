// 곡선: RGB/R/G/B 톤 커브 (히스토그램 배경, 점 추가·이동·삭제, 숫자 입력/키보드 보정)
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { curveLUT } from '../engine/develop.js';
import { Segmented, Chips, Btn, IconBtn } from '../ui/components.js';

const IDENT = () => [[0, 0], [1, 1]];
const PRESETS = [
  ['linear', '기본', 'Default', {}],
  ['bright', '밝게', 'Brighter', { l: [[0, 0], [0.5, 0.62], [1, 1]] }],
  ['dark', '어둡게', 'Darker', { l: [[0, 0], [0.5, 0.4], [1, 1]] }],
  ['contrast', '대비 강하게', 'More contrast', { l: [[0, 0], [0.25, 0.17], [0.75, 0.84], [1, 1]] }],
  ['soft', '대비 약하게', 'Less contrast', { l: [[0, 0.05], [0.25, 0.28], [0.75, 0.74], [1, 0.96]] }],
  ['fade', '페이드', 'Fade', { l: [[0, 0.1], [1, 0.95]] }],
  ['highkey', '하이키', 'High key', { l: [[0, 0.08], [0.5, 0.7], [1, 1]] }],
  ['lowkey', '로우키', 'Low key', { l: [[0, 0], [0.5, 0.3], [1, 0.92]] }],
  ['cross', '크로스 프로세스', 'Cross process', { r: [[0, 0], [0.5, 0.42], [1, 1]], g: [[0, 0], [0.5, 0.56], [1, 1]], b: [[0, 0.1], [0.5, 0.55], [1, 0.86]] }],
];

export function open(ed, body) {
  let ch = 'l', sel = -1, drag = false;
  const SIZE = 560;
  const cv = h('canvas', { width: SIZE, height: SIZE, role: 'application', 'aria-label': t('곡선 편집기', 'Curve editor'), tabIndex: 0 });
  const wrap = h('div', { class: 'curve' }, cv);

  const curves = () => ed.doc().adj.curves || {};
  const pts = () => (curves()[ch] && curves()[ch].length ? curves()[ch] : IDENT());
  const isIdent = (p) => !p || (p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 1 && p[1][1] === 1);
  function setPts(p, commit) {
    ed.preview((d) => {
      const c = { ...(d.adj.curves || {}), [ch]: p };
      for (const k of Object.keys(c)) if (isIdent(c[k])) delete c[k];
      const adj = { ...d.adj };
      if (Object.keys(c).length) adj.curves = c; else delete adj.curves;
      return setIn(d, 'adj', adj);
    });
    if (commit) ed.commit(t('곡선', 'Curves'));
  }

  const colors = { l: '#e8e8e8', r: '#ff6b6b', g: '#5fd18a', b: '#6aa8ff' };
  function draw() {
    const c = cv.getContext('2d'), W = SIZE;
    const css = getComputedStyle(document.documentElement);
    c.clearRect(0, 0, W, W);
    c.fillStyle = css.getPropertyValue('--c-s3') || '#2c2c2c'; c.fillRect(0, 0, W, W);
    // 히스토그램
    const hh = ed.hist;
    if (hh) {
      const off = ch === 'l' ? 768 : ch === 'r' ? 0 : ch === 'g' ? 256 : 512;
      let mx = 1; for (let i = 0; i < 256; i++) mx = Math.max(mx, hh[off + i]);
      c.fillStyle = 'rgba(160,160,160,.28)'; c.beginPath(); c.moveTo(0, W);
      for (let i = 0; i < 256; i++) c.lineTo((i / 255) * W, W - Math.pow(hh[off + i] / mx, 0.55) * W * 0.92);
      c.lineTo(W, W); c.closePath(); c.fill();
    }
    // 격자
    c.strokeStyle = 'rgba(128,128,128,.35)'; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo((W * i) / 4, 0); c.lineTo((W * i) / 4, W); c.moveTo(0, (W * i) / 4); c.lineTo(W, (W * i) / 4); c.stroke(); }
    c.setLineDash([6, 6]); c.beginPath(); c.moveTo(0, W); c.lineTo(W, 0); c.stroke(); c.setLineDash([]);
    // 곡선
    const p = pts(), lut = curveLUT(p, 256);
    c.strokeStyle = colors[ch]; c.lineWidth = 3; c.lineJoin = 'round'; c.beginPath();
    for (let i = 0; i < 256; i++) { const x = (i / 255) * W, y = W - lut[i] * W; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
    p.forEach((q, i) => {
      const x = q[0] * W, y = W - q[1] * W;
      c.beginPath(); c.arc(x, y, i === sel ? 13 : 9, 0, Math.PI * 2);
      c.fillStyle = i === sel ? colors[ch] : '#ffffff'; c.fill(); c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,.55)'; c.stroke();
    });
  }
  ed.wantHist = true; ed.onHist = draw; ed.requestRender('full');

  const rel = (e) => { const r = cv.getBoundingClientRect(); return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)), r]; };
  cv.addEventListener('pointerdown', (e) => {
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const [x, y, r] = rel(e);
    const p = pts().map((q) => [...q]);
    let best = -1, bd = 1e9;
    p.forEach((q, i) => { const d = Math.hypot((q[0] - x) * r.width, (q[1] - y) * r.height); if (d < bd) { bd = d; best = i; } });
    if (bd <= 24) {
      const now = Date.now();
      if (best === sel && now - (cv._last || 0) < 320 && best > 0 && best < p.length - 1) { p.splice(best, 1); sel = -1; setPts(p, true); renderInfo(); draw(); cv._last = 0; return; }
      cv._last = now; sel = best;
    } else {
      p.push([x, y]); p.sort((a, b) => a[0] - b[0]);
      sel = p.findIndex((q) => q[0] === x && q[1] === y);
      setPts(p, false);
    }
    drag = true; renderInfo(); draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag || sel < 0) return;
    const [x, y] = rel(e);
    const p = pts().map((q) => [...q]);
    const lo = sel > 0 ? p[sel - 1][0] + 0.01 : 0, hi = sel < p.length - 1 ? p[sel + 1][0] - 0.01 : 1;
    p[sel][1] = y;
    if (sel > 0 && sel < p.length - 1) p[sel][0] = Math.max(lo, Math.min(hi, x));
    setPts(p, false); renderInfo(); draw();
  });
  const end = () => { if (drag) { drag = false; ed.commit(t('곡선', 'Curves')); } };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv.addEventListener('keydown', (e) => {
    if (sel < 0) return;
    const step = e.shiftKey ? 10 : 1, p = pts().map((q) => [...q]);
    let dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -step; else if (e.key === 'ArrowRight') dx = step; else if (e.key === 'ArrowUp') dy = step; else if (e.key === 'ArrowDown') dy = -step; else return;
    e.preventDefault(); nudge(dx, dy);
  });

  const inEl = h('input', { class: 'field num', type: 'text', inputMode: 'numeric', 'aria-label': t('입력', 'Input'), style: { width: '72px', height: '40px' } });
  const outEl = h('input', { class: 'field num', type: 'text', inputMode: 'numeric', 'aria-label': t('출력', 'Output'), style: { width: '72px', height: '40px' } });
  const info = h('div', { class: 'row wrap' }, h('span', { class: 'sheet-note' }, t('입력', 'In')), inEl, h('span', { class: 'sheet-note' }, t('출력', 'Out')), outEl,
    IconBtn('arrow-left', t('왼쪽으로', 'Left'), () => nudge(-1, 0)), IconBtn('arrow-right', t('오른쪽으로', 'Right'), () => nudge(1, 0)), IconBtn('arrow-up', t('위로', 'Up'), () => nudge(0, 1)), IconBtn('arrow-down', t('아래로', 'Down'), () => nudge(0, -1)),
    IconBtn('trash-2', t('점 삭제', 'Delete point'), () => { const p = pts().map((q) => [...q]); if (sel > 0 && sel < p.length - 1) { p.splice(sel, 1); sel = -1; setPts(p, true); renderInfo(); draw(); } }));
  function nudge(dx, dy) {
    if (sel < 0) return;
    const p = pts().map((q) => [...q]);
    const lo = sel > 0 ? p[sel - 1][0] + 0.004 : 0, hi = sel < p.length - 1 ? p[sel + 1][0] - 0.004 : 1;
    if (sel > 0 && sel < p.length - 1) p[sel][0] = Math.max(lo, Math.min(hi, p[sel][0] + dx / 255));
    p[sel][1] = Math.max(0, Math.min(1, p[sel][1] + dy / 255));
    setPts(p, true); renderInfo(); draw();
  }
  function renderInfo() {
    const q = pts()[sel];
    info.hidden = !q;
    if (q) { inEl.value = Math.round(q[0] * 255); outEl.value = Math.round(q[1] * 255); }
  }
  const applyNum = () => {
    if (sel < 0) return;
    const p = pts().map((q) => [...q]);
    const xi = Math.max(0, Math.min(255, parseInt(inEl.value, 10) || 0)), yi = Math.max(0, Math.min(255, parseInt(outEl.value, 10) || 0));
    const lo = sel > 0 ? p[sel - 1][0] + 0.004 : 0, hi = sel < p.length - 1 ? p[sel + 1][0] - 0.004 : 1;
    if (sel > 0 && sel < p.length - 1) p[sel][0] = Math.max(lo, Math.min(hi, xi / 255));
    p[sel][1] = yi / 255;
    setPts(p, true); renderInfo(); draw();
  };
  inEl.addEventListener('change', applyNum); outEl.addEventListener('change', applyNum);

  const seg = Segmented({ label: t('채널', 'Channel'), items: [{ id: 'l', label: 'RGB' }, { id: 'r', label: 'R' }, { id: 'g', label: 'G' }, { id: 'b', label: 'B' }], value: ch, onChange: (v) => { ch = v; sel = -1; renderInfo(); draw(); } });
  const presets = Chips({ label: t('프리셋', 'Presets'), items: PRESETS.map(([id, ko, en]) => ({ id, label: t(ko, en) })), onSelect: (id) => {
    const pr = PRESETS.find((x) => x[0] === id)[3];
    ed.apply((d) => { const adj = { ...d.adj }; if (Object.keys(pr).length) adj.curves = JSON.parse(JSON.stringify(pr)); else delete adj.curves; return setIn(d, 'adj', adj); }, t('곡선 프리셋', 'Curve preset'));
    sel = -1; renderInfo(); draw();
  } });

  ed.setPeek(false);
  body.append(seg.el, wrap, info, presets.el);
  info.hidden = true;
  draw();
  ed.setActions([Btn(t('초기화', 'Reset'), 'text', () => { ed.apply((d) => { const adj = { ...d.adj }; delete adj.curves; return setIn(d, 'adj', adj); }, t('곡선 초기화', 'Reset curves')); sel = -1; renderInfo(); draw(); }), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  return { refresh() { sel = -1; renderInfo(); draw(); }, close() { ed.wantHist = false; ed.onHist = null; } };
}
