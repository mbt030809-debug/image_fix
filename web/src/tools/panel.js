// 파라미터 패널(피크: 칩 + 슬라이더 1개 / 펼침: 그룹별 전체 슬라이더) — 조정·효과·로컬 보정에서 공용
import { h } from '../ui/dom.js';
import { t } from '../i18n.js';
import { Slider, Chips, Segmented } from '../ui/components.js';

/**
 * o.params: [{key, ko, en, min, max, def, step, unit, bipolar, group}]
 * o.groups: [{id, ko, en}] (선택)  o.get(key) → 값  o.set(key, value, commit)
 */
export function ParamPanel(ed, o) {
  const params = o.params;
  const label = (p) => t(p.ko, p.en);
  let sel = o.selected || params[0].key;
  let group = (o.groups && o.groups[0] && o.groups[0].id) || null;
  const root = h('div', { class: 'pp' });
  let sliders = new Map();
  let chips = null;
  let peekSlider = null;

  const val = (p) => { const v = o.get(p.key); return v == null ? p.def : v; };
  const mk = (p) => Slider({
    label: label(p), min: p.min, max: p.max, step: p.step || 1, def: p.def, value: val(p), unit: p.unit || '', bipolar: p.bipolar != null ? p.bipolar : p.min < 0,
    fmt: p.fmt, onInput: (v) => { o.set(p.key, v, false); updateChip(p); }, onChange: (v) => { o.set(p.key, v, true); updateChip(p); },
  });
  const updateChip = (p) => { if (chips) { chips.setMark(p.key, val(p) !== p.def); } };

  function renderPeek() {
    root.replaceChildren();
    sliders = new Map();
    chips = Chips({ label: t('항목', 'Item'), items: params.map((p) => ({ id: p.key, label: label(p), mark: val(p) !== p.def })), value: sel, onSelect: (id) => { sel = id; renderSlider(); } });
    root.append(chips.el, h('div', { class: 'pp-slot' }));
    renderSlider();
  }
  function renderSlider() {
    const slot = root.querySelector('.pp-slot');
    slot.replaceChildren();
    const p = params.find((x) => x.key === sel) || params[0];
    peekSlider = mk(p);
    sliders.set(p.key, peekSlider);
    slot.append(peekSlider.el);
    if (p.hint) slot.append(h('p', { class: 'sheet-note' }, t(p.hint[0], p.hint[1])));
  }
  function renderFull() {
    root.replaceChildren();
    sliders = new Map(); chips = null;
    let list = params;
    if (o.groups) {
      const seg = Segmented({ label: t('분류', 'Group'), items: o.groups.map((g) => ({ id: g.id, label: t(g.ko, g.en) })), value: group, onChange: (id) => { group = id; renderFull(); } });
      root.append(seg.el);
      list = params.filter((p) => p.group === group);
    }
    for (const p of list) { const s = mk(p); sliders.set(p.key, s); root.append(h('div', { style: { marginTop: '8px' } }, s.el)); }
  }

  const api = {
    el: root,
    render(peek) { if (peek) renderPeek(); else renderFull(); api.peek = peek; },
    refresh() {
      for (const p of params) { const s = sliders.get(p.key); if (s) s.set(val(p)); }
      if (chips) for (const p of params) chips.setMark(p.key, val(p) !== p.def);
    },
    select(key) { sel = key; if (api.peek) renderPeek(); },
    peek: true,
  };
  api.render(true);
  return api;
}
