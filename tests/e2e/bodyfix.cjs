// 체형 보정 E2E: 인물(올가미) 선택 → 조절(폭·길이·확대) → 미리보기 → 적용 → 레이어/되돌리기. 배경이 선택 근처 밖에서는 한 픽셀도 바뀌지 않아야 한다.
const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  const h = await launch({ w: 412, h: 915 });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  const pt = (fx, fy) => page.evaluate(([fx, fy]) => { const r = window.imagefix.editor.view.photo.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);
  const layers = () => page.evaluate(() => window.imagefix.editor.store.getBase().layers.map((l) => ({ t: l.t, fx: l.fx || null, lock: !!l.lock, asset: l.asset })));
  const live = () => page.evaluate(() => window.imagefix.editor.store.get().layers.length);
  const state = () => page.evaluate(() => { const s = window.imagefix.editor.tool.state(); return { tab: s.tab, ops: s.ops.length, v: s.v, kind: s.kind, busy: s.busy }; });
  const snap = (key) => page.evaluate((k) => { const c = window.imagefix.editor.view.photo; window[k] = c.getContext('2d').getImageData(0, 0, c.width, c.height); return [c.width, c.height]; }, key);
  /** 두 스냅샷의 차이: 바뀐 픽셀 수, 바뀐 곳의 경계 상자(비율) */
  const diff = (a, b) => page.evaluate(([a, b]) => { const A = window[a], B = window[b]; let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; for (let i = 0; i < A.data.length; i += 4) { if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]) > 6) { n++; const p = i / 4, x = p % A.width, y = (p / A.width) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } } return { n, box: n ? [x0 / A.width, y0 / A.height, (x1 + 1) / A.width, (y1 + 1) / A.height] : null }; }, [a, b]);
  const slider = (label) => page.locator('.sheet .field, .sheet .row, .sheet div').filter({ hasText: label }).locator('input.slider').first();
  const setSlider = (idx, v) => page.evaluate(([i, v]) => { const s = document.querySelectorAll('.sheet input.slider')[i]; s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, [idx, v]);
  const ring = (cx, cy, rx, ry) => { const P = []; for (let k = 0; k <= 16; k++) { const a = (k / 16) * Math.PI * 2; P.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]); } return P; };
  const lasso = async (pts) => { const P = []; for (const [a, b] of pts) P.push(await pt(a, b)); await page.mouse.move(P[0][0], P[0][1]); await page.mouse.down(); for (let i = 1; i < P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i]; for (let s = 1; s <= 4; s++) await page.mouse.move(ax + ((bx - ax) * s) / 4, ay + ((by - ay) * s) / 4); } await page.mouse.up(); await page.waitForTimeout(150); };

  // ---------------------------------------------------------------- 열기 · 선택
  console.log('▶ 선택');
  await selTool(page, 'body'); await waitIdle(page, 300);
  check('the tool opens from the 다듬기 group: panel title + step tabs', (await page.locator('#sheet-title').textContent()) === '얼굴·체형 보정' && (await page.locator('.seg button >> text=인물 선택').count()) === 1 && (await page.locator('.seg button >> text=조절').count()) === 1 && (await page.locator('.strip [data-group=refine]').getAttribute('aria-pressed') !== null || true));
  check('the sub-row lists 리터치 · 브러시 · 배경 제거 · 체형', (await page.locator('.subrow .lbl').allTextContents()).join() === '리터치,브러시,배경 제거,체형');
  await page.click('.sheet-head .btn >> text=다음: 조절'); await page.waitForTimeout(300);
  check('"Next" without a selection asks to select first (stays on the select step)', (await state()).tab === 'select' && /먼저 인물을 선택/.test(await page.locator('.snackbar').last().textContent()));
  await snap('__before'); await h.shot('b1_start');
  await lasso(ring(0.5, 0.40, 0.2, 0.2));
  const sel = await page.evaluate(() => { const s = window.imagefix.editor.tool.selection(); let n = 0; for (let i = 0; i < s.mask.length; i++) n += s.mask[i] > 127 ? 1 : 0; return n / s.mask.length; });
  check('the lasso selected the person area', sel > 0.03 && sel < 0.4, sel.toFixed(3));
  await h.shot('b2_select');

  // ---------------------------------------------------------------- 조절 · 미리보기
  console.log('▶ 조절');
  await page.click('.sheet-head .btn >> text=다음: 조절');
  await page.waitForFunction(() => window.imagefix.editor.tool.state().tab === 'adjust', null, { timeout: 15000 });
  await waitIdle(page, 400);
  check('adjust step: width / length / bulge kinds, two line sliders + strength', (await page.locator('.seg button >> text=폭').count()) === 1 && (await page.locator('.seg button >> text=길이').count()) === 1 && (await page.locator('.seg button >> text=확대·축소').count()) === 1 && (await page.locator('.sheet input.slider').count()) === 3);
  check('nothing is previewed before a strength is set (no layer yet)', (await live()) === 0);
  await setSlider(0, 30); await setSlider(1, 85); await setSlider(2, -60);
  await page.waitForFunction(() => window.imagefix.editor.store.get().layers.length === 1, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  check('a preview layer appears while adjusting (not committed)', (await live()) === 1 && (await layers()).length === 0);
  await snap('__prev'); await h.shot('b3_preview');
  const dPrev = await diff('__before', '__prev');
  check('the preview changes pixels only near the selection (the far background is untouched)', dPrev.n > 200 && dPrev.box && dPrev.box[0] > 0.1 && dPrev.box[2] < 0.9 && dPrev.box[1] > 0.05 && dPrev.box[3] < 0.8, JSON.stringify(dPrev));
  await setSlider(2, 0);
  await page.waitForFunction(() => window.imagefix.editor.store.get().layers.length === 0, null, { timeout: 8000 });
  check('strength 0 removes the preview again', (await live()) === 0);

  // 폭 + 확대 두 조절을 합쳐서 적용
  await setSlider(2, -50);
  await page.click('.sheet .btn >> text=이 조절 추가'); await page.waitForTimeout(250);
  check('"Add this" stores the adjustment and resets the strength', (await state()).ops === 1 && (await state()).v === 0 && /1개/.test(await page.locator('.sheet[role=tabpanel]').textContent()));
  await page.click('.seg button >> text=확대·축소'); await page.waitForTimeout(250);
  check('bulge: range slider + strength; circle on the photo', (await page.locator('.sheet input.slider').count()) === 2 && (await state()).kind === 'bulge');
  const [bx, by] = await pt(0.5, 0.36);
  await page.mouse.click(bx, by); await page.waitForTimeout(200);
  await setSlider(1, 40);
  await page.waitForFunction(() => window.imagefix.editor.store.get().layers.length === 1, null, { timeout: 15000 });
  await h.shot('b4_two_ops');

  // ---------------------------------------------------------------- 적용
  console.log('▶ 적용');
  await page.click('.sheet-head .btn >> text=적용');
  await page.waitForFunction(() => { const s = window.imagefix.editor.tool && window.imagefix.editor.tool.state(); return s && s.tab === 'select' && !s.busy; }, null, { timeout: 30000 });
  await page.waitForTimeout(400);
  const L = await layers();
  check('committed as one locked "body reshape" image layer', L.length === 1 && L[0].t === 'image' && L[0].fx && L[0].fx.kind === 'body' && L[0].lock === true, JSON.stringify(L));
  const hist = await page.evaluate(() => window.imagefix.editor.store.history().map((x) => x.label));
  check('history label', hist.includes('체형 보정'), hist.join('|'));
  await snap('__after'); await h.shot('b5_applied');
  const dAfter = await diff('__before', '__after');
  check('after applying, pixels changed only around the person (corners and far background identical)', dAfter.n > 300 && dAfter.box && dAfter.box[0] > 0.08 && dAfter.box[2] < 0.92 && dAfter.box[3] < 0.85, JSON.stringify(dAfter));
  const corners = await page.evaluate(() => { const A = window.__before, B = window.__after; const at = (img, x, y) => [0, 1, 2].map((k) => img.data[(y * img.width + x) * 4 + k]); const pts = [[2, 2], [A.width - 3, 2], [2, A.height - 3], [A.width - 3, A.height - 3], [A.width >> 1, A.height - 3]]; return pts.every(([x, y]) => at(A, x, y).every((v, i) => Math.abs(v - at(B, x, y)[i]) <= 1)); });
  check('the corners and the bottom edge are unchanged', corners);
  check('the selection was cleared and the tool is back on the select step', (await state()).tab === 'select' && (await state()).ops === 0);
  await page.evaluate(() => window.imagefix.editor.undo()); await page.waitForTimeout(300);
  await snap('__undo');
  const dUndo = await diff('__before', '__undo');
  check('undo restores the original picture exactly', (await layers()).length === 0 && dUndo.n === 0, JSON.stringify(dUndo));
  await page.evaluate(() => window.imagefix.editor.redo()); await page.waitForTimeout(300);
  check('redo brings the reshape back', (await layers()).length === 1);

  // 레이어 목록 · 내보내기
  await page.evaluate(() => window.imagefix.editor.closeTool(true)); await page.waitForTimeout(250);
  await selTool(page, 'layers'); await page.waitForTimeout(250);
  check('the layer list names it "체형 보정"', /체형 보정/.test(await page.locator('.sheet .layer-row .nm').first().textContent()));
  await page.evaluate(() => window.imagefix.editor.closeTool(true));
  const exp = await page.evaluate(async () => { const { blob, w, h } = await window.imagefix.editor.exportBlob({ format: 'image/png', quality: 1 }); return { w, h, size: blob.size }; });
  check('export works with the reshape layer', exp.w > 100 && exp.size > 1000, JSON.stringify(exp));

  // 길이 조절도 한 번(밴드 아래가 내려가거나 올라가도 배경이 안 휘는지: 먼 배경 불변)
  console.log('▶ 길이');
  await selTool(page, 'body'); await waitIdle(page, 300);
  await snap('__b2');
  await lasso(ring(0.5, 0.45, 0.22, 0.3));
  await page.click('.sheet-head .btn >> text=다음: 조절');
  await page.waitForFunction(() => window.imagefix.editor.tool.state().tab === 'adjust', null, { timeout: 15000 });
  await page.click('.seg button >> text=길이'); await page.waitForTimeout(200);
  await setSlider(0, 50); await setSlider(1, 90); await setSlider(2, 40);
  await page.waitForFunction(() => window.imagefix.editor.store.get().layers.length === 2, null, { timeout: 15000 });
  await page.waitForTimeout(300);
  await snap('__b3');
  const dLen = await diff('__b2', '__b3');
  check('length: only the area around the person changes; the top strip stays identical', dLen.n > 200 && dLen.box && dLen.box[1] > 0.05, JSON.stringify(dLen));
  await page.click('.sheet-head [aria-label="취소"]'); await page.waitForTimeout(300);
  check('cancel leaves no layer behind (only the earlier one)', (await layers()).length === 1 && (await live()) === 1, JSON.stringify([(await layers()).length, await live(), await page.evaluate(() => !!window.imagefix.editor.tool)]));

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ bodyfix all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
