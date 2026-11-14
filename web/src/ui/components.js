// 재사용 UI 컴포넌트: 슬라이더, 칩, 세그먼트, 스위치, 다이얼로그, 모달 시트, 스낵바, 컬러 피커
import { h, icon, clear, reducedMotion } from './dom.js';
import { t } from '../i18n.js';
import { bridge } from '../bridge.js';
import { hexToHsv, hsvToHex, hsvToRgb, hexToRgb, rgbToHex, PALETTE } from './color.js';

// ------------------------------------------------------------ 뒤로가기 스택
const backStack = [];
export function pushBack(fn) { backStack.push(fn); return () => { const i = backStack.lastIndexOf(fn); if (i >= 0) backStack.splice(i, 1); }; }
export function handleBack() {
  const fn = backStack[backStack.length - 1];
  if (!fn) return false;
  fn();
  return true;
}

// ------------------------------------------------------------ 슬라이더
let lastHaptic = 0;
export function Slider(o) {
  const { label, min = -100, max = 100, step = 1, def = 0, unit = '', grad = null, fmt = null, snap = true } = o;
  const bipolar = o.bipolar != null ? o.bipolar : min < 0;
  let value = o.value == null ? def : o.value;
  const format = (v) => (fmt ? fmt(v) : (bipolar && v > 0 ? '+' : '') + (Math.abs(step) < 1 ? v.toFixed(1) : String(Math.round(v))) + unit);
  const input = h('input', { type: 'range', class: 'slider', min, max, step, value, 'aria-label': label });
  const valEl = h('button', { class: 'val', 'aria-label': label + ' ' + t('값 입력', 'enter value') }, format(value));
  const bubble = h('div', { class: 'bubble', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'sl' + (grad ? ' grad' : '') }, input, bipolar ? h('div', { class: 'tick' }) : null, bubble);
  if (grad) wrap.style.setProperty('--grad', grad);
  const nameEl = h('span', { class: 'name' }, label);
  const root = h('div', { class: 'srow' }, h('div', { class: 'lab' }, nameEl, valEl), wrap);
  let hideT = 0;

  function paint(v) {
    const p = (v - min) / (max - min || 1);
    const p0 = bipolar ? (def - min) / (max - min || 1) : 0;
    wrap.style.setProperty('--p', p);
    input.style.setProperty('--sa', Math.min(p, p0));
    input.style.setProperty('--sb', Math.max(p, p0));
    const txt = format(v);
    valEl.textContent = txt; bubble.textContent = txt;
    valEl.classList.toggle('mod', v !== def);
    input.setAttribute('aria-valuetext', txt);
  }
  paint(value);

  input.addEventListener('input', () => {
    let v = +input.value;
    if (bipolar && snap && v !== def && Math.abs(v - def) <= (max - min) * 0.012) { v = def; input.value = v; }
    if (v === def && value !== def && Date.now() - lastHaptic > 120) { lastHaptic = Date.now(); bridge.haptic(); }
    value = v; paint(v);
    o.onInput && o.onInput(v);
  });
  input.addEventListener('change', () => { value = +input.value; paint(value); o.onChange && o.onChange(value); });
  const down = () => { clearTimeout(hideT); wrap.classList.add('drag'); };
  const up = () => { clearTimeout(hideT); hideT = setTimeout(() => wrap.classList.remove('drag'), 400); };
  input.addEventListener('pointerdown', down);
  input.addEventListener('pointerup', up);
  input.addEventListener('pointercancel', up);
  input.addEventListener('blur', up);

  function setValue(v, emit) {
    value = Math.max(min, Math.min(max, v));
    input.value = value; paint(value);
    if (emit) { o.onInput && o.onInput(value); o.onChange && o.onChange(value); }
  }
  // 값을 눌러 직접 입력 (드래그 대안)
  valEl.addEventListener('click', () => {
    const f = h('input', { class: 'numfield', type: 'text', inputMode: 'decimal', value: String(Math.round(value * 10) / 10), 'aria-label': label });
    valEl.replaceWith(f); f.focus(); f.select();
    const done = (apply) => {
      if (!f.isConnected) return;
      const n = parseFloat(f.value.replace(',', '.'));
      f.replaceWith(valEl);
      if (apply && Number.isFinite(n)) setValue(n, true);
    };
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') done(false); });
    f.addEventListener('blur', () => done(true));
  });
  // 이름 더블탭: 이 항목만 초기화
  let lastTap = 0;
  nameEl.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastTap < 320) setValue(def, true);
    lastTap = now;
  });
  return { el: root, set: (v) => setValue(v, false), get: () => value, input, setLabel: (s) => { nameEl.textContent = s; } };
}

