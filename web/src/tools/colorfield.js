// 색 선택 필드: 빠른 스와치 + 직접 선택(모달 피커) + 스포이트 + 최근 색
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { Swatches, ColorPicker, openModal, Btn, IconBtn, toast } from '../ui/components.js';
import { PALETTE } from '../ui/color.js';

export function ColorField(ed, o) {
  let value = o.value || '#ffffff';
  const recent = () => (ed.app.settings.recent || []).slice(0, 8);
  const sw = Swatches({ colors: o.colors || PALETTE.slice(0, 10), value, label: o.label, onSelect: (c) => { value = c; o.onChange(c, true); }, onCustom: () => openCustom() });
  const root = h('div', null, o.label ? h('div', { class: 'sheet-sec', style: { marginTop: '0' } }, o.label) : null, sw.el);

  function openCustom() {
    let cur = value;
    const picker = ColorPicker({ value, onEyedropper: o.eyedropper === false ? null : (apply) => { m.close(); ed.pickColorFromCanvas((c) => { if (c) { value = c; sw.set(c); o.onChange(c, true); remember(c); } }); }, onChange: (c, commit) => { cur = c; value = c; sw.set(c); o.onChange(c, !!commit); } });
    const m = openModal({ title: o.label || t('색상', 'Color'), build: (body, close) => {
      body.append(picker.el);
      const rec = recent();
      if (rec.length) {
        const row = h('div', { class: 'swatches' });
        for (const c of rec) { const b = h('button', { class: 'swatch', type: 'button', 'aria-label': c, style: { background: c } }); b.addEventListener('click', () => { picker.set(c, true); }); row.append(b); }
        body.append(h('div', { class: 'sheet-sec' }, t('최근 색', 'Recent')), row);
      }
      body.append(h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, Btn(t('완료', 'Done'), 'tonal', () => { remember(cur); close(); })));
    }, onClose: () => { remember(cur); } });
  }
  function remember(c) {
    const s = ed.app.settings;
    s.recent = [c, ...(s.recent || []).filter((x) => x !== c)].slice(0, 8);
    ed.app.saveSettings();
  }
  return { el: root, set(c) { value = c; sw.set(c); }, get: () => value };
}
