// 그리기: 펜·마커·형광펜·네온·스프레이·점선·지우개 (벡터 스트로크 → 해상도 독립)
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { BRUSHES, drawStroke, makeGeom } from '../compose.js';
import { Chips, Slider, IconBtn, Btn, confirmDialog } from '../ui/components.js';
import { ColorField } from './colorfield.js';
import { setIn, uid } from '../store.js';

export function open(ed, body) {
  const st = Object.assign({ brush: 'pen', size: 14, opacity: 100, color: '#ffffff' }, ed.app.settings.draw || {});
  let cur = null, snap = null, raf = 0, active = false;

  const brushes = Chips({ label: t('브러시', 'Brush'), items: BRUSHES.map(([k, ko, en]) => ({ id: k, label: t(ko, en) })), value: st.brush, onSelect: (k) => { st.brush = k; if (k === 'eraser') { size.set(30); st.size = 30; } save(); } });
  const size = Slider({ label: t('굵기', 'Size'), min: 1, max: 100, value: st.size, def: 14, bipolar: false, onInput: (v) => { st.size = v; }, onChange: save });
  const opacity = Slider({ label: t('투명도', 'Opacity'), min: 5, max: 100, value: st.opacity, def: 100, unit: '%', bipolar: false, onInput: (v) => { st.opacity = v; }, onChange: save });
  const color = ColorField(ed, { label: t('색상', 'Color'), value: st.color, onChange: (c) => { st.color = c; save(); } });
  function save() { ed.app.settings.draw = { brush: st.brush, size: st.size, opacity: st.opacity, color: st.color }; ed.app.saveSettings(); }

  const undoStroke = IconBtn('undo-2', t('마지막 획 취소', 'Undo last stroke'), () => {
    const L = activeLayer(false);
    if (!L || !L.strokes.length) return;
    ed.apply((d) => setIn(d, 'layers', d.layers.map((l) => (l.id === L.id ? { ...l, strokes: l.strokes.slice(0, -1) } : l))), t('획 취소', 'Undo stroke'));
  });
  const clear = IconBtn('trash-2', t('모두 지우기', 'Clear all'), async () => {
    const L = activeLayer(false);
    if (!L || !L.strokes.length) return;
    const v = await confirmDialog({ title: t('그린 내용을 모두 지울까요?', 'Clear everything you drew?'), actions: [{ label: t('취소', 'Cancel'), value: 'no' }, { label: t('지우기', 'Clear'), value: 'yes', kind: 'danger' }] });
    if (v === 'yes') ed.apply((d) => setIn(d, 'layers', d.layers.filter((l) => l.id !== L.id)), t('그림 지우기', 'Clear drawing'));
  });
  ed.setActions([undoStroke, clear, IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  ed.setPeek(false);
  body.append(brushes.el, size.el, opacity.el, color.el);

  function activeLayer(create) {
    const layers = ed.doc().layers;
    const top = layers[layers.length - 1];
    if (top && top.t === 'draw') return top;
    if (ed.sel) { const s = ed.layerById(ed.sel); if (s && s.t === 'draw') return s; }
    return null;
  }

  const unitSize = () => st.size / 1500; // 단위(짧은 변) 대비

  function liveGeom() {
    const cv = ed.view.photo, f = ed.frameInfo(), lf = ed.logicalFull;
    const k = cv.width / lf.w;
    const lp = ed.logical;
    return { g: makeGeom(Math.round(lp.pw * k), Math.round(lp.ph * k), ed.displayCrop()), ox: f.x * k, oy: f.y * k };
  }
  function renderLive() {
    raf = 0;
    if (!cur || !snap) return;
    const cv = ed.view.photo, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(snap, 0, 0);
    const { g, ox, oy } = liveGeom();
    ctx.save(); ctx.translate(ox, oy);
    // 사진 영역 밖으로 번지지 않도록 클립
    ctx.beginPath(); ctx.rect(0, 0, g.pw, g.ph); ctx.clip();
    drawStroke(ctx, cur, g);
    ctx.restore();
  }

  const pointer = {
    down(ev) {
      active = true;
      const [x, y] = ed.contentToCanvas(ev.x, ev.y);
      cur = { brush: st.brush, color: st.color, size: unitSize(), opacity: st.opacity / 100, pts: [x, y], seed: (Math.random() * 1e6) | 0 };
      if (st.brush !== 'eraser') {
        const cv = ed.view.photo;
        snap = document.createElement('canvas'); snap.width = cv.width; snap.height = cv.height;
        snap.getContext('2d').drawImage(cv, 0, 0);
      } else snap = null;
      pointer.move(ev);
      return true;
    },
    move(ev) {
      if (!cur) return;
      const [x, y] = ed.contentToCanvas(ev.x, ev.y);
      const n = cur.pts.length;
      if (n >= 2 && Math.hypot(cur.pts[n - 2] - x, cur.pts[n - 1] - y) < 0.0008) return;
      cur.pts.push(x, y);
      if (snap) { if (!raf) raf = requestAnimationFrame(renderLive); }
      else previewEraser();
    },
    up() { finish(); },
    cancel() { cur = null; snap = null; active = false; ed.store.revert(); ed.paint(); },
  };

  function layerWith(stroke, d) {
    const layers = d.layers;
    const top = layers[layers.length - 1];
    if (top && top.t === 'draw') return setIn(d, 'layers', layers.map((l) => (l.id === top.id ? { ...l, strokes: [...l.strokes, stroke] } : l)));
    return setIn(d, 'layers', [...layers, { id: uid(), t: 'draw', opacity: 1, strokes: [stroke] }]);
  }
  function previewEraser() { const s = { ...cur, pts: cur.pts.slice() }; ed.preview((d) => layerWith(s, d)); }
  function finish() {
    if (!cur) return;
    const s = { ...cur, pts: cur.pts.slice() };
    cur = null; snap = null; active = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    ed.store.revert();
    ed.apply((d) => layerWith(s, d), t('그리기', 'Draw'));
  }

  return {
    pointer,
    refresh() {},
    drawOverlay(ctx, view) {
      // 브러시 크기 커서 (그리는 중이 아닐 때 중앙 표시 없음)
    },
  };
}
