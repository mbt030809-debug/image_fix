// 한국어 우선, 영어 대체. t('한국어', 'English')
let lang = 'ko';
const listeners = new Set();

export function detectLang() {
  try {
    const saved = localStorage.getItem('imagefix.lang');
    if (saved === 'ko' || saved === 'en') return saved;
  } catch (e) { /* 저장소 사용 불가 */ }
  const n = (navigator.language || 'ko').toLowerCase();
  return n.startsWith('ko') ? 'ko' : n.startsWith('en') ? 'en' : 'ko';
}

export function setLang(l) {
  lang = l === 'en' ? 'en' : 'ko';
  try { localStorage.setItem('imagefix.lang', lang); } catch (e) { /* noop */ }
  document.documentElement.lang = lang;
  listeners.forEach((f) => f(lang));
}
export function getLang() { return lang; }
export function onLang(f) { listeners.add(f); return () => listeners.delete(f); }
export function initLang() { lang = detectLang(); document.documentElement.lang = lang; }

export const t = (ko, en) => (lang === 'en' && en != null ? en : ko);
