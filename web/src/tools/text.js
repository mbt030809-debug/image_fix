// 텍스트: 글꼴·크기·색·그라데이션·외곽선·그림자·배경 상자·정렬·간격·혼합
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { FONTS } from '../compose.js';
import { Slider, Chips, Segmented, Switch, Btn, IconBtn } from '../ui/components.js';
import { LayerKit } from './layerkit.js';
import { ColorField } from './colorfield.js';
import { layerSlider, layerActions, blendChips } from './layerui.js';

export function open(ed, body) {
  let tab = 'font';
  const kit = LayerKit(ed, { types: ['text'], onSelect: () => render() });
  const cur = () => { const L = ed.sel && ed.layerById(ed.sel); return L && L.t === 'text' ? L : null; };
  const upd = (patch, commit = true, label) => { const L = cur(); if (L) ed.updateLayer(L.id, patch, commit, label || t('텍스트', 'Text')); };

  function addText() {
    ed.addLayer({ t: 'text', text: t('텍스트', 'Text'), size: 0.1, font: 'sans', color: '#ffffff', align: 'center', x: 0.5, y: 0.5, shadow: { on: true, blur: 0.02, dx: 0, dy: 0.008, color: 'rgba(0,0,0,.45)' } }, t('텍스트 추가', 'Add text'));
    render();
    ed.invalidateOverlay();
  }

  function render() {
    body.replaceChildren();
    ed.setPeek(false);
    const L = cur();
    const add = Btn(t('텍스트 추가', 'Add text'), L ? 'outlined' : 'filled', addText, 'type');
    if (!L) {
      body.append(h('p', { class: 'sheet-note' }, t('사진 위의 글자를 눌러 선택하거나 새 텍스트를 추가해요.', 'Tap text on the photo to select it, or add new text.')), add);
      ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
      return;
    }
    const ta = h('textarea', { class: 'field', rows: 2, value: L.text, 'aria-label': t('텍스트 내용', 'Text content'), placeholder: t('내용을 입력하세요', 'Enter text') });
    ta.addEventListener('input', () => upd({ text: ta.value }, false));
    ta.addEventListener('change', () => ed.commit(t('텍스트 편집', 'Edit text')));
    const seg = Segmented({ label: t('분류', 'Group'), items: [{ id: 'font', label: t('글꼴', 'Font') }, { id: 'color', label: t('색상', 'Color') }, { id: 'fx', label: t('효과', 'Effects') }, { id: 'place', label: t('배치', 'Place') }], value: tab, onChange: (v) => { tab = v; render(); } });
    body.append(ta, seg.el);
    const sec = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
    body.append(sec);
    const S = (o) => layerSlider(ed, L.id, o).el;

    if (tab === 'font') {
      const fonts = Chips({ label: t('글꼴', 'Font'), items: Object.entries(FONTS).map(([k, f]) => ({ id: k, label: t(f.ko, f.en) })), value: L.font || 'sans', onSelect: (k) => upd({ font: k }) });
      const styles = h('div', { class: 'chips wrap' });
      const tog = (key, ic, lab) => { const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(!!L[key]), 'aria-label': lab }, icon(ic, 'sm'), lab); b.addEventListener('click', () => { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on)); upd({ [key]: on }); }); return b; };
      styles.append(tog('bold', 'bold', t('굵게', 'Bold')), tog('italic', 'italic', t('기울임', 'Italic')), tog('underline', 'underline', t('밑줄', 'Underline')), tog('strike', 'strikethrough', t('취소선', 'Strike')));
      const align = Segmented({ label: t('정렬', 'Align'), items: [{ id: 'left', label: t('왼쪽', 'Left'), icon: 'align-left' }, { id: 'center', label: t('가운데', 'Center'), icon: 'align-center' }, { id: 'right', label: t('오른쪽', 'Right'), icon: 'align-right' }], value: L.align || 'center', onChange: (v) => upd({ align: v }) });
      sec.append(fonts.el, styles, align.el,
        S({ label: t('크기', 'Size'), min: 1, max: 80, def: 10, unit: '', get: (l) => Math.round(l.size * 100), set: (v) => ({ size: v / 100 }), bipolar: false }),
        S({ label: t('자간', 'Letter spacing'), min: -10, max: 50, def: 0, get: (l) => Math.round((l.spacing || 0) * 100), set: (v) => ({ spacing: v / 100 }) }),
        S({ label: t('줄 간격', 'Line height'), min: 80, max: 220, def: 125, unit: '%', get: (l) => Math.round((l.lineH || 1.25) * 100), set: (v) => ({ lineH: v / 100 }), bipolar: false }));
    } else if (tab === 'color') {
      const cf = ColorField(ed, { label: t('글자 색', 'Text color'), value: L.color || '#ffffff', onChange: (c, commit) => upd({ color: c }, commit) });
      const gradOn = Switch({ label: t('그라데이션', 'Gradient'), value: !!(L.grad && L.grad.on), onChange: (v) => { upd({ grad: { ...(L.grad || { color2: '#ff3b5c', angle: 90 }), on: v } }); render(); } });
      sec.append(cf.el, gradOn.el);
      if (L.grad && L.grad.on) {
        sec.append(ColorField(ed, { label: t('끝 색', 'End color'), value: L.grad.color2 || '#ff3b5c', onChange: (c, commit) => upd({ grad: { ...L.grad, color2: c } }, commit) }).el,
          S({ label: t('각도', 'Angle'), min: 0, max: 360, def: 90, unit: '°', get: (l) => (l.grad && l.grad.angle != null ? l.grad.angle : 90), set: (v, l) => ({ grad: { ...l.grad, angle: v } }), bipolar: false }));
      }
      sec.append(S({ label: t('투명도', 'Opacity'), min: 0, max: 100, def: 100, unit: '%', get: (l) => Math.round((l.opacity == null ? 1 : l.opacity) * 100), set: (v) => ({ opacity: v / 100 }), bipolar: false }));
    } else if (tab === 'fx') {
      const st = L.stroke || { w: 0, color: '#000000' };
      const sh = L.shadow || { on: false, blur: 0.02, dx: 0, dy: 0.008, color: 'rgba(0,0,0,.45)' };
      const bx = L.box || { on: false, color: '#000000', pad: 0.4, radius: 0.3 };
      sec.append(h('div', { class: 'sheet-sec' }, t('외곽선', 'Outline')),
        S({ label: t('굵기', 'Width'), min: 0, max: 30, def: 0, get: (l) => Math.round(((l.stroke && l.stroke.w) || 0) * 100), set: (v, l) => ({ stroke: { ...(l.stroke || { color: '#000000' }), w: v / 100 } }), bipolar: false }),
        ColorField(ed, { label: t('외곽선 색', 'Outline color'), value: st.color, colors: ['#000000', '#ffffff', '#ff3b30', '#0a84ff', '#ffcc00'], onChange: (c, commit) => upd({ stroke: { ...(cur().stroke || { w: 0.06 }), color: c, w: (cur().stroke && cur().stroke.w) || 0.06 } }, commit) }).el,
        h('div', { class: 'sheet-sec' }, t('그림자', 'Shadow')),
        Switch({ label: t('그림자 사용', 'Use shadow'), value: !!sh.on, onChange: (v) => { upd({ shadow: { ...sh, ...(cur().shadow || {}), on: v } }); } }).el,
        S({ label: t('번짐', 'Blur'), min: 0, max: 20, def: 2, get: (l) => Math.round(((l.shadow && l.shadow.blur != null ? l.shadow.blur : 0.02)) * 100), set: (v, l) => ({ shadow: { ...(l.shadow || { on: true }), on: true, blur: v / 100 } }), bipolar: false }),
        h('div', { class: 'sheet-sec' }, t('배경 상자', 'Background box')),
        Switch({ label: t('배경 상자 사용', 'Use box'), value: !!bx.on, onChange: (v) => { upd({ box: { ...bx, ...(cur().box || {}), on: v } }); render(); } }).el);
      if (bx.on) sec.append(ColorField(ed, { label: t('상자 색', 'Box color'), value: bx.color, onChange: (c, commit) => upd({ box: { ...cur().box, on: true, color: c } }, commit) }).el,
        S({ label: t('여백', 'Padding'), min: 0, max: 150, def: 40, unit: '', get: (l) => Math.round(((l.box && l.box.pad != null ? l.box.pad : 0.4)) * 100), set: (v, l) => ({ box: { ...l.box, on: true, pad: v / 100 } }), bipolar: false }),
        S({ label: t('모서리', 'Corner'), min: 0, max: 100, def: 30, get: (l) => Math.round(((l.box && l.box.radius != null ? l.box.radius : 0.3)) * 100), set: (v, l) => ({ box: { ...l.box, on: true, radius: v / 100 } }), bipolar: false }));
    } else {
      sec.append(S({ label: t('회전', 'Rotation'), min: -180, max: 180, def: 0, unit: '°', get: (l) => Math.round(l.rot || 0), set: (v) => ({ rot: v }) }),
        h('div', { class: 'sheet-sec' }, t('혼합 모드', 'Blend mode')), blendChips(ed, L.id).el, layerActions(ed, L.id, render));
    }
    ed.setActions([add, IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  }

  render();
  return {
    pointer: kit.pointer,
    drawOverlay: kit.drawOverlay,
    refresh: render,
    close() { ed.sel = null; },
  };
}
