// 레이어 공통 컨트롤 (회전/투명도/순서/복제/삭제) — 텍스트·스티커 도구에서 공유
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { Slider, IconBtn, Chips } from '../ui/components.js';

export const BLENDS = [['normal', '일반', 'Normal'], ['multiply', '곱하기', 'Multiply'], ['screen', '스크린', 'Screen'], ['overlay', '오버레이', 'Overlay'], ['soft-light', '소프트 라이트', 'Soft light'], ['hard-light', '하드 라이트', 'Hard light'], ['darken', '어둡게', 'Darken'], ['lighten', '밝게', 'Lighten'], ['color-dodge', '컬러 닷지', 'Color dodge'], ['difference', '차이', 'Difference'], ['hue', '색조', 'Hue'], ['luminosity', '휘도', 'Luminosity']];

/** 레이어 속성 슬라이더 */
export function layerSlider(ed, id, o) {
  const L = ed.layerById(id);
  return Slider({
    label: o.label, min: o.min, max: o.max, step: o.step || 1, def: o.def, unit: o.unit || '', bipolar: o.bipolar,
    value: o.get(L),
    onInput: (v) => ed.updateLayer(id, o.set(v, ed.layerById(id)), false),
    onChange: () => ed.commit(o.label),
  });
}

export function layerActions(ed, id, onChange) {
  const row = h('div', { class: 'row', style: { gap: '0', justifyContent: 'space-between' } },
    IconBtn('arrow-up', t('앞으로', 'Bring forward'), () => { ed.moveLayer(id, 1); onChange && onChange(); }),
    IconBtn('arrow-down', t('뒤로', 'Send backward'), () => { ed.moveLayer(id, -1); onChange && onChange(); }),
    IconBtn('copy', t('복제', 'Duplicate'), () => { ed.duplicateLayer(id); onChange && onChange(); }),
    IconBtn('lock', t('잠금', 'Lock'), () => { const L = ed.layerById(id); ed.updateLayer(id, { lock: !L.lock }, true, t('잠금', 'Lock')); onChange && onChange(); }),
    IconBtn('trash-2', t('삭제', 'Delete'), () => { ed.removeLayer(id); onChange && onChange(); }));
  return row;
}

export function blendChips(ed, id) {
  const L = ed.layerById(id);
  return Chips({ label: t('혼합 모드', 'Blend mode'), items: BLENDS.map(([k, ko, en]) => ({ id: k, label: t(ko, en) })), value: L.blend || 'normal', onSelect: (k) => ed.updateLayer(id, { blend: k }, true, t('혼합 모드', 'Blend mode')) });
}
