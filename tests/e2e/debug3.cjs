const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
(async () => {
  const h = await launch();
  const { page } = h;
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  await selTool(page, 'retouch'); await waitIdle(page, 500);
  const stage = await page.locator('.stage').boundingBox();
  console.log('stage', JSON.stringify(stage));
  const tx = stage.x + stage.width * 0.3, ty = stage.y + stage.height * 0.5;
  await page.mouse.click(tx, ty); await page.waitForTimeout(300);
  console.log('tap', tx, ty);
  console.log('dbg', JSON.stringify(await page.evaluate(() => { const e = window.imagefix.editor, v = e.view; return { dbg: e.tool.debug(), s: v.s, tx: v.tx, ty: v.ty, cw: v.cw, ch: v.ch, info: e.info, frame: e.frameInfo(), logical: e.logical }; })));
  await h.shot('d3_retouch');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