// ------------------------------------------------------------ 칩
export function Chips(o) {
  const { items, onSelect, wrap = false, multi = false, label = '' } = o;
  let value = o.value;
  const root = h('div', { class: 'chips' + (wrap ? ' wrap' : ''), role: multi ? 'group' : 'radiogroup', 'aria-label': label });
  const btns = new Map();
  for (const it of items) {
    const b = h('button', { class: 'chip', type: 'button', role: multi ? undefined : 'radio', 'aria-checked': multi ? undefined : 'false', 'aria-pressed': multi ? 'false' : undefined, 'data-id': it.id },
      icon('check', 'sm chk'), it.icon ? icon(it.icon, 'sm') : null, h('span', null, it.label), it.valueText != null ? h('span', { class: 'cv' }, it.valueText) : null, it.mark ? h('span', { class: 'mark' }) : null);
    b.addEventListener('click', () => { if (!multi) set(it.id); onSelect && onSelect(it.id, b); });
    btns.set(it.id, b); root.append(b);
  }
  function set(id) {
    value = id;
    for (const [k, b] of btns) { const on = k === id; b.setAttribute(multi ? 'aria-pressed' : 'aria-checked', on ? 'true' : 'false'); }
  }
  function setOn(id, on) { const b = btns.get(id); if (b) b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  function setMark(id, on) {
    const b = btns.get(id); if (!b) return;
    let m = b.querySelector('.mark');
    if (on && !m) b.append(h('span', { class: 'mark' }));
    if (!on && m) m.remove();
  }
  function setText(id, txt) {
    const b = btns.get(id); if (!b) return;
    let c = b.querySelector('.cv');
    if (!c) b.insertBefore(c = h('span', { class: 'cv' }), b.querySelector('.mark'));
    c.textContent = txt;
  }
  if (value != null) set(value);
  return { el: root, set, setOn, setMark, setText, get: () => value, btn: (id) => btns.get(id) };
}

// ------------------------------------------------------------ 세그먼트
export function Segmented(o) {
  const { items, onChange, label = '' } = o;
  let value = o.value;
  const root = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label });
  const btns = new Map();
  for (const it of items) {
    const b = h('button', { type: 'button', role: 'radio', 'aria-checked': 'false' }, icon('check', 'sm chk'), it.icon ? icon(it.icon, 'sm') : null, h('span', null, it.label));
    b.addEventListener('click', () => { set(it.id); onChange && onChange(it.id); });
    btns.set(it.id, b); root.append(b);
  }
  function set(id) { value = id; for (const [k, b] of btns) b.setAttribute('aria-checked', k === id ? 'true' : 'false'); }
  if (value != null) set(value);
  return { el: root, set, get: () => value };
}

// ------------------------------------------------------------ 스위치
export function Switch(o) {
  let on = !!o.value;
  const root = h('button', { class: 'switch', type: 'button', role: 'switch', 'aria-checked': String(on) }, h('span', null, o.label), h('span', { class: 'track' }));
  root.addEventListener('click', () => { on = !on; root.setAttribute('aria-checked', String(on)); o.onChange && o.onChange(on); });
  return { el: root, set: (v) => { on = !!v; root.setAttribute('aria-checked', String(on)); }, get: () => on };
}

// ------------------------------------------------------------ 버튼
export function Btn(label, kind = 'tonal', onClick, ic) {
  const b = h('button', { class: 'btn ' + kind, type: 'button' }, ic ? icon(ic) : null, label);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}
export function IconBtn(name, label, onClick, cls = '') {
  const b = h('button', { class: 'iconbtn ' + cls, type: 'button', 'aria-label': label, title: label }, icon(name));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// ------------------------------------------------------------ 스낵바
let snackEl = null, snackTimer = 0;
export function toast(msg, opts = {}) {
  if (snackEl) { snackEl.remove(); clearTimeout(snackTimer); }
  const kids = [h('span', { style: { padding: '12px 0', flex: '1' } }, msg)];
  if (opts.action) kids.push(Btn(opts.action.label, 'text', () => { hide(); opts.action.onClick && opts.action.onClick(); }));
  snackEl = h('div', { class: 'snackbar', role: 'status', 'aria-live': 'polite' }, ...kids);
  document.body.append(snackEl);
  const el = snackEl;
  function hide() { if (el.isConnected) el.remove(); if (snackEl === el) snackEl = null; }
  snackTimer = setTimeout(hide, opts.duration || (opts.action ? 8000 : 4000));
  return hide;
}

// ------------------------------------------------------------ 다이얼로그 / 모달 시트
export function confirmDialog({ title, body, actions }) {
  return new Promise((resolve) => {
    const scrim = h('div', { class: 'scrim center', role: 'presentation' });
    const btns = actions.map((a) => Btn(a.label, a.kind || 'text', () => close(a.value)));
    const dlg = h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-t' }, h('h2', { id: 'dlg-t' }, title), body ? h('p', null, body) : null, h('div', { class: 'actions' }, ...btns));
    scrim.append(dlg);
    const prev = document.activeElement;
    let closed = false;
    const unBack = pushBack(() => close(actions[0] ? actions[0].value : null));
    function close(v) { if (closed) return; closed = true; unBack(); scrim.remove(); prev && prev.focus && prev.focus(); resolve(v); }
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(actions[0] ? actions[0].value : null); });
    document.body.append(scrim);
    (btns[btns.length - 1] || btns[0]).focus();
  });
}

