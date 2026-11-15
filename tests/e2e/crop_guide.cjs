// 자르기: 여권 비율(3.5×4.5cm = 7:9) 프리셋 + 얼굴 크기 가이드(정수리 선 · 턱 끝 띠 · 얼굴 틀)
//  기준: 여권 사진 가로 3.5×세로 4.5cm, 얼굴 길이(정수리~턱) 3.2~3.6cm = 사진 높이의 71~80%
const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
let bad = 0;
const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
const near = (a, b, e) => Math.abs(a - b) <= e;

(async () => {
  const h = await launch({ w: 412, h: 915, dpr: 2 });
  const { page } = h;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  await selTool(page, 'crop'); await waitIdle(page, 500);
  const chips = () => page.$$eval('.editor.ed .sheet .chip', (els) => els.map((e) => e.textContent.trim()));
  const gi = () => page.evaluate(() => window.imagefix.editor.tool.guideInfo());
  const rectPx = () => page.evaluate(() => { const ed = window.imagefix.editor, r = ed.tool.cropRect(), i = ed.info; return { r, ratio: (r[2] * i.w) / (r[3] * i.h) }; });
  /** 오버레이 캔버스의 (CSS px) 구간에서 가장 진한 픽셀 {a, r, g, b} */
  const px = (x, y, w = 1, hh = 1) => page.evaluate(([x, y, w, hh]) => {
    const cv = window.imagefix.editor.view.ui, d = cv.width / cv.getBoundingClientRect().width, c = cv.getContext('2d');
    const im = c.getImageData(Math.round(x * d), Math.round(y * d), Math.max(1, Math.round(w * d)), Math.max(1, Math.round(hh * d))).data;
    let best = { a: 0, r: 0, g: 0, b: 0 };
    for (let i = 0; i < im.length; i += 4) if (im[i + 3] >= best.a) best = { a: im[i + 3], r: im[i], g: im[i + 1], b: im[i + 2] };
    return best;
  }, [x, y, w, hh]);

  console.log('▶ 프리셋');
  const cs = await chips();
  check('"여권 3.5×4.5" is a crop preset, right after 자유 · 원본 (visible without scrolling)', cs.slice(0, 4).join() === '자유,원본,여권 3.5×4.5,1:1', cs.join('|'));
  check('the usual ratios are still there', ['1:1', '4:5', '3:4', '9:16', '16:9'].every((x) => cs.includes(x)));
  check('no guide before choosing it', (await gi()) === null && (await page.locator('.crop-guide-note').isHidden()));

  await page.click('.editor.ed .sheet .chip >> text=여권 3.5×4.5'); await page.waitForTimeout(300);
  const r1 = await rectPx();
  check('the crop frame snaps to 7:9 (35×45 mm)', near(r1.ratio, 35 / 45, 0.004), r1.ratio.toFixed(4));
  const G = await gi();
  check('a guide is available for the passport preset', G && G.key === 'passport');
  check('one-line hint under the chips', /정수리를 위 선에, 턱 끝을 초록 띠에/.test(await page.locator('.crop-guide-note').textContent()) && !(await page.locator('.crop-guide-note').isHidden()));
  check('guide geometry: crown line 3 mm from the top; chin band at +32…+36 mm (face 71–80% of the height)',
    near((G.yTop - G.y0) / G.h, 3 / 45, 1e-6) && near((G.yMin - G.yTop) / G.h, 32 / 45, 1e-6) && near((G.yMax - G.yTop) / G.h, 36 / 45, 1e-6), JSON.stringify({ top: (G.yTop - G.y0) / G.h, min: (G.yMin - G.yTop) / G.h, max: (G.yMax - G.yTop) / G.h }));
  // 캔버스에 실제로 그려졌나
  const band = await px(G.x0 + 8, (G.yMin + G.yMax) / 2);
  check('the chin band is painted (translucent green) on the overlay', band.a > 20 && band.g > band.r + 40 && band.g > band.b, JSON.stringify(band));
  const crown = await px(G.x0 + 4, G.yTop - 1.5, 40, 3);
  check('the crown line is drawn', crown.a > 120 && crown.g > 200, JSON.stringify(crown));
  const gap = await px(G.x0 + 8, (G.yTop + G.yMin) / 2 - 30);
  check('the rest of the frame stays clear (no thirds grid under the guide)', gap.a === 0, JSON.stringify(gap));
  const center = await px(G.cx - 0.5, G.y0 + G.h * 0.45, 1, 30);
  check('a vertical center line helps centering the face', center.a > 60, JSON.stringify(center));
  const ell = await px(G.ell.cx - G.ell.rx - 1.5, G.ell.cy - 3, 3, 6);
  check('a face-shaped oval is drawn from the crown line to the middle of the chin band', ell.a > 60 && near(G.ell.cy - G.ell.ry, G.yTop, 1e-6) && near(G.ell.cy + G.ell.ry, G.yMid, 1e-6), JSON.stringify(ell));
  await h.shot('p1_passport_guide');

  console.log('▶ 프레임을 옮기면 가이드도 따라간다');
  const st = await page.locator('.editor.ed .stage').boundingBox();
  const mx = (G.x0 + G.x1) / 2 + st.x * 0, my = (G.y0 + G.y1) / 2;
  await page.mouse.move(st.x + mx, st.y + my); await page.mouse.down(); await page.mouse.move(st.x + mx + 18, st.y + my + 9, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(200);
  const G2 = await gi();
  check('moving the frame moves the whole guide with it', G2 && (Math.abs(G2.x0 - G.x0) > 3 || Math.abs(G2.y0 - G.y0) > 3) && near((G2.yMin - G2.yTop) / G2.h, 32 / 45, 1e-6));
  const band2 = await px(G2.x0 + 8, (G2.yMin + G2.yMax) / 2);
  check('and it is painted at the new place', band2.a > 20 && band2.g > band2.r + 40, JSON.stringify(band2));

  console.log('▶ 펼치면 자세한 안내');
  await page.locator('.editor.ed .sheet-grab').click(); await page.waitForTimeout(250);
  await page.waitForTimeout(150);
  const lt = await page.locator('.editor.ed .sheet .sheet-note').allTextContents();
  check('expanded panel states the spec (3.5×4.5 cm, 3.2~3.6 cm, 71~80%) and tells to check the submission rules', lt.some((x) => /3\.5×세로 4\.5cm/.test(x) && /3\.2~3\.6cm/.test(x) && /71~80%/.test(x) && /제출처/.test(x)), lt.join(' | ').slice(0, 160));
  await page.locator('.editor.ed .sheet-grab').click(); await page.waitForTimeout(250);

  console.log('▶ 다른 비율 · 적용');
  await page.click('.editor.ed .sheet .chip >> text=1:1'); await page.waitForTimeout(300);
  const g3 = await gi();
  check('other ratios remove the guide (note hidden, nothing painted)', g3 === null && (await page.locator('.crop-guide-note').isHidden()) && (await px(G2.x0 + 8, (G2.yMin + G2.yMax) / 2)).g <= (await px(G2.x0 + 8, (G2.yMin + G2.yMax) / 2)).r + 5);
  await page.click('.editor.ed .sheet .chip >> text=여권 3.5×4.5'); await page.waitForTimeout(300);
  await page.click('.editor.ed .sheet [aria-label="적용"]'); await waitIdle(page, 500);
  const done = await page.evaluate(() => { const ed = window.imagefix.editor, c = ed.doc().geo.crop, i = ed.info; return { crop: c.map((v) => +v.toFixed(4)), ratio: (c[2] * i.w) / (c[3] * i.h), tool: ed.toolId }; });
  check('applying the passport crop gives a 7:9 photo and closes the tool (no guide left behind)', near(done.ratio, 35 / 45, 0.004) && done.tool === null, JSON.stringify(done));
  const errs = h.errors.filter((x) => !/willReadFrequently/.test(x)); // (테스트가 오버레이를 여러 번 읽어서 나는 브라우저 경고는 제외)
  check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  await close(h);

  console.log('▶ 영어');
  const e = await launch({ w: 412, h: 915, locale: 'en-US' });
  await openPhoto(e.page, path.join(FIX, 'portrait.jpg'));
  await selTool(e.page, 'crop'); await waitIdle(e.page, 500);
  await e.page.click('.editor.ed .sheet .chip >> text=Passport 35×45'); await e.page.waitForTimeout(300);
  check('English: preset name and hint', /Crown on the top line, chin inside the green band/.test(await e.page.locator('.crop-guide-note').textContent()));
  await close(e);

  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ crop_guide all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
