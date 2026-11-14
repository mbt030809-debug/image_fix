const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
(async () => {
  const h = await launch();
  const { page } = h;
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  await page.click('[data-tool=adjust]'); await waitIdle(page, 200);
  await page.evaluate(() => { const s = document.querySelector('.sheet .slider'); s.value = 40; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitIdle(page, 300);
  await page.click('[data-tool=text]'); await waitIdle(page, 200);
  await page.click('.btn >> text=텍스트 추가'); await waitIdle(page, 200);
  await page.fill('.sheet textarea', '복구 테스트'); await page.dispatchEvent('.sheet textarea', 'change');
  await page.waitForTimeout(2500); // 드래프트 저장 대기
  console.log('before reload adj:', JSON.stringify(await page.evaluate(() => window.imagefix.editor.doc().adj)), 'layers:', await page.evaluate(() => window.imagefix.editor.doc().layers.length));
  await page.reload();
  await page.waitForFunction(() => window.imagefix && !window.imagefix.draftCard.hidden, null, { timeout: 10000 });
  console.log('draft card:', await page.textContent('.tile >> nth=0'));
  await h.shot('d1_home_draft');
  await page.click('.draft-card, .tile >> nth=0');
  await page.waitForFunction(() => window.imagefix.screen === 'editor' && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await page.waitForTimeout(500);
  console.log('after restore adj:', JSON.stringify(await page.evaluate(() => window.imagefix.editor.doc().adj)), 'layers:', JSON.stringify(await page.evaluate(() => window.imagefix.editor.doc().layers.map((l) => l.t + ':' + l.text))));
  await h.shot('d2_restored');
  // 닫기(버리기) → 드래프트 삭제 확인
  await page.click('[aria-label="닫기"]'); await page.waitForTimeout(300);
  await page.click('.dialog .btn >> text=버리기'); await page.waitForTimeout(500);
  console.log('draft card hidden after discard:', await page.evaluate(() => window.imagefix.draftCard.hidden));
  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
