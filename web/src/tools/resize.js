// 크기: 출력 크기(가로×세로 px · 배율) + SNS/화면/인쇄·증명 프리셋 + 맞춤 방식(채우기·여백·늘이기)
// doc.out = {w,h,fit:'fill'|'fit'|'stretch', bg:'blur'|'color', color}. 채우기는 자르기 영역을, 여백은 프레임 비율을 자동으로 맞춰 미리보기와 저장 결과가 같다.
import { h } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { Chips, Segmented, Slider, Switch, Btn, IconBtn } from '../ui/components.js';
import { orientedSize, fitCropInside } from '../engine/geometry.js';
import { ColorField } from './colorfield.js';

export const SIZE_PRESETS = [
  ['소셜 미디어', 'Social', [
    ['인스타 1:1', 'Instagram 1:1', 1080, 1080], ['인스타 4:5', 'Instagram 4:5', 1080, 1350], ['스토리·릴스 9:16', 'Story / Reels', 1080, 1920],
    ['인스타 가로', 'Instagram wide', 1080, 566], ['유튜브 썸네일', 'YouTube thumbnail', 1280, 720], ['페이스북 커버', 'Facebook cover', 820, 312],
    ['X 헤더 3:1', 'X header 3:1', 1500, 500], ['카카오톡 프로필', 'KakaoTalk profile', 640, 640]]],
  ['화면', 'Screen', [
    ['HD', 'HD', 1280, 720], ['FHD', 'Full HD', 1920, 1080], ['QHD', 'QHD', 2560, 1440], ['4K UHD', '4K UHD', 3840, 2160], ['휴대폰 배경', 'Phone wallpaper', 1080, 2400]]],
  ['인쇄·증명 (300dpi)', 'Print / ID (300 dpi)', [
    ['여권사진 3.5×4.5cm', 'Passport 3.5×4.5 cm', 413, 531], ['증명사진 3×4cm', 'ID 3×4 cm', 354, 472], ['4×6인치', '4×6 in', 1200, 1800], ['5×7인치', '5×7 in', 1500, 2100], ['A4', 'A4', 2480, 3508]]],
];

const clampPx = (v) => Math.max(16, Math.min(8192, Math.round(v) || 0));

/** 현재 자르기 영역을 중심 기준으로 목표 비율(px w/h)에 맞게 다듬기 */
export function cropToAspect(geo, crop, asp, Ws, Hs) {
  const [Wo, Ho] = orientedSize(Ws, Hs, geo);
  const cw = crop[2] * Wo, ch = crop[3] * Ho;
  let nw = cw, nh = ch;
  if (cw / ch > asp) nw = ch * asp; else nh = cw / asp;
  const cx = crop[0] + crop[2] / 2, cy = crop[1] + crop[3] / 2;
  return fitCropInside(geo, [cx - nw / Wo / 2, cy - nh / Ho / 2, nw / Wo, nh / Ho], Ws, Hs);
}

/** 기존 문서에 out 설정을 반영한 새 문서 */
export function applyOut(d, out, info) {
  let nd = { ...d, out };
  const wasResizeFrame = d.frame && d.frame.fromResize;
  if (!out) return wasResizeFrame ? { ...nd, frame: null } : nd;
  if (out.fit === 'fill') {
    nd = setIn(nd, 'geo', { ...d.geo, crop: cropToAspect(d.geo, d.geo.crop, out.w / out.h, info.w, info.h) });
    if (wasResizeFrame) nd = { ...nd, frame: null };
  } else if (out.fit === 'fit') {
    const f = d.frame || {};
    nd = { ...nd, frame: { pad: wasResizeFrame ? 0 : f.pad || 0, bottom: 0, radius: f.radius || 0, shadow: f.shadow || 0, color: out.bg === 'color' ? out.color : f.color || '#000000', color2: f.color2 || '#fad0c4', bg: out.bg === 'color' ? 'color' : 'blur', aspect: `${out.w}:${out.h}`, fromResize: true } };
  } else if (wasResizeFrame) nd = { ...nd, frame: null };
  return nd;
}

