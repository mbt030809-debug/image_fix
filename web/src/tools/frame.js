// 프레임: 프리셋 + 여백·모서리·그림자·색상·배경(단색/블러/그라데이션)·비율
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { FRAME_PRESETS, applyFrame } from '../compose.js';
import { Slider, Chips, Segmented, Btn, IconBtn } from '../ui/components.js';
import { ColorField } from './colorfield.js';

const ASPECTS = [['free', '자유', 'Free'], ['1:1', '1:1', '1:1'], ['4:5', '4:5', '4:5'], ['3:4', '3:4', '3:4'], ['9:16', '9:16', '9:16'], ['16:9', '16:9', '16:9'], ['4:3', '4:3', '4:3']];

function thumbCanvas(src, preset) {
  const cv = h('canvas', { width: 96, height: 96, 'aria-hidden': 'true' });
  const c = cv.getContext('2d');
  const k = 64 / Math.max(src.width, src.height);
  const small = document.createElement('canvas'); small.width = Math.max(8, Math.round(src.width * k)); small.height = Math.max(8, Math.round(src.height * k));
  small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
  let out = small;
  if (preset.p) out = applyFrame(small, preset.p);
  const s = Math.min(88 / out.width, 88 / out.height);
  c.fillStyle = 'rgba(128,128,128,.18)'; c.fillRect(0, 0, 96, 96);
  c.drawImage(out, (96 - out.width * s) / 2, (96 - out.height * s) / 2, out.width * s, out.height * s);
  return cv;
}

export function open(ed, body) {
  const get = () => ed.doc().frame;
  const base = () => get() || { pad: 0, bottom: 0, color: '#ffffff', color2: '#fad0c4', radius: 0, shadow: 0, bg: 'color', aspect: 'free' };
  const set = (patch, commit) => {
    ed.preview((d) => setIn(d, 'frame', { ...(d.frame || { pad: 0, bottom: 0, color: '#ffffff', color2: '#fad0c4', radius: 0, shadow: 0, bg: 'color', aspect: 'free' }), ...patch }));
    if (commit) ed.commit(t('프레임', 'Frame'));
  };
  const row = h('div', { class: 'thumbs', role: 'radiogroup', 'aria-label': t('프레임', 'Frames') });
  const src = ed.baseCanvas;
  let curId = null;
  function renderRow() {
    row.replaceChildren();
    for (const p of FRAME_PRESETS) {
      const b = h('button', { class: 'thumb', type: 'button', role: 'radio', 'aria-checked': String(curId === p.id), 'data-id': p.id, 'aria-label': t(p.ko, p.en) }, thumbCanvas(src, p), h('span', { class: 'tchk' }, icon('check')), h('span', { class: 'tl' }, t(p.ko, p.en)));
      b.addEventListener('click', () => {
        curId = p.id;
        ed.apply((d) => setIn(d, 'frame', p.p ? { ...p.p } : null), t('프레임', 'Frame'));
        for (const x of row.querySelectorAll('.thumb')) x.setAttribute('aria-checked', String(x.dataset.id === p.id));
        renderControls();
      });
      row.append(b);
    }
  }
  const ctl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  function renderControls() {
    ctl.replaceChildren();
    const f = get();
    if (!f) { ctl.append(h('p', { class: 'sheet-note' }, t('프리셋을 고르면 세부 설정이 나타나요.', 'Pick a preset to fine-tune it.'))); return; }
    const S = (label, key, min, max, def, unit = '') => Slider({ label, min, max, value: f[key] == null ? def : f[key], def, unit, bipolar: false, onInput: (v) => set({ [key]: v }, false), onChange: () => ed.commit(t('프레임', 'Frame')) }).el;
    const bg = Segmented({ label: t('배경', 'Background'), items: [{ id: 'color', label: t('단색', 'Solid') }, { id: 'blur', label: t('블러', 'Blur') }, { id: 'gradient', label: t('그라데이션', 'Gradient') }, { id: 'none', label: t('투명', 'None') }], value: f.bg || 'color', onChange: (v) => { set({ bg: v }, true); renderControls(); } });
    const asp = Chips({ label: t('비율', 'Aspect'), items: ASPECTS.map(([id, ko, en]) => ({ id, label: t(ko, en) })), value: f.aspect || 'free', onSelect: (id) => set({ aspect: id }, true) });
    ctl.append(S(t('여백', 'Padding'), 'pad', 0, 30, 4, '%'), S(t('아래 여백', 'Bottom padding'), 'bottom', 0, 30, 0, '%'), S(t('모서리', 'Corner radius'), 'radius', 0, 50, 0, '%'), S(t('그림자', 'Shadow'), 'shadow', 0, 100, 0, '%'),
      h('div', { class: 'sheet-sec' }, t('배경', 'Background')), bg.el);
    if ((f.bg || 'color') !== 'blur' && f.bg !== 'none') ctl.append(ColorField(ed, { label: f.bg === 'gradient' ? t('시작 색', 'Start color') : t('색상', 'Color'), value: f.color || '#ffffff', onChange: (c, commit) => set({ color: c }, commit) }).el);
    if (f.bg === 'gradient') ctl.append(ColorField(ed, { label: t('끝 색', 'End color'), value: f.color2 || '#fad0c4', onChange: (c, commit) => set({ color2: c }, commit) }).el);
    ctl.append(h('div', { class: 'sheet-sec' }, t('캔버스 비율', 'Canvas ratio')), asp.el);
  }
  const f0 = get();
  if (f0) { const m = FRAME_PRESETS.find((p) => p.p && JSON.stringify(p.p) === JSON.stringify(f0)); curId = m ? m.id : null; } else curId = 'none';
  ed.setPeek(false);
  body.append(row, ctl);
  renderRow(); renderControls();
  ed.setActions([Btn(t('초기화', 'Reset'), 'text', () => { ed.apply((d) => setIn(d, 'frame', null), t('프레임 제거', 'Remove frame')); curId = 'none'; renderRow(); renderControls(); }), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  return { refresh() { renderRow(); renderControls(); } };
}
