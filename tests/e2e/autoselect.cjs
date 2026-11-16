// 인물 경계 자동 맞춤 E2E: 대충 그린 올가미가 인물 경계에 맞춰지고(꺼짐이면 그린 그대로), 되돌리기·빼기·브러시 모드가 정상인지
const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  const h = await launch({ w: 412, h: 915 });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await openPhoto(page, path.join(FIX, 'person_synth.png'));
  const pt = (fx, fy) => page.evaluate(([fx, fy]) => { const r = window.imagefix.editor.view.photo.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);
  const lasso = async (pts) => { const P = []; for (const [a, b] of pts) P.push(await pt(a, b)); await page.mouse.move(P[0][0], P[0][1]); await page.mouse.down(); for (let i = 1; i < P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i]; for (let s = 1; s <= 4; s++) await page.mouse.move(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4); } await page.mouse.up(); };
  /** 정답(합성 사진의 인물)과 현재 선택의 IoU, 선택 면적 */
  const score = () => page.evaluate(() => {
    const s = window.imagefix.editor.tool.selection(), { mask, w, h } = s; let i = 0, u = 0, a = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) / w, fy = (y + 0.5) / h;
      const tr = ((fx - 0.5) ** 2 + ((fy - 0.22) * 800 / 600) ** 2 < 0.12 ** 2) || (Math.abs(fx - 0.5) < 0.2 && fy > 0.36 && fy < 0.95);
      const m = mask[y * w + x] > 127; if (m && tr) i++; if (m || tr) u++; if (m) a++;
    }
    return { iou: i / u, area: a / (w * h) };
  });
  const waitSnap = () => page.waitForFunction(() => !window.imagefix.editor.tool.state().busy, null, { timeout: 15000 });
  // 인물 윤곽에서 m(비율)만큼 느슨하게 두 번에 나눠 그린 올가미: 머리(타원) + 몸(사각)
  const headRing = (m) => { const P = []; for (let k = 0; k < 20; k++) { const a = (k / 20) * Math.PI * 2; P.push([0.5 + (0.12 + m) * Math.cos(a), 0.22 + (0.09 + m) * Math.sin(a)]); } return P; };
  const bodyRect = (m) => [[0.5 - 0.2 - m, 0.36 - m], [0.5 + 0.2 + m, 0.36 - m], [0.5 + 0.2 + m, 0.95 + m], [0.5 - 0.2 - m, 0.95 + m]];
  const drawPerson = async (m) => { await lasso(headRing(m)); await waitSnap(); await page.waitForTimeout(120); await lasso(bodyRect(m)); await waitSnap(); await page.waitForTimeout(150); };

  console.log('▶ 자동 맞춤 켜짐(기본)');
  await selTool(page, 'body'); await waitIdle(page, 300);
  check('the snap switch exists and defaults to On', (await page.locator('.seg button[aria-checked=true] >> text=켜짐').count()) >= 1);
  await drawPerson(0.035);
  const on = await score();
  check('a loose outline snaps to the person (IoU > 0.9)', on.iou > 0.9, JSON.stringify(on));
  check('toast says it snapped', /경계에 맞춰/.test(await page.locator('.snackbar').last().textContent()));
  await h.shot('as1_snapped');
  await page.click('button[aria-label="선택 되돌리기"]'); await page.waitForTimeout(100); await page.click('button[aria-label="선택 되돌리기"]'); await page.waitForTimeout(150);
  check('Undo (twice, one per outline) clears the snapped selection', (await score()).area === 0);

  console.log('▶ 자동 맞춤 꺼짐');
  await page.click('.seg button >> text=꺼짐'); await page.waitForTimeout(150);
  await lasso(headRing(0.035)); await page.waitForTimeout(150); await lasso(bodyRect(0.035)); await page.waitForTimeout(250);
  const off = await score();
  check('Off keeps the outline as drawn (looser, lower IoU)', off.iou < on.iou - 0.05 && off.area > on.area, JSON.stringify(off));
  await page.click('button[aria-label="선택 해제"]');
  await page.click('.seg button >> text=켜짐'); await page.waitForTimeout(150);

  console.log('▶ 빼기 · 정확하게 그린 올가미');
  await drawPerson(0.02);
  const a1 = await score();
  check('a closer outline also lands on the person', a1.iou > 0.9, JSON.stringify(a1));
  await page.click('.seg button >> text=빼기'); await page.waitForTimeout(100);
  await lasso([[0.28, 0.5], [0.72, 0.5], [0.72, 0.9], [0.28, 0.9]]); await waitSnap(); await page.waitForTimeout(200);
  const a2 = await score();
  check('Subtract with snapping removes the lower body', a2.area < a1.area - 0.1, JSON.stringify(a2));

  const errs = await page.evaluate(() => (window.__errs || []).length);
  await close(h);
  console.log('errors:', h.errors.length ? h.errors : 'none');
  process.exit(bad || h.errors.length ? 1 : 0);
})();