export function open(ed, body) {
  const info = ed.info, doc0 = ed.store.getBase();
  const [Wo, Ho] = orientedSize(info.w, info.h, doc0.geo);
  const baseW = Math.max(1, Math.round(doc0.geo.crop[2] * Wo)), baseH = Math.max(1, Math.round(doc0.geo.crop[3] * Ho));
  const o0 = doc0.out;
  const st = { w: o0 ? o0.w : baseW, h: o0 ? o0.h : baseH, fit: o0 ? o0.fit : 'fill', bg: (o0 && o0.bg) || 'blur', color: (o0 && o0.color) || '#000000', lock: true, ratio: o0 ? o0.w / o0.h : baseW / baseH, preset: null };
  let changed = false;
  const wEl = h('input', { class: 'field num', type: 'text', inputMode: 'numeric', 'aria-label': t('가로(px)', 'Width (px)'), value: String(st.w) });
  const hEl = h('input', { class: 'field num', type: 'text', inputMode: 'numeric', 'aria-label': t('세로(px)', 'Height (px)'), value: String(st.h) });
  const info1 = h('p', { class: 'sheet-note num' });
  const pct = Slider({ label: t('배율', 'Scale'), min: 10, max: 300, value: 100, def: 100, unit: '%', bipolar: false, onInput: (v) => { st.w = clampPx((baseW * v) / 100); st.h = clampPx((baseH * v) / 100); st.ratio = baseW / baseH; st.preset = null; sync(); push(); }, onChange: () => {} });
  const lock = Switch({ label: t('가로세로 비율 고정', 'Lock aspect ratio'), value: true, onChange: (v) => { st.lock = v; if (v) st.ratio = st.w / st.h; } });
  const bgBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  function sync() {
    wEl.value = String(st.w); hEl.value = String(st.h);
    const fitTxt = st.fit === 'fill' ? t('채우기', 'Fill') : st.fit === 'fit' ? t('여백 채움', 'Fit with bars') : t('늘이기', 'Stretch');
    info1.textContent = `${baseW}×${baseH} → ${st.w}×${st.h} px (${fitTxt})`;
  }
  const build = (d) => applyOut(d, { w: st.w, h: st.h, fit: st.fit, bg: st.bg, color: st.color }, info);
  function push() { changed = true; ed.preview(build); }

  const presetBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const presetChipRefs = [];
  SIZE_PRESETS.forEach(([gk, ge, list], gi) => {
    const chips = Chips({ label: t(gk, ge), items: list.map(([ko, en, w, hh], i) => ({ id: gi + ':' + i, label: `${t(ko, en)}  ${w}×${hh}` })), wrap: true,
      onSelect: (id) => { const [g, i] = id.split(':').map(Number); const [, , w, hh] = SIZE_PRESETS[g][2][i]; st.w = w; st.h = hh; st.ratio = w / hh; st.preset = id; for (const c of presetChipRefs) if (c !== chips) c.set(null); pct.set(100); sync(); push(); } });
    presetChipRefs.push(chips);
    presetBox.append(h('div', { class: 'sheet-sec', style: { marginTop: '8px' } }, t(gk, ge)), chips.el);
  });

  wEl.addEventListener('change', () => { st.w = clampPx(parseInt(wEl.value, 10)); if (st.lock) st.h = clampPx(st.w / st.ratio); else st.ratio = st.w / st.h; st.preset = null; sync(); push(); });
  hEl.addEventListener('change', () => { st.h = clampPx(parseInt(hEl.value, 10)); if (st.lock) st.w = clampPx(st.h * st.ratio); else st.ratio = st.w / st.h; st.preset = null; sync(); push(); });

  const fit = Segmented({ label: t('맞춤 방식', 'Fit mode'), items: [{ id: 'fill', label: t('채우기', 'Fill') }, { id: 'fit', label: t('여백', 'Bars') }, { id: 'stretch', label: t('늘이기', 'Stretch') }], value: st.fit, onChange: (v) => { st.fit = v; renderBg(); sync(); push(); } });
  const hint = h('p', { class: 'sheet-note' });
  function renderBg() {
    hint.textContent = st.fit === 'fill' ? t('비율이 다르면 가운데를 기준으로 잘라 크기를 꽉 채워요. 자르기 도구로 위치를 다시 조절할 수 있어요.', 'If the ratio differs, the photo is cropped around the center to fill the size. Adjust it later with Crop.')
      : st.fit === 'fit' ? t('사진 전체를 유지하고 남는 곳은 배경으로 채워요.', 'Keeps the whole photo and fills the rest with a background.') : t('사진을 가로·세로로 따로 늘려 크기를 맞춰요 (모양이 변할 수 있어요).', 'Scales width and height separately (the shape may distort).');
    bgBox.replaceChildren();
    if (st.fit !== 'fit') return;
    bgBox.append(Chips({ label: t('여백 배경', 'Bar background'), items: [{ id: 'blur', label: t('흐린 사진', 'Blurred photo') }, { id: 'color', label: t('단색', 'Solid') }], value: st.bg, onSelect: (v) => { st.bg = v; renderBg(); push(); } }).el);
    if (st.bg === 'color') bgBox.append(ColorField(ed, { label: t('배경 색', 'Background color'), value: st.color, onChange: (c, commit) => { st.color = c; push(); } }).el);
  }

  ed.setPeek(false);
  body.append(info1, presetBox, h('div', { class: 'sheet-sec' }, t('직접 입력', 'Custom size')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'sheet-note' }, t('가로 (px)', 'Width (px)')), wEl), h('span', { class: 'sheet-note', style: { paddingTop: '20px' } }, '×'), h('div', { class: 'grow' }, h('div', { class: 'sheet-note' }, t('세로 (px)', 'Height (px)')), hEl)),
    lock.el, pct.el, h('div', { class: 'sheet-sec' }, t('맞춤 방식', 'Fit mode')), fit.el, hint, bgBox);
  sync(); renderBg();
  ed.setActions([
    Btn(t('지정 해제', 'Clear'), 'text', () => { ed.store.revert(); ed.apply((d) => applyOut(d, null, info), t('크기 해제', 'Clear size')); changed = false; st.w = baseW; st.h = baseH; sync(); }),
    IconBtn('x', t('취소', 'Cancel'), () => ed.closeTool(false)),
    IconBtn('check', t('적용', 'Apply'), () => ed.closeTool(true), 'tint'),
  ]);

  return {
    apply() { if (changed) ed.commit(t('크기', 'Size')); else ed.store.revert(); },
    cancel() { ed.store.revert(); },
    refresh() {},
  };
}