/** 모달 시트: build(bodyEl, close) → 내용 구성. 반환 {close} */
export function openModal({ title, build, actions, onClose }) {
  const scrim = h('div', { class: 'scrim' });
  const body = h('div', { class: 'sheet-body' });
  const head = h('div', { class: 'sheet-head' }, h('h2', null, title || ''));
  const sheet = h('div', { class: 'msheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' }, h('div', { class: 'sheet-grab' }), head, body);
  scrim.append(sheet);
  const prev = document.activeElement;
  let closed = false;
  const unBack = pushBack(() => close());
  function close() { if (closed) return; closed = true; unBack(); scrim.remove(); prev && prev.focus && prev.focus(); onClose && onClose(); }
  head.append(IconBtn('x', t('닫기', 'Close'), close));
  scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
  document.body.append(scrim);
  build(body, close, head);
  if (actions) body.append(h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, ...actions));
  return { close, body, head };
}

// ------------------------------------------------------------ 스와치 / 컬러 피커
export function Swatches(o) {
  const colors = o.colors || PALETTE;
  let value = (o.value || '').toLowerCase();
  const root = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': o.label || t('색상', 'Color') });
  const btns = [];
  for (const c of colors) {
    const b = h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': c, style: { background: c } });
    b.addEventListener('click', () => { set(c); o.onSelect && o.onSelect(c); });
    btns.push([c, b]); root.append(b);
  }
  if (o.onCustom) {
    const cb = h('button', { class: 'swatch custom', type: 'button', 'aria-label': t('직접 선택', 'Custom') });
    cb.addEventListener('click', o.onCustom); root.append(cb);
  }
  function set(c) { value = (c || '').toLowerCase(); for (const [k, b] of btns) b.setAttribute('aria-checked', k.toLowerCase() === value ? 'true' : 'false'); }
  set(value);
  return { el: root, set };
}

export function ColorPicker(o) {
  let [hh, ss, vv] = hexToHsv(o.value || '#ffffff');
  const cv = h('canvas', { width: 256, height: 150 });
  const knob = h('div', { class: 'knob' });
  const sv = h('div', { class: 'sv' }, cv, knob);
  const hueS = Slider({ label: t('색조', 'Hue'), min: 0, max: 360, value: hh, def: 0, step: 1, unit: '°', grad: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)', onInput: (v) => { hh = v; draw(); emit(false); }, onChange: () => emit(true) });
  const hex = h('input', { class: 'field hexfield', type: 'text', maxLength: 7, value: hsvToHex(hh, ss, vv), 'aria-label': 'HEX', autocapitalize: 'off', spellcheck: 'false' });
  const prev = h('div', { style: { width: '48px', height: '48px', borderRadius: '8px', boxShadow: 'inset 0 0 0 1px rgba(128,128,128,.5)', flex: 'none' } });
  const eye = o.onEyedropper ? IconBtn('pipette', t('스포이트', 'Eyedropper'), () => o.onEyedropper((c) => set(c, true))) : null;
  const root = h('div', { class: 'cp' }, sv, hueS.el, h('div', { class: 'row' }, prev, hex, eye));
  const ctx = cv.getContext('2d');
  function draw() {
    const w = cv.width, hgt = cv.height;
    ctx.fillStyle = hsvToHex(hh, 1, 1); ctx.fillRect(0, 0, w, hgt);
    const g1 = ctx.createLinearGradient(0, 0, w, 0); g1.addColorStop(0, '#fff'); g1.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g1; ctx.fillRect(0, 0, w, hgt);
    const g2 = ctx.createLinearGradient(0, 0, 0, hgt); g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(1, '#000'); ctx.fillStyle = g2; ctx.fillRect(0, 0, w, hgt);
    knob.style.left = ss * 100 + '%'; knob.style.top = (1 - vv) * 100 + '%';
    const c = hsvToHex(hh, ss, vv);
    prev.style.background = c; if (document.activeElement !== hex) hex.value = c;
    knob.style.background = c;
  }
  function emit(commit) { const c = hsvToHex(hh, ss, vv); o.onChange && o.onChange(c, commit); }
  function pick(e) {
    const r = sv.getBoundingClientRect();
    ss = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    vv = 1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    draw(); emit(false);
  }
  sv.addEventListener('pointerdown', (e) => { sv.setPointerCapture(e.pointerId); pick(e); });
  sv.addEventListener('pointermove', (e) => { if (sv.hasPointerCapture(e.pointerId)) pick(e); });
  sv.addEventListener('pointerup', () => emit(true));
  hex.addEventListener('input', () => { const c = hexToRgb(hex.value); if (c) { [hh, ss, vv] = hexToHsv(hex.value); hueS.set(hh); draw(); emit(false); } });
  hex.addEventListener('change', () => emit(true));
  function set(c, emitNow) { [hh, ss, vv] = hexToHsv(c); hueS.set(hh); draw(); if (emitNow) emit(true); }
  draw();
  return { el: root, set };
}

export { clear, reducedMotion };
