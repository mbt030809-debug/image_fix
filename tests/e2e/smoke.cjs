const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  const h = await launch();
  const { page } = h;
  await h.shot('01_home');
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  await h.shot('02_editor');
  const info = await page.evaluate(() => { const e = window.imagefix.editor; return { base: e.base && [e.base.w, e.base.h], logical: e.logical, tool: e.toolId, zoom: e.zoomChip.textContent, photo: [e.view.photo.width, e.view.photo.height] }; });
  console.log('editor:', JSON.stringify(info));
  // 조정 도구
  await page.click('[data-tool=adjust]');
  await waitIdle(page);
  await h.shot('03_adjust_peek');
  // 슬라이더 조작 (노출 +40)
  await page.evaluate(() => { const i = document.querySelector('.sheet .slider'); i.value = 40; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
  await waitIdle(page, 400);
  await h.shot('04_adjust_exposure');
  // 펼침
  await page.click('.sheet-grab');
  await page.waitForTimeout(300);
  await h.shot('05_adjust_expanded');
  // 필터
  await page.click('[data-tool=filter]');
  await waitIdle(page, 600);
  await h.shot('06_filters');
  await page.click('.thumb[data-id=teal]');
  await waitIdle(page, 400);
  await h.shot('07_filter_teal');
  // 자르기
  await page.click('[data-tool=crop]');
  await waitIdle(page, 400);
  await h.shot('08_crop');
  console.log('errors:', h.errors.length ? '\n' + h.errors.join('\n') : 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
