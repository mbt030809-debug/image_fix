// 도구 패널(시트) 높이 조절 E2E: 가운데 손잡이(—)를 누르고 위아래로 끌면 창 크기가 바뀐다.
//  끄는 만큼 따라 움직임 · 한계(접힘 ~ 사진 영역 최소) · 낮으면 간단 모드/높으면 전체 모드 · 도구별 기억(새로고침 후에도) ·
//  누르면 접기/펼치기(기억 지움) · 제목 줄로도 끌기(버튼은 제외) · 키보드 · 가로/태블릿은 고정
const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
let bad = 0;
const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
const near = (a, b, e) => Math.abs(a - b) <= e;

(async () => {
  let h = await launch({ w: 412, h: 915 });
  let page = h.page;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  const M = () => page.evaluate(() => {
    const ed = window.imagefix.editor, r = (e) => e.getBoundingClientRect();
    const b = ed.sheetBounds();
    const bs = getComputedStyle(ed.sheetBody);
    return { sheet: r(ed.sheetEl).height, stage: r(ed.stage).height, body: ed.sheetBody.clientHeight - (parseFloat(bs.paddingTop) || 0) - (parseFloat(bs.paddingBottom) || 0), sized: ed.sheetEl.classList.contains('sized'), peek: !!ed.peek, min: b.min, max: b.max, eh: b.eh,
      stripBottom: r(ed.strip).bottom, subTop: r(ed.subrow).top, sheetBottom: r(ed.sheetEl).bottom, vh: innerHeight, topbarBottom: r(ed.topbar).bottom, ratios: JSON.stringify(window.imagefix.settings.sheetH || null) };
  });
  /** 손잡이(또는 지정 지점)를 잡고 dy 만큼 끌기 (음수 = 위로) */
  const dragBy = async (dy, from) => {
    const g = from || (await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').boundingBox());
    const vh = await page.evaluate(() => innerHeight);
    const x = g.x + g.width / 2, y = g.y + g.height / 2;
    const to = Math.max(2, Math.min(vh - 2, y + dy)); // 화면 밖으로는 못 끈다
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x, (y + to) / 2, { steps: 4 }); await page.mouse.move(x, to, { steps: 4 });
    await page.mouse.up(); await page.waitForTimeout(150);
  };

  console.log('▶ 끌어서 높이 조절');
  await selTool(page, 'adjust'); await waitIdle(page, 300);
  const a0 = await M();
  check('starts at the automatic size (not "sized")', !a0.sized && a0.sheet > 100, JSON.stringify({ sheet: a0.sheet, stage: a0.stage }));
  await dragBy(-140);
  const a1 = await M();
  check('drag up 140px → the panel grows by 140px', near(a1.sheet, a0.sheet + 140, 3) && a1.sized, `${a0.sheet} → ${a1.sheet}`);
  check('the photo area shrinks by the same amount (nothing else moves)', near(a1.stage, a0.stage - 140, 3) && near(a1.sheetBottom, a1.subTop, 1) && a1.stripBottom <= a1.vh + 1, `${a0.stage} → ${a1.stage}`);
  check('tall panel → the tool switches to its full list (groups + all sliders)', !a1.peek && (await page.locator('.editor.ed .sheet .seg').count()) >= 1);
  check('the size is remembered for this tool (ratio of the editor height)', /"adjust":0\.\d+/.test(a1.ratios) && near(JSON.parse(a1.ratios).adjust, a1.sheet / a1.eh, 0.004), a1.ratios);
  await h.shot('s1_panel_taller');
  await dragBy(300);
  const a2 = await M();
  check('drag down 300px → shorter than the automatic size', a2.sheet < a0.sheet - 100 && a2.sized, `${a2.sheet}`);
  check('short panel → compact mode (chips + one slider)', a2.peek && (await page.locator('.editor.ed .sheet .pp-slot').count()) === 1);
  await dragBy(900);
  const a3 = await M();
  check('drag far down → collapsed to just the handle + title row (body hidden)', near(a3.sheet, a3.min, 1) && a3.body <= 1, JSON.stringify({ sheet: a3.sheet, min: a3.min, body: a3.body }));
  check('collapsed panel gives the photo the room (stage grew)', a3.stage > a0.stage + 80);
  await h.shot('s2_panel_collapsed');
  await dragBy(-1400);
  const a4 = await M();
  check('drag far up → stops at the maximum: the photo area keeps ≥ 120px and the bars stay on screen', near(a4.sheet, a4.max, 1) && a4.stage >= 120 && a4.stripBottom <= a4.vh + 1 && a4.topbarBottom > 40, JSON.stringify({ sheet: a4.sheet, max: a4.max, stage: a4.stage }));
  await h.shot('s3_panel_max');

  console.log('▶ 도구별 기억 · 누르면 접기/펼치기');
  await dragBy(260); // 적당한 높이로
  const b0 = await M();
  await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 200); // 닫기
  await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 300); // 다시 열기
  const b1 = await M();
  check('closing and reopening the tool restores the size', b1.sized && near(b1.sheet, b0.sheet, 2), `${b0.sheet} → ${b1.sheet}`);
  await page.click('.subrow [data-tool=color]'); await waitIdle(page, 300);
  const b2 = await M();
  check('another tool keeps its own (automatic) size', !b2.sized);
  await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 300);
  await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').click(); await page.waitForTimeout(250);
  const b3 = await M();
  check('a plain tap on the handle goes back to the preset sizes (and forgets the custom size)', !b3.sized && !/"adjust"/.test(b3.ratios), b3.ratios);
  await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').click(); await page.waitForTimeout(250);
  const b4 = await M();
  check('tapping again toggles compact ↔ full like before', b4.peek !== b3.peek);

  console.log('▶ 끌고 난 뒤 click 무시 · 제목 줄 · 버튼 제외');
  await dragBy(-60);
  const c0 = await M();
  const g = await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2); await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, g.y - 40, { steps: 4 }); await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2, { steps: 4 });
  await page.mouse.up(); await page.waitForTimeout(200);
  const c1 = await M();
  check('dragging away and back does not count as a tap (no accidental toggle)', c1.sized && c1.peek === c0.peek);
  const tb = await page.locator('.editor.ed #sheet-title').boundingBox();
  await dragBy(-70, tb);
  const c2 = await M();
  check('the title row works as a handle too', near(c2.sheet, c1.sheet + 70, 3), `${c1.sheet} → ${c2.sheet}`);
  const rb = await page.locator('.editor.ed .sheet:not([hidden]) .sheet-head button').first().boundingBox();
  await dragBy(-90, rb);
  const c3 = await M();
  check('a drag that starts on a title-row button (Reset / Auto) does not resize', near(c3.sheet, c2.sheet, 2), `${c2.sheet} → ${c3.sheet}`);

  console.log('▶ 키보드');
  await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').focus();
  await page.keyboard.press('ArrowUp'); await page.waitForTimeout(100);
  const k1 = await M();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.waitForTimeout(100);
  const k2 = await M();
  check('ArrowUp grows by 24px, ArrowDown shrinks by 24px', near(k1.sheet, c3.sheet + 24, 3) && near(k2.sheet, c3.sheet - 24, 3), `${c3.sheet} → ${k1.sheet} → ${k2.sheet}`);
  check('the handle is a labelled button that can be focused', (await page.locator('.editor.ed .sheet-grab').first().getAttribute('role')) === 'button' && /크기 조절/.test(await page.locator('.editor.ed .sheet-grab').first().getAttribute('aria-label')));

  console.log('▶ 크롭 도구에서도 사진이 따라 맞춰진다');
  await page.click('.strip [data-group=canvas]'); await page.waitForTimeout(150);
  await page.click('.subrow [data-tool=crop]'); await waitIdle(page, 500);
  const before = await page.evaluate(() => window.imagefix.editor.tool.cropRect());
  await dragBy(-120);
  await page.waitForTimeout(200);
  const inside = await page.evaluate(() => { const ed = window.imagefix.editor, p = ed.view.photo.getBoundingClientRect(), s = ed.stage.getBoundingClientRect(); return p.left >= s.left - 1 && p.right <= s.right + 1 && p.top >= s.top - 1 && p.bottom <= s.bottom + 1; });
  const after = await page.evaluate(() => window.imagefix.editor.tool.cropRect());
  check('after resizing, the whole photo is still fitted inside the (smaller) photo area', inside);
  check('dragging the handle never moves the crop frame', JSON.stringify(before) === JSON.stringify(after));
  await selTool(page, 'crop'); // 닫기

  console.log('▶ 새로고침 후에도 기억');
  await selTool(page, 'adjust'); await waitIdle(page, 300);
  await dragBy(-100);
  const r0 = await M();
  await page.reload(); await page.waitForTimeout(400);
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  await selTool(page, 'adjust'); await waitIdle(page, 400);
  const r1 = await M();
  check('the saved size comes back after a reload', r1.sized && near(r1.sheet, r0.sheet, 3), `${r0.sheet} → ${r1.sheet}`);
  check('no console errors', h.errors.length === 0, h.errors.slice(0, 2).join(' | '));
  await close(h);

  console.log('▶ 작은 폰(320×640)');
  h = await launch({ w: 320, h: 640 }); page = h.page;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  await selTool(page, 'filter'); await waitIdle(page, 400);
  await dragBy(-900);
  const s1 = await M();
  check('320px: maximum keeps the photo area ≥ 120px and the bars visible', s1.stage >= 120 && s1.stripBottom <= s1.vh + 1 && near(s1.sheet, s1.max, 1), JSON.stringify({ stage: s1.stage, sheet: s1.sheet, max: s1.max }));
  await dragBy(1200);
  const s2 = await M();
  check('320px: collapses to the title row', near(s2.sheet, s2.min, 1));
  await close(h);

  console.log('▶ 가로(844×390): 옆 패널은 그대로');
  h = await launch({ w: 844, h: 390 }); page = h.page;
  await page.addInitScript(() => {});
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  await page.evaluate(() => { const s = window.imagefix.settings; s.sheetH = { adjust: 0.6, filter: 0.6 }; window.imagefix.saveSettings(); });
  await selTool(page, 'adjust'); await waitIdle(page, 400);
  const L = await page.evaluate(() => { const ed = window.imagefix.editor; return { sized: ed.sheetEl.classList.contains('sized'), grab: getComputedStyle(ed.grab).display, sheetH: Math.round(ed.sheetEl.getBoundingClientRect().height), stageH: Math.round(ed.stage.getBoundingClientRect().height) }; });
  check('side panel: no handle, a stored size is ignored, the panel fills the height', !L.sized && L.grab === 'none' && Math.abs(L.sheetH - L.stageH) <= 1, JSON.stringify(L));
  await close(h);

  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ sheet_resize all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
