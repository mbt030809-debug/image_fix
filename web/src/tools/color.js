// 색상: HSL(8색) / 컬러 그레이딩(스플릿 토닝) / 흑백 믹서
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { HSL_BANDS, hslToRgb255 } from '../engine/develop.js';
import { Slider, Chips, Segmented, Btn, IconBtn } from '../ui/components.js';

const BAND_NAMES = { red: ['빨강', 'Red'], orange: ['주황', 'Orange'], yellow: ['노랑', 'Yellow'], green: ['초록', 'Green'], aqua: ['청록', 'Aqua'], blue: ['파랑', 'Blue'], purple: ['보라', 'Purple'], magenta: ['분홍', 'Magenta'] };
const BAND_HUE = { red: 0, orange: 30, yellow: 58, green: 120, aqua: 180, blue: 225, purple: 270, magenta: 310 };
const HUE_GRAD = 'linear-gradient(to right,hsl(0 90% 55%),hsl(60 90% 55%),hsl(120 80% 45%),hsl(180 80% 45%),hsl(240 85% 60%),hsl(300 80% 55%),hsl(360 90% 55%))';

const GRADES = [
  ['teal', '틸&오렌지', 'Teal & orange', { splitHi: { h: 38, s: 46 }, splitLo: { h: 195, s: 52 } }],
  ['warm', '따뜻한 톤', 'Warm', { splitHi: { h: 42, s: 40 }, splitLo: { h: 18, s: 24 } }],
  ['cool', '차가운 톤', 'Cool', { splitHi: { h: 200, s: 30 }, splitLo: { h: 230, s: 40 } }],
  ['sunset', '노을', 'Sunset', { splitHi: { h: 30, s: 50 }, splitLo: { h: 300, s: 36 } }],
  ['forest', '숲', 'Forest', { splitHi: { h: 80, s: 34 }, splitLo: { h: 170, s: 38 } }],
  ['rose', '로즈', 'Rose', { splitHi: { h: 340, s: 34 }, splitLo: { h: 20, s: 22 } }],
];

