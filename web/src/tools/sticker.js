// 스티커: 이모지 / 도형 / 내 사진(합성·워터마크) + 선택 항목 편집
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { EMOJI_CATS, SHAPE_LIST, SHAPE_DEFAULTS, shapePath, OPEN_SHAPES } from '../shapes.js';
import { Segmented, Chips, Switch, Btn, IconBtn, toast } from '../ui/components.js';
import { LayerKit } from './layerkit.js';
import { ColorField } from './colorfield.js';
import { layerSlider, layerActions, blendChips } from './layerui.js';
import { bridge } from '../bridge.js';

const TYPES = ['emoji', 'shape', 'image'];

function shapeThumb(kind) {
  const cv = h('canvas', { width: 56, height: 56, 'aria-hidden': 'true' });
  const c = cv.getContext('2d');
  c.translate(28, 28);
  const sp = new Path2D(); sp.addPath(shapePath(kind), new DOMMatrix([36, 0, 0, 36, 0, 0]));
  c.fillStyle = '#b8c4d8'; c.strokeStyle = '#b8c4d8'; c.lineWidth = 3; c.lineCap = 'round';
  if (OPEN_SHAPES.has(kind)) c.stroke(sp); else c.fill(sp, kind === 'ring' ? 'evenodd' : 'nonzero');
  return cv;
}

