// 필터: 카테고리 + 썸네일 + 강도, 나의 프리셋, .cube LUT 가져오기
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { FILTERS, FILTER_CATS } from '../engine/filters.js';
import { Slider, Chips, Btn, IconBtn, toast, openModal } from '../ui/components.js';
import { parseCube } from '../engine/lut.js';
import { bridge } from '../bridge.js';

function drawThumb(cv, item) {
  const tmp = document.createElement('canvas'); tmp.width = item.w; tmp.height = item.h;
  tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(item.d), item.w, item.h), 0, 0);
  const c = cv.getContext('2d');
  const k = Math.max(cv.width / item.w, cv.height / item.h);
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(tmp, (cv.width - item.w * k) / 2, (cv.height - item.h * k) / 2, item.w * k, item.h * k);
}

export function open(ed, body) {
  let cat = 'all';
  const row = h('div', { class: 'thumbs', role: 'radiogroup', 'aria-label': t('필터', 'Filters') });
  const cur = () => ed.doc().filter || { id: 'none', amt: 100 };
  let thumbData = new Map();
  let geoKey = '';
  let token = 0;

  const amt = Slider({ label: t('강도', 'Intensity'), min: 0, max: 100, value: cur().amt == null ? 100 : cur().amt, def: 100, bipolar: false, unit: '%',
    onInput: (v) => ed.preview((d) => setIn(d, 'filter', { ...cur0(d), amt: v })),
    onChange: () => ed.commit(t('필터 강도', 'Filter intensity')) });
  const cur0 = (d) => d.filter || { id: 'none', amt: 100 };

  const catChips = Chips({ label: t('분류', 'Category'), items: [{ id: 'all', label: t('전체', 'All') }, ...FILTER_CATS.map(([id, ko]) => ({ id, label: ko }))], value: 'all', onSelect: (id) => { cat = id; renderRow(); } });

  function visible() {
    const list = FILTERS.filter((f) => cat === 'all' || f.cat === cat);
    return [{ id: 'none', ko: '원본', en: 'Original' }, ...list];
  }
  function renderRow() {
    row.replaceChildren();
    for (const f of visible()) {
      const cv = h('canvas', { width: 96, height: 96, 'aria-hidden': 'true' });
      const b = h('button', { class: 'thumb', type: 'button', role: 'radio', 'aria-checked': String(cur().id === f.id), 'data-id': f.id, 'aria-label': t(f.ko, f.en) }, cv, h('span', { class: 'tchk' }, icon('check')), h('span', { class: 'tl' }, t(f.ko, f.en)));
      b.addEventListener('click', () => select(f.id));
      const item = thumbData.get(f.id); if (item) drawThumb(cv, item);
      row.append(b);
    }
  }
  function select(id) {
    const c = cur();
    ed.apply((d) => setIn(d, 'filter', { id, amt: id === 'none' ? 100 : (c.id === 'none' ? 100 : (c.amt == null ? 100 : c.amt)) }), id === 'none' ? t('필터 해제', 'Remove filter') : t('필터', 'Filter'));
    amt.set(ed.doc().filter.amt);
    for (const b of row.querySelectorAll('.thumb')) b.setAttribute('aria-checked', String(b.dataset.id === id));
    amt.el.hidden = id === 'none';
    ed.announce(id === 'none' ? t('필터 없음', 'No filter') : t(FILTERS.find((x) => x.id === id).ko, FILTERS.find((x) => x.id === id).en));
  }
  async function loadThumbs() {
    const d = ed.doc();
    const key = JSON.stringify([d.geo, d.retouch]);
    if (key === geoKey && thumbData.size) return;
    geoKey = key;
    const my = ++token;
    try {
      const list = await ed.engine.thumbs({ geo: d.geo, retouch: d.retouch }, ['none', ...FILTERS.map((f) => f.id)], 96);
      if (my !== token) return;
      thumbData = new Map(list.map((x) => [x.id, x]));
      for (const b of row.querySelectorAll('.thumb')) { const it = thumbData.get(b.dataset.id); if (it) drawThumb(b.querySelector('canvas'), it); }
    } catch (e) { console.error(e); }
  }

  // 나의 프리셋 -----------------------------------------------------
  const presetRow = h('div');
  function renderPresets() {
    presetRow.replaceChildren();
    const list = ed.app.settings.presets || [];
    if (!list.length) return;
    const chips = Chips({ label: t('나의 프리셋', 'My presets'), items: list.map((p) => ({ id: p.id, label: p.name })), onSelect: (id) => {
      const p = list.find((x) => x.id === id); if (!p) return;
      ed.apply((d) => ({ ...d, adj: { ...p.adj }, filter: { ...p.filter } }), t('프리셋 적용', 'Apply preset'));
      amt.set(ed.doc().filter.amt == null ? 100 : ed.doc().filter.amt);
      renderRow();
    } });
    presetRow.append(h('div', { class: 'sheet-sec' }, t('나의 프리셋', 'My presets')), chips.el);
  }
  const savePreset = IconBtn('bookmark', t('현재 설정을 프리셋으로 저장', 'Save current look as preset'), () => {
    const d = ed.doc();
    const name = h('input', { class: 'field', type: 'text', placeholder: t('프리셋 이름', 'Preset name'), maxLength: 20, 'aria-label': t('프리셋 이름', 'Preset name') });
    const m = openModal({ title: t('프리셋 저장', 'Save preset'), build: (b, close) => {
      b.append(name, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, Btn(t('취소', 'Cancel'), 'text', close), Btn(t('저장', 'Save'), 'tonal', () => {
        const nm = name.value.trim() || t('내 프리셋', 'My preset');
        const s = ed.app.settings; s.presets = [...(s.presets || []), { id: 'p' + Date.now(), name: nm, adj: { ...d.adj }, filter: { ...d.filter } }].slice(-20);
        ed.app.saveSettings(); renderPresets(); close(); toast(t('프리셋을 저장했어요', 'Preset saved'));
      }))); setTimeout(() => name.focus(), 50);
    } });
    void m;
  });

  // LUT ---------------------------------------------------------------
  const lutRow = h('div');
  async function importLut() {
    const files = await bridge.pickFile('.cube,.txt');
    if (!files.length) return;
    try {
      const lut = parseCube(await files[0].text());
      const key = 'lut-' + Date.now();
      await ed.engine.setAsset(key, 'lut', { size: lut.size, buffer: lut.data.buffer });
      ed.apply((d) => ({ ...d, lutRef: { key, amt: 100, name: files[0].name } }), t('LUT 적용', 'Apply LUT'));
      renderLut();
    } catch (e) { toast(String(e.message || e)); }
  }
  function renderLut() {
    lutRow.replaceChildren();
    const lr = ed.doc().lutRef;
    if (!lr) { lutRow.append(Btn(t('LUT 가져오기 (.cube)', 'Import LUT (.cube)'), 'outlined', importLut, 'upload')); return; }
    lutRow.append(h('div', { class: 'sheet-sec' }, 'LUT · ' + lr.name),
      Slider({ label: t('LUT 강도', 'LUT intensity'), min: 0, max: 100, value: lr.amt, def: 100, bipolar: false, unit: '%', onInput: (v) => ed.preview((d) => setIn(d, 'lutRef', { ...d.lutRef, amt: v })), onChange: () => ed.commit(t('LUT 강도', 'LUT intensity')) }).el,
      Btn(t('LUT 제거', 'Remove LUT'), 'text', () => { ed.apply((d) => ({ ...d, lutRef: null }), t('LUT 제거', 'Remove LUT')); renderLut(); }));
  }

  ed.setPeek(false);
  body.append(catChips.el, row, amt.el, presetRow, lutRow);
  ed.setActions([savePreset, Btn(t('초기화', 'Reset'), 'text', () => { ed.apply((d) => ({ ...d, filter: { id: 'none', amt: 100 }, lutRef: null }), t('필터 초기화', 'Reset filter')); amt.set(100); renderRow(); renderLut(); })]);
  amt.el.hidden = cur().id === 'none';
  renderRow(); renderPresets(); renderLut();
  loadThumbs();

  return {
    refresh() { amt.set(cur().amt == null ? 100 : cur().amt); amt.el.hidden = cur().id === 'none'; renderRow(); renderLut(); },
    onPeek() {},
  };
}