export function open(ed, body) {
  let tab = 'hsl', band = 'red';
  const adj = () => ed.doc().adj;
  const setAdj = (patch, commit, label) => {
    ed.preview((d) => {
      const a = { ...d.adj, ...patch };
      for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
      return setIn(d, 'adj', a);
    });
    if (commit) ed.commit(label || t('색상', 'Color'));
  };
  const root = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  function render() {
    root.replaceChildren();
    const seg = Segmented({ label: t('분류', 'Group'), items: [{ id: 'hsl', label: 'HSL' }, { id: 'grade', label: t('컬러 그레이딩', 'Grading') }, { id: 'bw', label: t('흑백', 'B&W') }], value: tab, onChange: (v) => { tab = v; render(); } });
    root.append(seg.el);
    if (tab === 'hsl') renderHsl(); else if (tab === 'grade') renderGrade(); else renderBw();
  }

  function renderHsl() {
    const hsl = adj().hsl || {};
    const chips = Chips({ label: t('색상 범위', 'Color range'), items: HSL_BANDS.map((b) => ({ id: b, label: t(...BAND_NAMES[b]), mark: !!(hsl[b] && (hsl[b][0] || hsl[b][1] || hsl[b][2])) })), value: band, onSelect: (b) => { band = b; render(); } });
    for (const b of HSL_BANDS) { const bt = chips.btn(b); const [r, g, bl] = hslToRgb255(BAND_HUE[b], 0.85, 0.55); bt.style.borderLeft = `6px solid rgb(${r},${g},${bl})`; }
    root.append(chips.el);
    const v = hsl[band] || [0, 0, 0];
    const mk = (idx, label, grad) => Slider({ label, min: -100, max: 100, value: v[idx], def: 0, grad,
      onInput: (x) => setAdj({ hsl: { ...adj().hsl, [band]: Object.assign([...(adj().hsl && adj().hsl[band] || [0, 0, 0])], { [idx]: x }) } }, false),
      onChange: () => ed.commit(t('HSL', 'HSL')) }).el;
    const hc = BAND_HUE[band];
    root.append(mk(0, t('색조', 'Hue'), `linear-gradient(to right,hsl(${hc - 40} 85% 55%),hsl(${hc} 85% 55%),hsl(${hc + 40} 85% 55%))`),
      mk(1, t('채도', 'Saturation'), `linear-gradient(to right,hsl(${hc} 8% 55%),hsl(${hc} 95% 50%))`),
      mk(2, t('밝기', 'Luminance'), `linear-gradient(to right,hsl(${hc} 80% 15%),hsl(${hc} 80% 55%),hsl(${hc} 80% 90%))`));
  }

  function renderGrade() {
    const a = adj();
    const hi = a.splitHi || { h: 40, s: 0 }, lo = a.splitLo || { h: 220, s: 0 };
    const presets = Chips({ label: t('프리셋', 'Presets'), items: GRADES.map(([id, ko, en]) => ({ id, label: t(ko, en) })), onSelect: (id) => { const g = GRADES.find((x) => x[0] === id)[3]; setAdj({ splitHi: g.splitHi, splitLo: g.splitLo }, true, t('컬러 그레이딩', 'Grading')); render(); } });
    const sl = (label, getv, setv, min, max, def, grad, unit = '') => Slider({ label, min, max, value: getv(), def, unit, grad, bipolar: min < 0, onInput: (x) => setv(x, false), onChange: () => ed.commit(t('컬러 그레이딩', 'Grading')) }).el;
    root.append(presets.el,
      h('div', { class: 'sheet-sec' }, t('하이라이트', 'Highlights')),
      sl(t('색조', 'Hue'), () => hi.h, (x, c) => setAdj({ splitHi: { ...(adj().splitHi || { s: 30 }), h: x, s: (adj().splitHi && adj().splitHi.s) || 30 } }, c), 0, 360, 40, HUE_GRAD, '°'),
      sl(t('채도', 'Saturation'), () => hi.s, (x, c) => setAdj({ splitHi: { ...(adj().splitHi || { h: 40 }), s: x } }, c), 0, 100, 0, null),
      h('div', { class: 'sheet-sec' }, t('섀도', 'Shadows')),
      sl(t('색조', 'Hue'), () => lo.h, (x, c) => setAdj({ splitLo: { ...(adj().splitLo || { s: 30 }), h: x, s: (adj().splitLo && adj().splitLo.s) || 30 } }, c), 0, 360, 220, HUE_GRAD, '°'),
      sl(t('채도', 'Saturation'), () => lo.s, (x, c) => setAdj({ splitLo: { ...(adj().splitLo || { h: 220 }), s: x } }, c), 0, 100, 0, null),
      sl(t('균형', 'Balance'), () => a.splitBal || 0, (x, c) => setAdj({ splitBal: x || undefined }, c), -100, 100, 0, null));
  }

  function renderBw() {
    const a = adj();
    const mix = a.bwMix || [0, 0, 0];
    const sl = (label, getv, setv, min, max, def, grad) => Slider({ label, min, max, value: getv(), def, grad, bipolar: min < 0, unit: '', onInput: (x) => setv(x, false), onChange: () => ed.commit(t('흑백', 'B&W')) }).el;
    const setMix = (i, x, c) => { const m = [...(adj().bwMix || [0, 0, 0])]; m[i] = x; setAdj({ bwMix: m.every((v) => !v) ? undefined : m }, c); };
    root.append(sl(t('흑백 강도', 'B&W amount'), () => a.bw || 0, (x, c) => setAdj({ bw: x || undefined }, c), 0, 100, 0, null),
      h('div', { class: 'sheet-sec' }, t('채널 믹서', 'Channel mixer')),
      sl(t('빨강 채널', 'Red'), () => mix[0], (x, c) => setMix(0, x, c), -100, 100, 0, 'linear-gradient(to right,#300,#f55)'),
      sl(t('초록 채널', 'Green'), () => mix[1], (x, c) => setMix(1, x, c), -100, 100, 0, 'linear-gradient(to right,#030,#5d5)'),
      sl(t('파랑 채널', 'Blue'), () => mix[2], (x, c) => setMix(2, x, c), -100, 100, 0, 'linear-gradient(to right,#003,#58f)'),
      h('div', { class: 'row', style: { marginTop: '8px' } }, Btn(t('세피아 톤', 'Sepia tone'), 'outlined', () => { setAdj({ bw: 100, splitHi: { h: 42, s: 38 }, splitLo: { h: 28, s: 32 } }, true, t('세피아', 'Sepia')); render(); }),
        Btn(t('초기화', 'Reset'), 'outlined', () => { setAdj({ bw: undefined, bwMix: undefined, splitHi: undefined, splitLo: undefined, splitBal: undefined }, true, t('흑백 초기화', 'Reset')); render(); })));
  }

  ed.setPeek(false);
  body.append(root);
  render();
  ed.setActions([Btn(t('초기화', 'Reset'), 'text', () => { setAdj({ hsl: undefined, splitHi: undefined, splitLo: undefined, splitBal: undefined, bw: undefined, bwMix: undefined, hue: undefined }, true, t('색상 초기화', 'Reset color')); render(); }), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  return { refresh: render };
}
