// 작업 기록: 여러 번 편집 후 기록 탭에서 임의 시점으로 이동, 다시 실행 복구 확인
const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  const h = await launch();
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  const slider = async (v) => page.evaluate((v) => { const s = document.querySelector('.sheet .slider'); s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, v);
  await page.click('[data-tool=adjust]'); await waitIdle(page, 200);
  await slider(20); await waitIdle(page, 200);
  await page.click('.chip >> text=대비'); await slider(30); await waitIdle(page, 200);
  await page.click('[data-tool=filter]'); await waitIdle(page, 400);
  await page.click('.thumb[data-id=film]'); await waitIdle(page, 300);
  const n = await page.evaluate(() => window.imagefix.editor.store.history().length);
  check('history has entries', n >= 4, 'n=' + n);
  await page.click('[data-tool=layers]'); await waitIdle(page, 200);
  await page.click('.seg button >> text=작업 기록');
  const rows = await page.locator('.sheet .layer-row').count();
  check('history rows listed', rows === n, rows + ' vs ' + n);
  // 가장 아래(= 원본) 항목으로 이동
  await page.locator('.sheet .layer-row').last().click(); await waitIdle(page, 400);
  const d0 = await page.evaluate(() => { const d = window.imagefix.editor.doc(); return { adj: d.adj, filter: d.filter.id }; });
  check('jump to original clears edits', Object.keys(d0.adj).length === 0 && d0.filter === 'none', JSON.stringify(d0));
  // 두 번째 항목(첫 편집 직후)으로 이동 = future 항목 클릭
  await page.locator('.sheet .layer-row').nth(rows - 2).click(); await waitIdle(page, 400);
  const d1 = await page.evaluate(() => window.imagefix.editor.doc().adj);
  check('jump forward restores first edit', d1.exposure === 20 && !d1.contrast, JSON.stringify(d1));
  // 맨 위(최신)로
  await page.locator('.sheet .layer-row').first().click(); await waitIdle(page, 400);
  const d2 = await page.evaluate(() => { const d = window.imagefix.editor.doc(); return { adj: d.adj, filter: d.filter.id }; });
  check('jump to latest restores all', d2.adj.exposure === 20 && d2.adj.contrast === 30 && d2.filter === 'film', JSON.stringify(d2));
  await h.shot('h1_history');
  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
