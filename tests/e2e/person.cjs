// 인물 분리 모델(U²-Net-P, 기기 안 실행) E2E: 실제 사진에서 "인물 자동 선택" · 올가미 + 모델 · 모델을 못 쓸 때의 대체 동작
const path = require('path');
const { launch, close, openPhoto, selTool, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  const idle = (page) => page.waitForFunction(() => !window.imagefix.editor.tool.state().busy, null, { timeout: 120000 });
  const stats = (page) => page.evaluate(() => { const s = window.imagefix.editor.tool.selection(), { mask, w, h } = s; let n = 0, x0 = w, y0 = h, x1 = -1, y1 = -1; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] > 127) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } return { area: n / (w * h), box: n ? [x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h] : null }; });
  const pt = (page, fx, fy) => page.evaluate(([fx, fy]) => { const r = window.imagefix.editor.view.photo.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);

  console.log('▶ 실제 사진: 인물 자동 선택');
  let h = await launch({ w: 412, h: 915 }); let { page } = h;
  await openPhoto(page, path.join(FIX, 'person_real.jpg')); await selTool(page, 'body'); await waitIdle(page, 300);
  const t0 = Date.now();
  await page.click('.sheet .btn >> text=인물 자동 선택'); await idle(page); await page.waitForTimeout(250);
  const a = await stats(page);
  check('the person is selected (area 5–20%, around the middle of the photo)', a.area > 0.05 && a.area < 0.2 && a.box[0] > 0.15 && a.box[2] < 0.75, JSON.stringify(a) + ' ' + (Date.now() - t0) + 'ms');
  check('toast says the person was selected', /인물을 자동으로 선택/.test(await page.locator('.snackbar').last().textContent()));
  await h.shot('pm1_auto');
  await page.click('button[aria-label="선택 해제"]'); await page.waitForTimeout(100);

  console.log('▶ 실제 사진: 대충 그린 올가미 + 모델');
  const ring = [[0.28, 0.2], [0.72, 0.2], [0.72, 1.0], [0.28, 1.0]];
  const P = []; for (const [x, y] of ring) P.push(await pt(page, x, y));
  await page.mouse.move(P[0][0], P[0][1]); await page.mouse.down();
  for (let i = 1; i <= P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i % P.length]; for (let s = 1; s <= 4; s++) await page.mouse.move(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4); }
  await page.mouse.up(); await idle(page); await page.waitForTimeout(250);
  const b = await stats(page);
  check('a loose box lasso is trimmed to the person (much smaller than the box)', b.area > 0.04 && b.area < 0.2 && b.area < 0.44 * 0.8 * 0.5, JSON.stringify(b));
  check('toast says it snapped to the edge', /경계에 맞춰/.test(await page.locator('.snackbar').last().textContent()));
  await h.shot('pm2_lasso');
  await close(h); if (h.errors.length) { console.log('errors:', h.errors); bad++; }

  console.log('▶ 모델을 못 쓸 때(차단) → 색 맞춤/그린 대로로 대체');
  h = await launch({ w: 412, h: 915 }); page = h.page;
  await page.route('**/models/u2netp.onnx', (r) => r.abort());
  await openPhoto(page, path.join(FIX, 'person_synth.png')); await selTool(page, 'body'); await waitIdle(page, 300);
  await page.click('.sheet .btn >> text=인물 자동 선택'); await idle(page); await page.waitForTimeout(200);
  check('without the model, auto-select says it found no person (no crash)', /인물을 찾지 못했어요/.test(await page.locator('.snackbar').last().textContent()) && (await stats(page)).area === 0);
  const Q = []; for (const [x, y] of [[0.25, 0.3], [0.75, 0.3], [0.75, 0.97], [0.25, 0.97]]) Q.push(await pt(page, x, y));
  await page.mouse.move(Q[0][0], Q[0][1]); await page.mouse.down();
  for (let i = 1; i <= Q.length; i++) { const [ax, ay] = Q[i - 1], [bx, by] = Q[i % Q.length]; for (let s = 1; s <= 4; s++) await page.mouse.move(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4); }
  await page.mouse.up(); await idle(page); await page.waitForTimeout(250);
  check('the lasso still makes a selection (color snapping or as drawn)', (await stats(page)).area > 0.2 && /색 차이로|그린 대로/.test(await page.locator('.snackbar').last().textContent()));
  await close(h); const errs = h.errors.filter((e) => !/ERR_FAILED/.test(e)); // 차단한 모델 요청은 예상된 오류
  console.log('errors:', errs.length ? errs : 'none');
  process.exit(bad || errs.length ? 1 : 0);
})();
