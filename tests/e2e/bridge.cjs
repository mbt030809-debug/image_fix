// 네이티브 브리지 계약 검증: 가짜 window.Android 를 주입해 공유 열기 / 저장(청크) / 공유 / 뒤로가기를 확인
const path = require('path');
const { launch, close, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
const init = () => {
  window.__calls = []; window.__chunks = {}; let pending = 1;
  window.Android = {
    deviceInfo: () => JSON.stringify({ sdk: 34, memMB: 6000, camera: true, model: 'Fake' }),
    pendingCount: () => pending, clearPending: () => { pending = 0; },
    pickImages: (m) => { window.__calls.push(['pickImages', m]); pending = 1; setTimeout(() => window.__nativeImages && window.__nativeImages(), 30); },
    takePhoto: () => window.__calls.push(['takePhoto']),
    beginSave: (n, m) => { window.__calls.push(['beginSave', n, m]); window.__chunks.s1 = []; return 's1'; },
    writeChunk: (id, b64) => { window.__chunks[id].push(b64); return true; },
    endSave: (id) => { window.__calls.push(['endSave', id, window.__chunks[id].length]); return 'content://media/external/images/media/42'; },
    abortSave: () => window.__calls.push(['abortSave']),
    share: (u, m) => window.__calls.push(['share', u, m]), viewImage: (u) => window.__calls.push(['viewImage', u]),
    setBars: (h, d) => window.__calls.push(['setBars', h, d]), toast: (m) => window.__calls.push(['toast', m]), haptic: () => {}, keepScreenOn: () => {}, exit: () => window.__calls.push(['exit']),
  };
};
(async () => {
  const h = await launch({ shared: [{ file: path.join(FIX, 'portrait.jpg'), name: '인물 사진 1.jpg' }], init });
  const { page } = h;
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  console.log('shared image opened at startup; file name:', await page.evaluate(() => window.imagefix.editor.fileName));
  console.log('screen:', await page.evaluate(() => window.imagefix.screen));
  await h.shot('b1_shared_open');
  await page.click('[data-tool=adjust]'); await waitIdle(page, 200);
  await page.evaluate(() => { const s = document.querySelector('.sheet .slider'); s.value = 25; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitIdle(page, 300);
  await page.click('.topbar .btn.filled'); await page.waitForTimeout(300);
  await page.click('[data-act=save]');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'endSave'), null, { timeout: 30000 });
  const calls = await page.evaluate(() => window.__calls);
  console.log('calls:', JSON.stringify(calls));
  const ok = await page.evaluate(async () => {
    const b64 = window.__chunks.s1.join('');
    const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const bmp = await createImageBitmap(new Blob([u8], { type: 'image/jpeg' }));
    return { bytes: u8.length, w: bmp.width, h: bmp.height, magic: [u8[0], u8[1]] };
  });
  console.log('saved image decodes:', JSON.stringify(ok));
  await page.waitForSelector('.snackbar');
  console.log('snackbar:', await page.textContent('.snackbar'));
  await page.click('.snackbar .btn'); // 보기
  // 다시 저장 후 공유
  await page.click('.topbar .btn.filled'); await page.waitForTimeout(300);
  await page.click('[data-act=share]');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'share'), null, { timeout: 30000 });
  console.log('share call:', JSON.stringify(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'share' || c[0] === 'viewImage'))));
  // 뒤로가기: 도구 닫기 → 편집 화면에서 닫기 → 홈 → 종료 안내
  console.log('back handled (tool open):', await page.evaluate(() => { window.imagefix.editor.openTool('crop'); return window.__onBack(); }), 'tool now:', await page.evaluate(() => window.imagefix.editor.toolId));
  console.log('home pick → native pickImages:');
  await page.evaluate(() => { window.imagefix.goHome(); });
  await page.click('.hero .btn');
  await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'pickImages'), null, { timeout: 5000 });
  await page.waitForFunction(() => window.imagefix.screen === 'editor', null, { timeout: 15000 });
  console.log('reopened via native pick → editor ok; setBars calls:', JSON.stringify(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'setBars'))));
  await h.shot('b2_after');
  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
