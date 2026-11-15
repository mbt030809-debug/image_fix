// AI 영역 수정 E2E (Cloudflare): 가짜 window.Android(AI 릴레이)로 선택(올가미) → 키 설정 → 동의 → 요청(원본 + 표시 이미지 검증) → 결과 합성(선택 안쪽만) →
// 적용/실행 취소/레이어/저장 내보내기 → 오류·취소 → 두 번째 수정 → 자동 복구(새로고침 후 복원)까지 확인한다.
const path = require('path');
const { launch, close, waitIdle, selTool } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

const { init, installRoute, helpers } = require('./ai_lib.cjs');

const ACC = '0123456789abcdef0123456789abcdef';
const KLEIN = '@cf/black-forest-labs/flux-2-klein-4b';

let HH = null;
(async () => {
  const h = HH = await launch({ shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }], init });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await installRoute(page);
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await waitIdle(page, 300);

  const { pt, lasso, sel, px, layers } = helpers(page);

  // ---------------------------------------------------------------- 1) 열기 + 올가미 선택
  console.log('▶ 선택');
  await selTool(page, 'ai'); await waitIdle(page, 300);
  check('AI tool opens with step tabs', (await page.locator('.seg button >> text=영역 선택').count()) === 1 && (await page.locator('.seg button >> text=AI 요청').count()) === 1);
  check('AI group in the bottom bar + "영역 수정" in its sub-row, panel titled "AI 영역 수정"', (await page.locator('.strip [data-group=aitools] .lbl').textContent()) === 'AI 도구' && (await page.locator('.subrow [data-tool=ai] .lbl').textContent()) === '영역 수정' && (await page.locator('#sheet-title').textContent()) === 'AI 영역 수정');
  const before = { center: await px(0.51, 0.49), corner: await px(0.1, 0.1) };
  await lasso();
  let s = await sel();
  check('lasso selects the region (≈8% of photo)', s.cov > 0.05 && s.cov < 0.13 && s.center === 255 && s.corner === 0, JSON.stringify(s));
  await h.shot('a1_select');
  // 빼기 + 되돌리기 + 반전/해제 버튼
  await page.click('.seg button >> text=빼기');
  await page.click('.seg button >> text=사각형');
  { const [x0, y0] = await pt(0.47, 0.44), [x1, y1] = await pt(0.55, 0.54); await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await page.mouse.move(x1, y1, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(150); }
  s = await sel();
  check('subtract rectangle punches a hole', s.center === 0 && s.cov > 0.03 && s.cov < 0.1, JSON.stringify(s));
  await page.click('[aria-label="선택 되돌리기"]'); await page.waitForTimeout(100);
  s = await sel();
  check('undo selection restores the hole', s.center === 255, JSON.stringify(s));
  await page.click('.seg button >> text=추가');
  await page.click('.seg button >> text=올가미');

  // ---------------------------------------------------------------- 2) 요청 탭 → 키 없음 → 설정 → 키 저장
  console.log('▶ 키 설정 / 동의');
  await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(150);
  check('setup banner shown without key (key setup only — every provider needs a key now)', (await page.locator('.ai-setup').count()) === 1 && (await page.locator('.ai-setup .btn >> text=키 설정').count()) === 1 && (await page.locator('.ai-setup .btn').count()) === 1);
  check('default provider is Cloudflare (the only one that edits with the photo)', /Cloudflare/.test(await page.locator('.sheet-body .row.wrap .sheet-note').first().textContent()) && (await page.locator('.seg button >> text=사진 보고 편집').count()) === 1);
  await page.fill('.sheet textarea.ai-prompt', '셔츠를 파란색으로 바꿔 주세요');
  await h.shot('a2_ask');
  await page.click('.sheet-head .btn >> text=AI로 수정'); await page.waitForTimeout(200);
  check('running without key opens AI settings', (await page.locator('.msheet').count()) === 1 && (await page.locator('.msheet h2').first().textContent()) === 'AI 설정');
  check('settings offer exactly Cloudflare / ModelScope / Gemini / Hugging Face (OpenAI, OpenRouter, Pollinations are gone)', (await page.locator('.msheet .chip[data-id]').evaluateAll((els) => els.map((e) => e.dataset.id))).join() === 'cloudflare,modelscope,gemini,huggingface');
  await page.fill('.msheet input[name=imagefix-ai-account]', ACC);
  await page.fill('.msheet input[type=password]', 'cf-token-abcdef123456');
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('key saved natively (hint shown, input cleared)', (await page.locator('.msheet .kv b').textContent()).includes('3456') && (await page.inputValue('.msheet input[type=password]')) === '' && JSON.stringify(await page.evaluate(() => window.__ai.setKeyCalls.at(-1))) === JSON.stringify(['cloudflare', 'key', ACC]));
  await h.shot('a6_settings');
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  const tm = await page.locator('.msheet .ai-msg').textContent();
  check('connection test lists the FLUX image models only', /flux-2-klein-4b/.test(tm) && /flux-2-dev/.test(tm) && !/llama/.test(tm), tm);
  await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150);

  // ---------------------------------------------------------------- 3) 요청 → 동의 → 결과
  console.log('▶ 요청 / 결과');
  await page.click('.sheet-head .btn >> text=AI로 수정'); await page.waitForTimeout(250);
  check('consent dialog before the first request names the server', (await page.locator('.dialog').count()) === 1 && /api\.cloudflare\.com/.test(await page.locator('.dialog p').textContent()));
  await page.evaluate(() => { window.__ai.delay = 3000; }); // 진행 중 화면을 확인하는 동안(스크린샷 포함) 요청이 끝나 버리지 않게 가짜 서버를 느리게
  await page.click('.dialog .btn >> text=동의하고 계속');
  await page.waitForFunction(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase === 'busy', null, { timeout: 5000 });
  await page.waitForSelector('.ai-sent', { timeout: 15000 }); // 이미지 준비가 끝나 "보낸 이미지"가 보일 때까지
  await h.shot('a3_busy');
  check('busy state shows sent image preview + cancel', (await page.locator('.ai-sent').count()) === 1 && (await page.locator('.sheet-head .btn >> text=취소').count()) === 1);
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'review', null, { timeout: 20000 });
  await page.evaluate(() => { window.__ai.delay = 600; });
  await page.waitForTimeout(250);
  const log = await page.evaluate(() => window.__ai.log);
  const bg = await page.evaluate(() => ({ keep: window.__ai.keep, notes: window.__ai.notes }));
  check('background: keep-alive was switched on for the request and off when it finished, with a "ready" notification', bg.keep.length === 2 && bg.keep[0][0] === true && /백그라운드|나가도|앱을 나가도/.test(bg.keep[0][1]) && bg.keep[1][0] === false && bg.notes.length === 1 && /준비됐어요/.test(bg.notes[0][1]), JSON.stringify(bg));
  const rq = log.find((l) => l.kind === 'edit');
  check('model auto-resolved to FLUX.2 klein 4B', rq && rq.model === KLEIN && rq.path === '/accounts/{account}/ai/run/' + KLEIN, rq && rq.model);
  check('request: multipart with the original + the marked copy', rq && rq.type === 'multipart/form-data' && rq.files.join() === 'image.png,marked.png');
  check('request: input < 512 px (Cloudflare limit), output = 2× input, marked copy same size', rq && rq.imgW <= 480 && rq.imgH <= 480 && rq.width === rq.imgW * 2 && rq.height === rq.imgH * 2 && rq.markedW === rq.imgW && rq.markedH === rq.imgH, rq && `${rq.imgW}x${rq.imgH} → ${rq.width}x${rq.height}`);
  check('request: prompt = instruction (both images, magenta) + user text', rq && /Image 1/.test(rq.prompt) && /Image 2/.test(rq.prompt) && /magenta/.test(rq.prompt) && /셔츠를 파란색으로 바꿔 주세요$/.test(rq.prompt));
  const tf = rq ? rq.transparent / (rq.imgW * rq.imgH) : 0;
  check('request: the marked copy highlights the selection (and only it), inside the image', tf > 0.04 && tf < 0.6 && rq.bbox[0] > 0 && rq.bbox[1] > 0 && rq.bbox[2] < rq.imgW && rq.bbox[3] < rq.imgH, JSON.stringify([tf.toFixed(3), rq && rq.bbox]));
  check('request: only the selected area + context was sent (not the whole photo)', rq && rq.len < 2 * 1024 * 1024 && rq.imgW <= 480);
  const mid = await px(0.51, 0.49), corner = await px(0.1, 0.1);
  check('result blended inside the selection (tone-matched AI color)', mid.every((v, i) => Math.abs(v - [214, 34, 194][i]) <= 6), JSON.stringify(mid));
  check('pixels far outside the selection are untouched', corner.every((v, i) => v === before.corner[i]), JSON.stringify([corner, before.corner]));
  await h.shot('a4_review');
  check('review actions: apply + discard; a single result has no variant picker', (await page.locator('.sheet-head .btn >> text=적용').count()) === 1 && (await page.locator('[aria-label="버리기"]').count()) === 1 && (await page.locator('.sheet .thumb').count()) === 0);
  check('no quality / variant-count options any more', (await page.locator('.sheet .sheet-sec >> text=품질').count()) === 0 && (await page.locator('.seg[aria-label="생성 개수"]').count()) === 0);
  // 적용 강도 슬라이더로 0% → 원본
  await page.evaluate(() => { const s = document.querySelector('.sheet .slider'); s.value = 0; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(200);
  const z = await px(0.51, 0.49);
  check('strength 0% shows the original', z.every((v, i) => Math.abs(v - before.center[i]) <= 2), JSON.stringify([z, before.center]));
  await page.evaluate(() => { const s = document.querySelector('.sheet .slider'); s.value = 100; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 4) 적용 / 실행 취소 / 레이어 / 내보내기
  console.log('▶ 적용');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  let L = await layers();
  check('applied as a locked AI image layer tagged with provider + model', L.length === 1 && L[0].t === 'image' && L[0].ai && L[0].ai.model === KLEIN && L[0].ai.provider === 'cloudflare' && L[0].ai.mode === 'edit' && L[0].lock === true && L[0].w > 0, JSON.stringify(L));
  const hist = await page.evaluate(() => window.imagefix.editor.store.history().map((x) => x.label));
  check('history label', hist.includes('AI 수정'), hist.join('|'));
  check('selection reset after apply, back to select step', (await sel()).cov === 0);
  await page.evaluate(() => window.imagefix.editor.undo()); await page.waitForTimeout(200);
  check('undo removes the AI layer', (await layers()).length === 0 && (await px(0.51, 0.49)).every((v, i) => Math.abs(v - before.center[i]) <= 2));
  await page.evaluate(() => window.imagefix.editor.redo()); await page.waitForTimeout(200);
  check('redo restores it', (await layers()).length === 1);
  await page.evaluate(() => window.imagefix.editor.closeTool(true)); await page.waitForTimeout(200);
  await selTool(page, 'layers'); await page.waitForTimeout(200);
  const rowTxt = await page.locator('.sheet .layer-row .nm').first().textContent();
  check('layers list labels the AI layer', /AI 수정/.test(rowTxt), rowTxt);
  await page.evaluate(() => window.imagefix.editor.closeTool(true));
  const exp = await page.evaluate(async () => {
    const { blob, w, h } = await window.imagefix.editor.exportBlob({ format: 'image/png', quality: 1 });
    const bmp = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(bmp, 0, 0);
    const at = (fx, fy) => Array.from(x.getImageData(Math.floor(fx * w), Math.floor(fy * h), 1, 1).data.slice(0, 3));
    return { w, h, mid: at(0.51, 0.49), corner: at(0.1, 0.1) };
  });
  check('export (full size) contains the AI patch only inside the selection', Math.abs(exp.mid[0] - 214) <= 6 && Math.abs(exp.mid[2] - 194) <= 6 && !(exp.corner[0] > 180 && exp.corner[1] < 80), JSON.stringify(exp));

  // ---------------------------------------------------------------- 5) 오류 / 취소
  console.log('▶ 오류 · 취소');
  await selTool(page, 'ai'); await waitIdle(page, 200);
  await lasso();
  await page.evaluate(() => { window.__ai.mode = 'e401'; });
  await page.click('.seg button >> text=AI 요청'); await page.fill('.sheet textarea.ai-prompt', '하늘을 바꿔 주세요');
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'busy', null, { timeout: 5000 });
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select', null, { timeout: 15000 });
  await page.waitForTimeout(200);
  check('401 shows a key error with a settings shortcut', /API 키\(토큰\)가 올바르지 않아요/.test(await page.locator('.ai-msg.err').textContent()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  const bg2 = await page.evaluate(() => ({ keep: window.__ai.keep.length, last: window.__ai.keep.at(-1)[0], notes: window.__ai.notes.length, text: window.__ai.notes.at(-1)[1] }));
  check('a failed request also ends the keep-alive and notifies the failure', bg2.keep === 4 && bg2.last === false && bg2.notes === 2 && /실패/.test(bg2.text), JSON.stringify(bg2));
  check('no layer added and no stale preview after an error', (await layers()).length === 1 && (await page.evaluate(() => window.imagefix.editor.store.get() === window.imagefix.editor.store.getBase())));
  await h.shot('a7_error');
  await page.evaluate(() => { window.__ai.mode = 'e429'; });
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select' && document.querySelector('.ai-msg.err'), null, { timeout: 15000 });
  check('429 quota message', /한도/.test(await page.locator('.ai-msg.err').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'e429free'; });
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select' && /무료 사용량/.test((document.querySelector('.ai-msg.err') || {}).textContent || ''), null, { timeout: 15000 });
  check('Cloudflare daily free allowance message mentions the UTC reset', /UTC 자정/.test(await page.locator('.ai-msg.err').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; window.__ai.delay = 8000; });
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'busy', null, { timeout: 5000 });
  const nLog = await page.evaluate(() => window.__ai.log.length);
  await page.waitForFunction((n) => window.__ai.log.length > n, nLog, { timeout: 15000 }); // 네이티브 작업이 실제로 시작된 뒤에 취소
  await page.waitForTimeout(300);
  await page.click('.sheet-head .btn >> text=취소');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select', null, { timeout: 8000 });
  await page.waitForTimeout(150);
  const cancelled = await page.evaluate(() => Object.values(window.__ai.jobs).filter((j) => j.cancelled).length);
  const bg3 = await page.evaluate(() => ({ keepOff: window.__ai.keep.at(-1)[0] === false, notes: window.__ai.notes.length }));
  check('cancelling releases the keep-alive without any notification', bg3.keepOff && bg3.notes === 4, JSON.stringify(bg3));
  check('cancel stops the job natively and returns quietly', cancelled >= 1 && (await page.locator('.ai-msg.err').count()) === 0 && (await layers()).length === 1);
  await page.evaluate(() => { window.__ai.delay = 600; });

  // ---------------------------------------------------------------- 6) 두 번째 수정
  console.log('▶ 두 번째 수정');
  await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(100);
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'review', null, { timeout: 20000 });
  await page.waitForTimeout(300);
  check('a second result is reviewed the same way (no consent dialog again)', (await page.locator('.dialog').count()) === 0 && (await page.locator('.sheet-head .btn >> text=적용').count()) === 1);
  await h.shot('a5_second');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  L = await layers();
  check('second AI layer added; no unused assets are kept', L.length === 2 && (await page.evaluate(() => window.imagefix.editor.assets.size)) === 2, String(L.length));
  await page.evaluate(() => window.imagefix.editor.closeTool(true));

  // ---------------------------------------------------------------- 7) 자동 복구 (새로고침 후 이어서 편집)
  console.log('▶ 자동 복구');
  await page.waitForTimeout(2600);
  await page.reload();
  await page.waitForSelector('.home .tile >> text=이어서 편집하기', { timeout: 15000 });
  await page.click('.home .tile >> text=이어서 편집하기');
  await page.waitForFunction(() => window.imagefix && window.imagefix.screen === 'editor' && window.imagefix.editor.doc().layers.length === 2 && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await waitIdle(page, 500);
  const rest = await px(0.51, 0.49);
  check('restored draft keeps both AI layers and their pixels', (await layers()).length === 2 && rest[0] > 150 && rest[1] < 90 && rest[2] > 140, JSON.stringify(rest));

  // ---------------------------------------------------------------- 8) 설정 진입점
  await page.evaluate(() => window.imagefix.goHome(true));
  await page.click('.home [aria-label="설정"]'); await page.waitForTimeout(200);
  check('app settings has an AI settings button (native)', (await page.locator('.msheet .btn >> text=AI 설정').count()) === 1);
  const note = await page.locator('.msheet').last().textContent();
  check('app settings note lists the four providers', /Cloudflare/.test(note) && /ModelScope/.test(note) && /Gemini/.test(note) && /Hugging Face/.test(note) && !/OpenAI|OpenRouter|Pollinations/.test(note));
  await page.click('.msheet .btn >> text=AI 설정'); await page.waitForTimeout(200);
  check('AI settings reachable from app settings', (await page.locator('.msheet h2 >> text=AI 설정').count()) >= 1);

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ ai all passed');
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    if (HH) {
      console.log('--- sheet:', await HH.page.evaluate(() => (document.querySelector('.sheet') || {}).innerText));
      console.log('--- phase:', await HH.page.evaluate(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase));
      console.log('--- errors:', HH.errors.join('\n'));
      await HH.shot('a_fail');
    }
  } catch (e2) { /* noop */ }
  process.exit(1);
});
