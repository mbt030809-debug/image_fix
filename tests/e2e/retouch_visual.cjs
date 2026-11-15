const path = require('path'); const fs = require('fs');
const { launch, close, openPhoto, waitIdle, OUT, DATE, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
(async () => {
  const h = await launch({ w: 412, h: 915, dpr: 2 });
  const { page } = h;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  await selTool(page, 'retouch'); await waitIdle(page, 400);
  // 확대해서 정밀하게 (줌 칩 2번)
  await page.click('.zoomchip'); await page.waitForTimeout(400);
  const crop = async (name, nx, ny, size = 220) => {
    const data = await page.evaluate(([nx, ny, size]) => { const cv = window.imagefix.editor.view.photo; const k = cv.width; const t = document.createElement('canvas'); t.width = size; t.height = size; t.getContext('2d').drawImage(cv, nx * cv.width - size / 2, ny * cv.height - size / 2, size, size, 0, 0, size, size); return t.toDataURL('image/png'); }, [nx, ny, size]);
    fs.writeFileSync(path.join(OUT, `${name}_${DATE}.png`), Buffer.from(data.split(',')[1], 'base64'));
  };
  const toScreen = (nx, ny) => page.evaluate(([nx, ny]) => { const e = window.imagefix.editor, v = e.view; const [x, y] = v.toScreen(nx * v.cw, ny * v.ch); const r = v.stage.getBoundingClientRect(); return [r.left + x, r.top + y]; }, [nx, ny]);
  // 확대 후 화면 중앙으로 이동시키기 위해 첫 얼룩 위치로 패닝
  const centerOn = async (nx, ny) => page.evaluate(([nx, ny]) => { const v = window.imagefix.editor.view; v.tx = v.sw / 2 - nx * v.cw * v.s; v.ty = v.sh / 2 - ny * v.ch * v.s; v.apply(); }, [nx, ny]);
  await centerOn(0.58, 0.46); await page.waitForTimeout(200);
  await crop('r0_before_blemish1', 0.58, 0.46);
  await page.click('.seg button >> text=지우기');
  let [sx, sy] = await toScreen(0.58, 0.46);
  await page.mouse.move(sx - 6, sy - 2); await page.mouse.down(); await page.mouse.move(sx + 6, sy + 2, { steps: 4 }); await page.mouse.up(); await waitIdle(page, 600);
  await crop('r1_after_erase', 0.58, 0.46);
  // 치유: 다른 얼룩(0.42,0.34)
  await centerOn(0.42, 0.34); await page.waitForTimeout(200);
  await crop('r2_before_blemish2', 0.42, 0.34);
  await page.click('.seg button >> text=치유');
  [sx, sy] = await toScreen(0.47, 0.37); await page.mouse.click(sx, sy); await page.waitForTimeout(200); // 소스 지정(피부)
  [sx, sy] = await toScreen(0.42, 0.34); await page.mouse.move(sx - 5, sy - 2); await page.mouse.down(); await page.mouse.move(sx + 5, sy + 2, { steps: 4 }); await page.mouse.up(); await waitIdle(page, 600);
  await crop('r3_after_heal', 0.42, 0.34);
  // 피부 매끄럽게 (브러시 프리셋)
  await page.click('.chip >> text=피부 매끄럽게'); await waitIdle(page, 400);
  await page.evaluate(() => window.imagefix.editor.view.fit(false)); await page.waitForTimeout(300);
  [sx, sy] = await toScreen(0.5, 0.4); await page.mouse.move(sx - 40, sy); await page.mouse.down(); await page.mouse.move(sx + 40, sy + 10, { steps: 8 }); await page.mouse.move(sx - 30, sy + 30, { steps: 8 }); await page.mouse.up(); await waitIdle(page, 800);
  await h.shot('r4_smooth_full');
  console.log('doc retouch ops:', await page.evaluate(() => JSON.stringify(window.imagefix.editor.doc().retouch.map((o) => o.k + ':' + (o.mode || '')))), 'locals:', await page.evaluate(() => window.imagefix.editor.doc().locals.length));
  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
