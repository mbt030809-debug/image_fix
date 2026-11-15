// E2E 공용: 정적 서버 + 헤드리스 크롬(모바일 뷰포트) + 콘솔 오류 수집
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
const WWW = path.resolve(__dirname, '../../app/src/main/assets/www');
const OUT = path.resolve(__dirname, '../out');
const DATE = '2026-11-15';
fs.mkdirSync(OUT, { recursive: true });

function startServer(shared) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (shared && p.startsWith('/__shared/')) {
        const i = parseInt(p.split('/')[2], 10), it = shared[i];
        if (!it) { res.writeHead(404); res.end('nf'); return; }
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-File-Name': encodeURIComponent(it.name), 'Cache-Control': 'no-store' });
        fs.createReadStream(it.file).pipe(res); return;
      }
      if (p === '/') p = '/index.html';
      const f = path.join(WWW, p);
      if (!f.startsWith(WWW) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

async function launch(opts = {}) {
  const { srv, url } = await startServer(opts.shared);
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: opts.w || 412, height: opts.h || 915 }, deviceScaleFactor: opts.dpr || 2, isMobile: true, hasTouch: true, locale: opts.locale || 'ko-KR' });
  const page = await ctx.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
  await page.goto(url);
  return { page, browser, srv, errors, url, shot: (name) => page.screenshot({ path: path.join(OUT, `${name}_${DATE}.png`) }) };
}

async function close(h) { await h.browser.close(); h.srv.close(); }

async function openPhoto(page, file) {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.hero .btn')]);
  await fc.setFiles(file);
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await page.waitForTimeout(200);
}

async function waitIdle(page, ms = 150) {
  await page.waitForFunction(() => { const e = window.imagefix.editor; return !e.busy && !e.again; }, null, { timeout: 30000 });
  await page.waitForTimeout(ms);
}

module.exports = { launch, close, openPhoto, waitIdle, OUT, DATE };
