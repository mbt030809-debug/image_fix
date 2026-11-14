const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
async function run(name, opts, theme, steps) {
  const h = await launch(opts);
  const { page } = h;
  if (theme) await page.evaluate((th) => { window.imagefix.settings.theme = th; window.imagefix.applyTheme(); }, theme);
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  if (steps) await steps(page, h);
  await h.shot(name);
  const ov = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log(name, 'overflowX:', ov.sw > ov.cw, JSON.stringify(ov), 'errors:', h.errors.length);
  await close(h);
}
(async () => {
  await run('l1_light', { w: 412, h: 915 }, 'light', async (p) => { await p.click('[data-tool=adjust]'); await waitIdle(p, 300); });
  await run('l2_landscape', { w: 844, h: 390 }, null, async (p) => { await p.click('[data-tool=filter]'); await waitIdle(p, 600); });
  await run('l3_narrow320', { w: 320, h: 640 }, null, async (p) => { await p.click('[data-tool=text]'); await waitIdle(p, 300); await p.click('.btn >> text=텍스트 추가'); await waitIdle(p, 300); });
  await run('l4_tablet', { w: 900, h: 1100 }, null, async (p) => { await p.click('[data-tool=effects]'); await waitIdle(p, 800); });
  await run('l5_english', { w: 412, h: 915, locale: 'en-US' }, null, async (p) => { await p.click('[data-tool=adjust]'); await waitIdle(p, 300); });
})().catch((e) => { console.error(e); process.exit(1); });