export function open(ed, body) {
  let tab = 'emoji', cat = 0;
  const kit = LayerKit(ed, { types: TYPES, onSelect: () => render() });
  const cur = () => { const L = ed.sel && ed.layerById(ed.sel); return L && TYPES.includes(L.t) ? L : null; };
  const upd = (patch, commit = true, label) => { const L = cur(); if (L) ed.updateLayer(L.id, patch, commit, label || t('스티커', 'Sticker')); };

  async function addPhoto() {
    const files = await bridge.pickFile('image/*');
    if (!files.length) return;
    try {
      const key = await ed.addImageAsset(files[0]);
      ed.addLayer({ t: 'image', asset: key, w: 0.5, x: 0.5, y: 0.5 }, t('사진 추가', 'Add photo'));
      render();
    } catch (e) { console.error(e); toast(t('사진을 불러오지 못했어요.', "Couldn't load the photo.")); }
  }

  function render() {
    body.replaceChildren();
    ed.setPeek(false);
    const seg = Segmented({ label: t('종류', 'Type'), items: [{ id: 'emoji', label: t('이모지', 'Emoji') }, { id: 'shape', label: t('도형', 'Shapes') }, { id: 'photo', label: t('사진', 'Photo') }], value: tab, onChange: (v) => { tab = v; render(); } });
    body.append(seg.el);
    const L = cur();
    if (tab === 'emoji') {
      const chips = Chips({ label: t('분류', 'Category'), items: EMOJI_CATS.map((c, i) => ({ id: String(i), label: t(c[0], c[1]) })), value: String(cat), onSelect: (id) => { cat = +id; render(); } });
      const grid = h('div', { class: 'grid-btns', role: 'group', 'aria-label': t('이모지', 'Emoji') });
      for (const ch of EMOJI_CATS[cat][2].split(' ')) {
        const b = h('button', { class: 'gbtn', type: 'button', 'aria-label': ch }, ch);
        b.addEventListener('click', () => { ed.addLayer({ t: 'emoji', ch, size: 0.2, x: 0.5, y: 0.5 }, t('이모지 추가', 'Add emoji')); render(); });
        grid.append(b);
      }
      body.append(chips.el, grid);
    } else if (tab === 'shape') {
      const grid = h('div', { class: 'grid-btns', role: 'group', 'aria-label': t('도형', 'Shapes') });
      for (const [k, ko, en] of SHAPE_LIST) {
        const b = h('button', { class: 'gbtn', type: 'button', 'aria-label': t(ko, en) }, shapeThumb(k));
        b.addEventListener('click', () => {
          const def = SHAPE_DEFAULTS[k] || {};
          const line = k === 'line';
          ed.addLayer({ t: 'shape', kind: k, w: line ? 0.5 : 0.3, h: line ? 0.02 : 0.3, fill: line ? null : (def.fill || '#ffffff'), stroke: line ? '#ffffff' : null, sw: 0.012, x: 0.5, y: 0.5 }, t('도형 추가', 'Add shape'));
          render();
        });
        grid.append(b);
      }
      body.append(grid);
    } else {
      body.append(Btn(t('사진 추가', 'Add photo'), 'tonal', addPhoto, 'image-plus'), h('p', { class: 'sheet-note' }, t('불러온 사진을 올려 합성하거나, 로고·워터마크로 쓸 수 있어요. 혼합 모드로 이중 노출도 만들 수 있어요.', 'Overlay another photo, use it as a logo or watermark, or blend it for a double exposure.')));
    }
    if (L) {
      body.append(h('div', { class: 'sheet-sec' }, t('선택한 항목', 'Selected')));
      const S = (o) => layerSlider(ed, L.id, o).el;
      const col = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
      if (L.t === 'emoji') {
        col.append(S({ label: t('크기', 'Size'), min: 2, max: 100, def: 20, get: (l) => Math.round(l.size * 100), set: (v) => ({ size: v / 100 }), bipolar: false }));
        col.append(Switch({ label: t('좌우 반전', 'Flip'), value: !!L.flip, onChange: (v) => upd({ flip: v }) }).el);
      } else if (L.t === 'shape') {
        const line = L.kind === 'line';
        if (!line) col.append(ColorField(ed, { label: t('채우기', 'Fill'), value: L.fill || '#ffffff', onChange: (c, commit) => upd({ fill: c }, commit) }).el);
        col.append(ColorField(ed, { label: t('테두리', 'Stroke'), value: L.stroke || '#ffffff', onChange: (c, commit) => upd({ stroke: c }, commit) }).el,
          S({ label: t('테두리 굵기', 'Stroke width'), min: 0, max: 40, def: line ? 12 : 0, get: (l) => Math.round((l.sw == null ? 0.012 : l.sw) * 1000), set: (v, l) => ({ sw: v / 1000, stroke: v > 0 ? (l.stroke || '#ffffff') : null }), bipolar: false }),
          S({ label: t('가로 크기', 'Width'), min: 2, max: 200, def: 30, get: (l) => Math.round(l.w * 100), set: (v) => ({ w: v / 100 }), bipolar: false }));
        if (!line) col.append(S({ label: t('세로 크기', 'Height'), min: 2, max: 200, def: 30, get: (l) => Math.round((l.h == null ? l.w : l.h) * 100), set: (v) => ({ h: v / 100 }), bipolar: false }));
      } else if (L.t === 'image') {
        col.append(S({ label: t('크기', 'Size'), min: 5, max: 200, def: 50, get: (l) => Math.round(l.w * 100), set: (v) => ({ w: v / 100 }), bipolar: false }),
          S({ label: t('모서리 둥글기', 'Corner radius'), min: 0, max: 50, def: 0, get: (l) => Math.round((l.radius || 0) * 100), set: (v) => ({ radius: v / 100 }), bipolar: false }),
          S({ label: t('테두리', 'Border'), min: 0, max: 40, def: 0, get: (l) => Math.round(((l.border && l.border.w) || 0) * 1000), set: (v, l) => ({ border: { ...(l.border || { color: '#ffffff' }), w: v / 1000 } }), bipolar: false }),
          Switch({ label: t('좌우 반전', 'Flip'), value: !!L.flip, onChange: (v) => upd({ flip: v }) }).el);
      }
      col.append(S({ label: t('회전', 'Rotation'), min: -180, max: 180, def: 0, unit: '°', get: (l) => Math.round(l.rot || 0), set: (v) => ({ rot: v }) }),
        S({ label: t('투명도', 'Opacity'), min: 0, max: 100, def: 100, unit: '%', get: (l) => Math.round((l.opacity == null ? 1 : l.opacity) * 100), set: (v) => ({ opacity: v / 100 }), bipolar: false }),
        Switch({ label: t('그림자', 'Shadow'), value: !!(L.shadow && L.shadow.on), onChange: (v) => upd({ shadow: { on: v, blur: 0.03, dx: 0, dy: 0.012, color: 'rgba(0,0,0,.5)' } }) }).el);
      if (L.t === 'image') col.append(h('div', { class: 'sheet-sec' }, t('혼합 모드', 'Blend mode')), blendChips(ed, L.id).el);
      col.append(layerActions(ed, L.id, render));
      body.append(col);
    }
    ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  }
  render();
  return { pointer: kit.pointer, drawOverlay: kit.drawOverlay, refresh: render, close() { ed.sel = null; } };
}
