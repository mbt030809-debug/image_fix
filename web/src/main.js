import { App } from './app.js';
import { toast } from './ui/components.js';
import { t, initLang } from './i18n.js';
import { autoCheck } from './update.js';

function compatible() {
  return typeof createImageBitmap === 'function' && typeof Path2D !== 'undefined' && typeof ResizeObserver !== 'undefined' && typeof PointerEvent !== 'undefined' && typeof Element.prototype.replaceChildren === 'function' && typeof Promise !== 'undefined' && !!HTMLCanvasElement.prototype.toBlob;
}

function start() {
  const root = document.getElementById('app');
  initLang();
  if (!compatible()) {
    root.style.cssText = 'display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:16px/1.6 system-ui,sans-serif;color:#ececec;background:#121212';
    root.textContent = t('이 기기의 WebView가 너무 오래됐어요. Play 스토어에서 "Android System WebView"(또는 Chrome)를 업데이트한 뒤 다시 열어 주세요.', 'This device\'s WebView is too old. Update "Android System WebView" (or Chrome) in the Play Store and reopen the app.');
    return;
  }
  let lastErr = 0;
  const report = (e) => {
    console.error(e);
    const now = Date.now();
    if (now - lastErr > 6000) { lastErr = now; toast(t('문제가 생겼어요. 다시 시도해 주세요.', 'Something went wrong. Please try again.')); }
  };
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
  window.addEventListener('error', (e) => { if (e.message && !/ResizeObserver/.test(e.message)) report(e.error || e.message); });
  window.imagefix = new App(root);
  setTimeout(() => autoCheck(window.imagefix), 4000); // 새 버전 확인(실행할 때마다, 설정에서 끌 수 있음)
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
