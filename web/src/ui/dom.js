// 아주 작은 DOM 헬퍼 + 인라인 SVG 스프라이트
import { ICONS } from '../icons.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    const keys = Object.keys(props);
    if (keys.includes('type')) keys.splice(keys.indexOf('type'), 1), keys.unshift('type');
    for (const k of keys) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'min' || k === 'max' || k === 'step' || k === 'tabIndex' || k === 'id' || k === 'title' || k === 'placeholder' || k === 'textContent') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export function icon(name, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('focusable', 'false');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

let spriteDone = false;
export function ensureSprite() {
  if (spriteDone) return;
  spriteDone = true;
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
  let inner = '';
  for (const [name, body] of Object.entries(ICONS)) inner += `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`;
  svg.innerHTML = inner;
  document.body.prepend(svg);
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export const raf = (fn) => requestAnimationFrame(fn);

/** rAF 로 호출을 묶는다 (마지막 값만) */
export function rafThrottle(fn) {
  let pending = false, lastArgs;
  return (...args) => {
    lastArgs = args;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
  };
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

export function reducedMotion() {
  try {
    if (localStorage.getItem('imagefix.reduceMotion') === '1') return true;
  } catch (e) { /* noop */ }
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
