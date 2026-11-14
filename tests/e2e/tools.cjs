// 모든 도구를 차례로 열어 대표 동작을 실행하고 스크린샷/오류를 수집
const path = require('path');
const { launch, close, openPhoto, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
const fails = [];
async function step(name, fn) { try { await fn(); } catch (e) { fails.push(name + ': ' + String(e.message).split('\n')[0]); console.log('  ✗', name, String(e.message).split('\n')[0]); } }

(async () => {
  const h = await launch();
  const { page } = h;
  await openPhoto(page, path.join(FIX, process.argv[2] || 'landscape.jpg'));
  const stage = await page.locator('.screen:not([hidden]) .stage').first().boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  const setSlider = async (idx, v) => page.evaluate(([i, v]) => { const s = document.querySelectorAll('.sheet .slider')[i]; s.value = v; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); }, [idx, v]);
  const tool = async (id, wait = 500) => { await page.click(`[data-tool=${id}]`); await waitIdle(page, wait); };
  const drag = async (pts) => { await page.mouse.move(pts[0][0], pts[0][1]); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 4 }); await page.mouse.up(); await waitIdle(page, 300); };

  await step('adjust', async () => { await tool('adjust'); await setSlider(0, 30); await waitIdle(page, 300); await page.click('.chip >> text=대비'); await setSlider(0, 35); await page.click('.sheet-grab'); await page.waitForTimeout(250); await h.shot('t01_adjust'); });
  await step('color', async () => { await tool('color'); await page.click('.chip >> text=파랑'); await setSlider(1, 60); await h.shot('t02_color_hsl'); await page.click('.seg button >> text=컬러 그레이딩'); await page.click('.chip >> text=틸&오렌지'); await waitIdle(page, 400); await h.shot('t03_color_grade'); });
  await step('curves', async () => { await tool('curves'); const b = await page.locator('.curve canvas').boundingBox(); await drag([[b.x + b.width * 0.5, b.y + b.height * 0.5], [b.x + b.width * 0.5, b.y + b.height * 0.3]]); await h.shot('t04_curves'); });
  await step('effects', async () => { await tool('effects', 800); await page.click('.thumb[data-id=tilt]'); await waitIdle(page, 500); await h.shot('t05_effects_tilt'); await page.click('.thumbs .thumb[data-id=blur]'); await waitIdle(page, 300); });
  await step('effects2', async () => { await page.click('.chip >> text=아트'); await page.click('.thumb[data-id=oil]'); await waitIdle(page, 800); await h.shot('t06_effects_oil'); });
  await step('retouch', async () => { await tool('retouch'); await page.click('.btn >> text=소스 지정').catch(() => {}); await page.mouse.click(cx - 80, cy); await page.waitForTimeout(200); await drag([[cx + 60, cy + 20], [cx + 110, cy + 30]]); await h.shot('t07_retouch'); });
  await step('retouch-erase', async () => { await page.click('.seg button >> text=지우기'); await drag([[cx - 20, cy - 40], [cx + 10, cy - 30]]); await page.click('.seg button >> text=왜곡'); await drag([[cx - 100, cy + 50], [cx - 60, cy + 60]]); });
  await step('brush', async () => { await tool('brush'); await page.click('.chip >> text=밝게'); await waitIdle(page, 300); await drag([[cx - 100, cy - 80], [cx + 100, cy - 60], [cx + 100, cy]]); await h.shot('t08_brush'); });
  await step('brush-linear', async () => { await page.click('.sheet-head .iconbtn[aria-label="마스크 추가"]'); await page.click('.chip >> text=선형'); await waitIdle(page, 300); await setSlider(0, -40); await h.shot('t09_brush_linear'); });
  await step('text', async () => { await tool('text'); await page.click('.btn >> text=텍스트 추가'); await waitIdle(page, 300); await page.fill('.sheet textarea', 'Hello 안녕'); await waitIdle(page, 300); await h.shot('t10_text'); await page.click('.seg button >> text=효과'); await h.shot('t11_text_fx'); });
  await step('text-drag', async () => { await drag([[cx, cy], [cx - 60, cy - 100]]); });
  await step('sticker', async () => { await tool('sticker'); await page.click('.grid-btns .gbtn >> nth=3'); await waitIdle(page, 300); await page.click('.seg button >> text=도형'); await page.click('.grid-btns .gbtn >> nth=9'); await waitIdle(page, 300); await h.shot('t12_sticker'); });
  await step('draw', async () => { await tool('draw'); await drag([[cx - 120, cy + 100], [cx - 40, cy + 60], [cx + 40, cy + 120], [cx + 120, cy + 70]]); await page.click('.chip >> text=네온'); await drag([[cx - 120, cy - 120], [cx, cy - 150], [cx + 120, cy - 110]]); await h.shot('t13_draw'); });
  await step('frame', async () => { await tool('frame', 700); await page.click('.thumb[data-id=polaroid]'); await waitIdle(page, 500); await h.shot('t14_frame'); });
  await step('layers', async () => { await tool('layers'); await h.shot('t15_layers'); });
  await step('cutout', async () => { await tool('cutout'); await page.click('.btn >> text=자동'); await waitIdle(page, 800); await h.shot('t16_cutout'); });
  await step('crop', async () => { await tool('crop'); await page.click('.chip >> text=1:1'); await page.waitForTimeout(300); await page.click('[aria-label="오른쪽으로 90° 회전"]'); await waitIdle(page, 500); await h.shot('t17_crop'); await page.click('[aria-label="적용"]'); await waitIdle(page, 600); await h.shot('t18_after_crop'); });
  await step('undo-redo', async () => { for (let i = 0; i < 3; i++) await page.click('[aria-label="실행 취소"]'); await waitIdle(page, 400); await page.click('[aria-label="다시 실행"]'); await waitIdle(page, 400); await h.shot('t19_undo'); });
  await step('export', async () => { await page.click('.topbar .btn.filled'); await page.waitForTimeout(300); await h.shot('t20_export'); const dl = page.waitForEvent('download', { timeout: 20000 }); await page.click('[data-act=save]'); const d = await dl; console.log('  download:', d.suggestedFilename()); });
  console.log('errors:', h.errors.length ? '\n' + h.errors.slice(0, 20).join('\n') : 'none');
  console.log('fails:', fails.length ? '\n' + fails.join('\n') : 'none');
  await close(h);
})().catch((e) => { console.error(e); process.exit(1); });
