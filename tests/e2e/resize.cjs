// 크기 도구(프리셋/직접 입력/맞춤 방식) + 저장 결과 해상도, 번들 폰트 로드, 유동화 라벨 검증
const path = require('path');
const fs = require('fs');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

function jpegSize(buf) {
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

(async () => {
  const h = await launch();
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));

  const exportAndSize = async () => {
    await page.click('.screen:not([hidden]) .topbar .btn.filled');
    await page.waitForTimeout(300);
    const dl = page.waitForEvent('download', { timeout: 60000 });
    await page.click('[data-act=save]');
    const d = await dl;
    const p = await d.path();
    return jpegSize(fs.readFileSync(p));
  };

  // 1) 프리셋: 인스타 4:5 → 채우기
  await page.click('[data-tool=resize]'); await waitIdle(page, 300);
  await h.shot('z1_resize_panel');
  await page.click('.chip >> text=인스타 4:5');
  await waitIdle(page, 500);
  const st1 = await page.evaluate(() => { const d = window.imagefix.editor.doc(); return { out: d.out, crop: d.geo.crop }; });
  const asp = (st1.crop[2] * 2000) / (st1.crop[3] * 1500);
  check('preset sets out 1080x1350', st1.out && st1.out.w === 1080 && st1.out.h === 1350, JSON.stringify(st1.out));
  check('fill crops to 4:5 aspect', Math.abs(asp - 0.8) < 0.01, 'aspect=' + asp.toFixed(3));
  await page.click('[aria-label="적용"]'); await waitIdle(page, 500);
  await h.shot('z2_resize_applied');
  const s1 = await exportAndSize();
  check('export is 1080x1350', s1 && s1[0] === 1080 && s1[1] === 1350, JSON.stringify(s1));

  // 2) 여백(letterbox) 1080x1920
  await page.click('[data-tool=resize]'); await waitIdle(page, 300);
  await page.click('.chip >> text=스토리·릴스');
  await page.click('.seg button >> text=여백'); await waitIdle(page, 600);
  await h.shot('z3_resize_bars');
  const fr = await page.evaluate(() => window.imagefix.editor.doc().frame);
  check('bars mode sets frame aspect 1080:1920', fr && fr.aspect === '1080:1920', JSON.stringify(fr && fr.aspect));
  await page.click('[aria-label="적용"]'); await waitIdle(page, 500);
  const s2 = await exportAndSize();
  check('export is 1080x1920', s2 && s2[0] === 1080 && s2[1] === 1920, JSON.stringify(s2));

  // 3) 직접 입력(가로 800, 비율 고정) + 늘이기
  await page.click('[data-tool=resize]'); await waitIdle(page, 300);
  await page.fill('input[aria-label="가로(px)"]', '800'); await page.dispatchEvent('input[aria-label="가로(px)"]', 'change');
  await page.click('.seg button >> text=늘이기'); await waitIdle(page, 300);
  const o3 = await page.evaluate(() => window.imagefix.editor.doc().out);
  check('custom width keeps ratio (stretch mode)', o3 && o3.w === 800 && o3.h > 0, JSON.stringify(o3));
  await page.click('[aria-label="적용"]'); await waitIdle(page, 400);
  const s3 = await exportAndSize();
  check('export matches custom size', s3 && s3[0] === o3.w && s3[1] === o3.h, JSON.stringify(s3) + ' vs ' + o3.w + 'x' + o3.h);

  // 4) 해제
  await page.click('[data-tool=resize]'); await waitIdle(page, 300);
  await page.click('.btn >> text=지정 해제'); await waitIdle(page, 400);
  await page.click('[aria-label="적용"]'); await waitIdle(page, 300);
  check('clear resets out/frame', await page.evaluate(() => { const d = window.imagefix.editor.doc(); return !d.out && !(d.frame && d.frame.fromResize); }));

  // 5) 번들 폰트
  await page.click('[data-tool=text]'); await waitIdle(page, 300);
  await page.click('.btn >> text=텍스트 추가'); await waitIdle(page, 300);
  await page.fill('.sheet textarea', '안녕하세요 Hello'); await page.dispatchEvent('.sheet textarea', 'change');
  await page.click('.chip >> text=블랙한산스'); await page.waitForTimeout(1200);
  const fontOk = await page.evaluate(async () => { await document.fonts.load('40px "Black Han Sans"', '안녕하세요'); return document.fonts.check('40px "Black Han Sans"', '안녕하세요'); });
  check('Black Han Sans loads (Korean subset)', fontOk);
  await h.shot('z4_font_blackhan');
  await page.click('.chip >> text=주아'); await page.waitForTimeout(800); await h.shot('z5_font_jua');
  await page.click('.chip >> text=손글씨 펜'); await page.waitForTimeout(1000); await h.shot('z6_font_pen');
  await page.click('.chip >> text=파시피코'); await page.waitForTimeout(600);
  await page.evaluate(() => window.__onBack());

  // 6) 유동화 라벨
  await page.click('[data-tool=retouch]'); await waitIdle(page, 300);
  check('liquify tab labelled 유동화', (await page.locator('.seg button >> text=유동화').count()) === 1);
  await page.click('.seg button >> text=유동화');
  check('twirl ccw mode exists', (await page.locator('.chip >> text=비틀기 ↺').count()) === 1);
  await h.shot('z7_liquify');

  console.log('errors:', h.errors.join('\n') || 'none');
  await close(h);
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
