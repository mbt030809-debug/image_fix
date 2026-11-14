const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
(async () => {
  const h = await launch();
  const { page } = h;
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  const st = () => page.evaluate(() => { const e = window.imagefix.editor, v = e.view; return { s: +v.s.toFixed(3), fitS: +v.fitS.toFixed(3), cw: v.cw, ch: v.ch, sw: v.sw, sh: v.sh, canvas: [v.photo.width, v.photo.height], css: [v.photo.style.width, v.photo.style.height], logical: e.logical, base: e.base && [e.base.w, e.base.h], geo: e.doc().geo.r, tx: +v.tx.toFixed(1), ty: +v.ty.toFixed(1) }; });
  console.log('open  ', JSON.stringify(await st()));
  await page.click('[data-tool=crop]'); await waitIdle(page, 500);
  console.log('crop  ', JSON.stringify(await st()));
  await page.click('[aria-label="오른쪽으로 90° 회전"]'); await waitIdle(page, 800);
  console.log('rot90 ', JSON.stringify(await st()));
  await h.shot('d1_rot');
  // retouch marker
  await page.click('[data-tool=retouch]'); await waitIdle(page, 500);
  const stage = await page.locator('.stage').boundingBox();
  console.log('stage', JSON.stringify(stage));
  const tx = stage.x + stage.width * 0.5, ty = stage.y + stage.height * 0.5;
  await page.mouse.click(tx, ty); await page.waitForTimeout(300);
  const info = await page.evaluate(([tx, ty]) => { const e = window.imagefix.editor; const t = e.tool; return { rect: e.stage.getBoundingClientRect().toJSON(), tap: [tx, ty], geo: e.doc().geo }; }, [tx, ty]);
  console.log('retouch', JSON.stringify(info));
  await h.shot('d2_retouch');
  // curves
  await page.click('[data-tool=curves]'); await waitIdle(page, 500);
  const b = await page.locator('.curve canvas').boundingBox();
  await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.5); await page.mouse.down(); await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.3, { steps: 5 }); await page.mouse.up(); await waitIdle(page, 400);
  console.log('curves', JSON.stringify(await page.evaluate(() => window.imagefix.editor.doc().adj.curves)));
  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
