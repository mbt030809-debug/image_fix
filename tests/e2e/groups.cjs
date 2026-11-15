// 상위/하위 목록(분류) E2E: 하단 줄에는 6개 분류만 → 분류를 누르면 하위 목록 → 하위를 누르면 도구 패널
//  캔버스(자르기·크기·프레임) · 보정(조정·색상·곡선·필터·효과) · 다듬기(리터치·브러시·배경 제거) · 꾸미기(텍스트·스티커·그리기) · AI 도구(영역 수정·이미지 만들기·AI 설정) · 레이어(바로)
const path = require('path');
const { launch, close, openPhoto, waitIdle, selTool, GROUP_OF } = require('./lib.cjs');
const { init } = require('./ai_lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
let bad = 0;
const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };

(async () => {
  // ---------------------------------------------------------------- 1) 구조·동작 (폰 세로)
  console.log('▶ 분류 → 하위 목록 → 도구');
  let h = await launch({ w: 412, h: 915 });
  let page = h.page;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));
  const groupSel = () => page.$$eval('.strip [data-group][aria-selected=true]', (els) => els.map((e) => e.dataset.group));
  const subSel = () => page.$$eval('.subrow [aria-selected=true]', (els) => els.map((e) => e.dataset.tool || e.dataset.action));
  const sheetOpen = () => page.evaluate(() => !document.querySelector('.editor.ed .sheet').hidden);
  const title = () => page.locator('.editor.ed #sheet-title').textContent();
  const subVisible = () => page.evaluate(() => !document.querySelector('.editor.ed .subrow').hidden);
  const noScroll = (sel) => page.$eval(sel, (el) => el.scrollWidth <= el.clientWidth + 1);
  // 글자 전체 폭(Range) 이 칸 안에 들어가나 — scrollWidth 는 ellipsis 일 때 믿을 수 없다
  const noTrunc = (sel) => page.$$eval(sel, (els) => els.every((e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width <= e.clientWidth + 0.5; }));

  check('bottom bar shows exactly the six groups, in order', (await texts('.strip [data-group] .lbl')).join() === '캔버스,보정,다듬기,꾸미기,AI 도구,레이어', (await texts('.strip [data-group] .lbl')).join());
  check('only "layers" is a direct tool in the bar (the 15 others live in sub-lists)', (await page.$$eval('.strip [data-tool]', (els) => els.map((e) => e.dataset.tool))).join() === 'layers');
  check('nothing is expanded at first: sub-list hidden, no tool open', !(await subVisible()) && !(await sheetOpen()) && (await groupSel()).length === 0);
  check('six groups fit in one row without scrolling, labels not cut', (await noScroll('.strip')) && (await noTrunc('.strip .lbl')));
  await h.shot('n1_groups_collapsed');

  await page.click('.strip [data-group=tune]'); await page.waitForTimeout(150);
  check('tap a group → its sub-list appears (no tool opens yet)', (await subVisible()) && !(await sheetOpen()) && (await texts('.subrow .lbl')).join() === '조정,색상,곡선,필터,효과', (await texts('.subrow .lbl')).join());
  check('the group is marked selected; the sub-list fits in one row', (await groupSel()).join() === 'tune' && (await noScroll('.subrow')) && (await noTrunc('.subrow .lbl')));
  await h.shot('n2_tune_sublist');
  await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 300);
  check('tap a sub item → the usual panel opens', (await sheetOpen()) && (await title()) === '조정' && (await subSel()).join() === 'adjust');
  await h.shot('n3_adjust_panel');
  await page.click('.subrow [data-tool=color]'); await waitIdle(page, 300);
  check('switch within the group in one tap; group stays open', (await title()) === '색상' && (await subSel()).join() === 'color' && (await groupSel()).join() === 'tune');
  await page.click('.strip [data-group=refine]'); await page.waitForTimeout(200);
  check('tapping another group closes the open tool and shows that group', !(await sheetOpen()) && (await texts('.subrow .lbl')).join() === '리터치,브러시,배경 제거' && (await groupSel()).join() === 'refine');
  await page.click('.subrow [data-tool=cutout]'); await waitIdle(page, 300);
  check('"배경 제거" lives under 다듬기', (await title()) === '배경 제거' && (await subSel()).join() === 'cutout');
  await page.evaluate(() => window.imagefix.editor.openTool('text')); await waitIdle(page, 300);
  check('opening a tool from code (e.g. layers → edit) syncs group + sub-list', (await groupSel()).join() === 'decor' && (await texts('.subrow .lbl')).join() === '텍스트,스티커,그리기' && (await subSel()).join() === 'text');
  await page.click('.strip [data-group=decor]'); await page.waitForTimeout(200);
  check('tapping the open group again collapses it (closes tool, hides sub-list)', !(await sheetOpen()) && !(await subVisible()) && (await groupSel()).length === 0);
  await page.click('.strip [data-group=tune]'); await page.waitForTimeout(150);
  await page.evaluate(() => window.__onBack()); await page.waitForTimeout(150);
  check('Back with only a sub-list open collapses it (does not leave the editor)', !(await subVisible()) && (await groupSel()).length === 0 && (await page.evaluate(() => window.imagefix.screen)) === 'editor');
  await page.click('.strip [data-group=tune]'); await page.waitForTimeout(100);
  await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 200);
  await page.evaluate(() => window.__onBack()); await page.waitForTimeout(150);
  check('Back with a tool open closes the tool first; the sub-list stays', !(await sheetOpen()) && (await subVisible()));
  await page.evaluate(() => window.__onBack()); await page.waitForTimeout(150);
  check('then Back collapses the sub-list', !(await subVisible()));
  await page.click('.strip [data-tool=layers]'); await waitIdle(page, 300);
  check('"레이어" opens directly (no sub-list), group marked', (await sheetOpen()) && (await title()) === '레이어' && !(await subVisible()) && (await groupSel()).join() === 'layers');
  await page.click('.strip [data-tool=layers]'); await waitIdle(page, 200);
  check('tapping 레이어 again closes it', !(await sheetOpen()) && (await groupSel()).length === 0);
  await page.click('.strip [data-tool=layers]'); await waitIdle(page, 200);
  await page.click('.strip [data-group=canvas]'); await page.waitForTimeout(200);
  check('from 레이어 to a group: layers closes, canvas sub-list shows 자르기·크기·프레임', !(await sheetOpen()) && (await texts('.subrow .lbl')).join() === '자르기,크기,프레임' && (await groupSel()).join() === 'canvas');
  await page.click('.subrow [data-tool=frame]'); await waitIdle(page, 300);
  check('"프레임" lives under 캔버스 (next to 자르기·크기)', (await title()) === '프레임' && (await subSel()).join() === 'frame');

  // 16개 도구가 모두 열린다(분류 경유)
  const ids = Object.keys(GROUP_OF);
  const opened = [];
  for (const id of ids) {
    await selTool(page, id); await waitIdle(page, 120);
    const got = await page.evaluate(() => ({ id: window.imagefix.editor.toolId, open: !document.querySelector('.editor.ed .sheet').hidden }));
    opened.push(got.id === id && got.open);
  }
  check('all 16 tools open through their group', opened.length === 16 && opened.every(Boolean), JSON.stringify(opened.map((o, i) => (o ? '' : ids[i])).filter(Boolean)));
  await selTool(page, 'adjust'); await page.waitForTimeout(100);

  // 새 사진 → 접힘으로 시작
  await page.evaluate(() => window.imagefix.goHome(true)); await page.waitForTimeout(200);
  await openPhoto(page, path.join(FIX, 'landscape.jpg'));
  check('a new photo starts with everything collapsed', !(await subVisible()) && !(await sheetOpen()) && (await groupSel()).length === 0);
  check('no console errors', h.errors.length === 0, h.errors.slice(0, 2).join(' | '));
  await close(h);

  // ---------------------------------------------------------------- 2) 좁은 폰(320) + 영어
  console.log('▶ 좁은 화면(320px) · 영어');
  h = await launch({ w: 320, h: 640, locale: 'en-US' }); page = h.page;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  check('English group names', (await texts('.strip [data-group] .lbl')).join() === 'Canvas,Tune,Refine,Overlay,AI tools,Layers', (await texts('.strip [data-group] .lbl')).join());
  check('320px: six groups still fit, labels not cut', (await noScroll('.strip')) && (await noTrunc('.strip .lbl')));
  await page.click('.strip [data-group=tune]'); await page.waitForTimeout(150);
  check('English sub-list', (await texts('.subrow .lbl')).join() === 'Adjust,Color,Curves,Filters,Effects', (await texts('.subrow .lbl')).join());
  check('no horizontal page overflow; sub-list labels not cut (it may scroll)', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1) && (await noTrunc('.subrow .lbl')));
  await page.click('.strip [data-group=aitools]'); await page.waitForTimeout(150);
  check('English AI sub-list', (await texts('.subrow .lbl')).join() === 'Area edit,Create image,AI settings', (await texts('.subrow .lbl')).join());
  await h.shot('n4_narrow320_english');
  await selTool(page, 'ai'); await waitIdle(page, 300);
  check('AI panel title spells out "AI area edit"', (await title()) === 'AI area edit');
  await close(h);

  // ---------------------------------------------------------------- 3) 가로 / 태블릿: 레일(분류) + 하위 레일 + 옆 패널
  for (const [name, w, hh] of [['landscape', 844, 390], ['tablet', 900, 1100]]) {
    console.log('▶ ' + name);
    h = await launch({ w, h: hh }); page = h.page;
    await openPhoto(page, path.join(FIX, 'landscape.jpg'));
    await page.click('.strip [data-group=tune]'); await page.waitForTimeout(200);
    await page.click('.subrow [data-tool=adjust]'); await waitIdle(page, 400);
    const R = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
      return { strip: r('.editor.ed .strip'), sub: r('.editor.ed .subrow'), stage: r('.editor.ed .stage'), sheet: r('.editor.ed .sheet'), vw: innerWidth, vh: innerHeight, over: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    check(name + ': rail | sub-rail | photo | side panel sit side by side without overlapping', R.strip.l === 0 && R.strip.r <= R.sub.l + 1 && R.sub.r <= R.stage.l + 1 && R.stage.r <= R.sheet.l + 1 && R.sheet.r <= R.vw + 1, JSON.stringify(R));
    check(name + ': no horizontal overflow', !R.over);
    check(name + ': sub-rail lists the five 보정 tools', (await texts('.subrow .lbl')).join() === '조정,색상,곡선,필터,효과');
    await h.shot('n5_' + name + '_rail');
    await page.click('.strip [data-group=tune]'); await page.waitForTimeout(150);
    const R2 = await page.evaluate(() => { const b = document.querySelector('.editor.ed .stage').getBoundingClientRect(); const s = document.querySelector('.editor.ed .subrow').hidden; return { stageL: Math.round(b.left), subHidden: s }; });
    check(name + ': collapsing the group gives the width back (sub-rail column disappears)', R2.subHidden && R2.stageL <= 73, JSON.stringify(R2));
    await close(h);
  }

  // ---------------------------------------------------------------- 4) AI 도구 묶음(앱): 이미지 만들기·AI 설정
  console.log('▶ AI 도구 (네이티브 연결 시)');
  h = await launch({ init, shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }] }); page = h.page;
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await page.waitForTimeout(300);
  await page.click('.strip [data-group=aitools]'); await page.waitForTimeout(200);
  check('AI group: 영역 수정 · 이미지 만들기 · AI 설정', (await texts('.subrow .lbl')).join() === '영역 수정,이미지 만들기,AI 설정', (await texts('.subrow .lbl')).join());
  check('the two actions are not tools (no selected state, no panel)', (await page.$$eval('.subrow [data-action]', (els) => els.map((e) => e.dataset.action))).join() === 'aigen,aiset' && !(await sheetOpen()));
  await page.click('.subrow [data-action=aiset]'); await page.waitForTimeout(300);
  check('"AI 설정" opens the AI settings', (await page.locator('.msheet h2').last().textContent()) === 'AI 설정');
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  await page.click('.subrow [data-action=aigen]'); await page.waitForTimeout(300);
  check('"이미지 만들기" opens the generator right away when nothing is edited', (await page.locator('.msheet h2').last().textContent()) === 'AI로 이미지 만들기' && (await page.locator('.dialog').count()) === 0);
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  await page.evaluate(() => window.imagefix.editor.apply((d) => ({ ...d, adj: { ...d.adj, exposure: 20 } }), 'test'));
  await page.click('.subrow [data-action=aigen]'); await page.waitForTimeout(300);
  check('with unsaved edits it asks first (the generated image replaces the photo)', (await page.locator('.dialog h2, .dialog [role=heading], .dialog').first().textContent()).includes('새 이미지를 만들까요?') && (await page.locator('.msheet').count()) === 0);
  await page.click('.dialog .btn >> text=계속 편집'); await page.waitForTimeout(250);
  check('"Keep editing" cancels: no generator, edits kept', (await page.locator('.msheet').count()) === 0 && (await page.evaluate(() => window.imagefix.editor.doc().adj.exposure)) === 20);
  await page.click('.subrow [data-action=aigen]'); await page.waitForTimeout(250);
  await page.click('.dialog .btn >> text=이미지 만들기'); await page.waitForTimeout(300);
  check('confirming opens the generator', (await page.locator('.msheet h2').last().textContent()) === 'AI로 이미지 만들기');
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  await selTool(page, 'ai'); await waitIdle(page, 400);
  check('"영역 수정" opens the area-edit tool as before', (await title()) === 'AI 영역 수정' && (await page.locator('.seg button >> text=영역 선택').count()) === 1);
  check('no console errors (native present)', h.errors.length === 0, h.errors.slice(0, 2).join(' | '));
  await close(h);

  // 네이티브 없음: 안내만
  h = await launch({ w: 412, h: 915 }); page = h.page;
  await openPhoto(page, path.join(FIX, 'portrait.jpg'));
  await page.click('.strip [data-group=aitools]'); await page.waitForTimeout(150);
  await page.click('.subrow [data-action=aiset]'); await page.waitForTimeout(200);
  check('without the app (plain browser) the AI actions explain themselves', /앱\(APK\)에서만/.test(await page.locator('.snackbar').textContent()) && (await page.locator('.msheet').count()) === 0);
  await close(h);

  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ groups all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
