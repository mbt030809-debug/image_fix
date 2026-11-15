// 문구만으로 그리는 흐름 E2E: 홈 "AI로 이미지 만들기"(Pollinations 키 없이 → Cloudflare FLUX.1 schnell 번역→생성 → ModelScope 비동기 작업+내려받기) →
// 편집기로 열기, 그리고 영역 수정의 "문구로 채우기"(Cloudflare, 사진 미전송, 선택 안쪽만 합성)
const path = require('path');
const { launch, close, waitIdle, selTool } = require('./lib.cjs');
const { init, installRoute, helpers } = require('./ai_lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

let HH = null;
(async () => {
  const h = HH = await launch({ init, shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }] });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await installRoute(page);
  const { lasso, px, layers, waitPhase } = helpers(page);
  const logOf = () => page.evaluate(() => window.__ai.log);
  const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) <= e);
  const closeModal = async () => { await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150); };
  const waitDone = async (timeout = 25000) => { await page.waitForSelector('.ai-gen-result', { timeout }); await page.waitForTimeout(200); };
  const chipIds = () => page.locator('.msheet .chip[data-id]').evaluateAll((els) => els.map((e) => e.dataset.id).filter((id) => !/^\d+$/.test(id)));
  const consentText = async () => { await page.waitForSelector('.dialog', { timeout: 5000 }); return page.locator('.dialog p').textContent(); };
  const noteText = () => page.locator('.msheet .sheet-note').last().textContent();
  const ACC = '0123456789abcdef0123456789abcdef';
  // 네이티브 가짜는 파일 선택창 대신 pickImages → 대기 이미지로 연다
  const openFixture = async () => { await page.click('.hero .btn'); await page.waitForFunction(() => window.imagefix.screen === 'editor' && window.imagefix.editor.info && window.imagefix.editor.info.w === 2000 && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 }); await page.waitForTimeout(300); };
  const editorInfo = () => page.evaluate(() => ({ w: window.imagefix.editor.info.w, h: window.imagefix.editor.info.h, name: window.imagefix.editor.fileName }));

  // 첫 로드는 공유 이미지를 열므로, 새로고침해서 홈 화면에서 시작한다(가짜 네이티브는 두 번째 로드부터 대기 이미지가 없다)
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await page.reload();
  h.errors.length = 0;

  // ---------------------------------------------------------------- 1) 홈: Pollinations (키 없이)
  console.log('▶ 홈: AI로 이미지 만들기 — Pollinations (키 없이)');
  await page.waitForSelector('.home .tile', { timeout: 15000 });
  check('home shows the "Create with AI" tile (native only)', (await page.locator('.home .tile >> text=AI로 이미지 만들기').count()) === 1);
  await h.shot('g1_home');
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(250);
  check('sheet opens on Pollinations (nothing is set up, so the keyless provider comes first)', (await page.locator('.msheet h2').first().textContent()) === 'AI로 이미지 만들기' && (await page.locator('.msheet .chip[data-id=pollinations]').getAttribute('aria-checked')) === 'true');
  check('exactly three providers are offered (OpenAI / OpenRouter are gone)', (await chipIds()).join() === 'cloudflare,pollinations,modelscope', (await chipIds()).join());
  check('keyless: no setup card, no translate switch; the shape chips are shown', (await page.locator('.msheet .ai-setup').count()) === 0 && (await page.locator('.msheet .switch').count()) === 0 && (await page.locator('.msheet .seg button >> text=정사각').count()) === 1 && (await page.locator('.msheet .seg button >> text=가로').count()) === 1 && (await page.locator('.msheet .seg button >> text=세로').count()) === 1);
  check('provider note: no signup / key, about 45 s apart, no photo is sent', /가입도 키도 필요 없어요/.test(await noteText().catch(() => '')) || (await page.locator('.msheet .sheet-note >> text=가입도 키도 필요 없어요').count()) === 1);
  await page.click('.msheet .chip >> text=벚꽃이 흩날리는 한국 전통 마을'); await page.waitForTimeout(100);
  check('example chip fills the prompt', (await page.inputValue('.msheet textarea.ai-prompt')).includes('벚꽃'));
  await page.click('.msheet .seg button >> text=가로'); await page.waitForTimeout(80);
  await h.shot('g2_generate_form');
  await page.click('.msheet .btn >> text=만들기');
  const ct1 = await consentText();
  check('text-only consent: names the host, says no photo is sent', /image\.pollinations\.ai/.test(ct1) && /사진은 보내지 않아요/.test(ct1) && !/주변 이미지/.test(ct1) && /45초/.test(ct1), ct1.slice(0, 80));
  await page.click('.dialog .btn >> text=동의하고 계속');
  await waitDone();
  let log = await logOf();
  const pg = log.find((l) => l.provider === 'pollinations');
  check('the Korean prompt was sent as typed (no translation) with the landscape class', pg && pg.prompt === '벚꽃이 흩날리는 한국 전통 마을' && pg.width === 896 && pg.height === 640 && log.every((l) => l.provider === 'pollinations'), JSON.stringify(pg));
  const dims1 = await page.evaluate(() => { const i = document.querySelector('.ai-gen-result'); return [i.naturalWidth, i.naturalHeight]; });
  check('result image is shown (896×640 JPEG)', dims1[0] === 896 && dims1[1] === 640, JSON.stringify(dims1));
  check('shows the prompt used; Pollinations note about the 45 s interval', /벚꽃이 흩날리는 한국 전통 마을/.test(await page.locator('.msheet .sheet-note >> text=사용한 문구').textContent()) && (await page.locator('.msheet .sheet-note >> text=약 45초에 한 장').count()) === 1);
  await h.shot('g3_generated');
  await page.click('.msheet .btn >> text=편집하기');
  await page.waitForFunction(() => window.imagefix.screen === 'editor' && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  const ei = await editorInfo();
  check('"Edit" opens the generated image in the editor', ei.w === 896 && ei.h === 640 && ei.name === 'AI 이미지' && (await page.locator('.msheet').count()) === 0, JSON.stringify(ei));

  // 한도(429) 안내
  await page.evaluate(() => window.imagefix.goHome(true));
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(250);
  await page.fill('.msheet textarea.ai-prompt', 'a cute cat');
  await page.evaluate(() => { window.__ai.plMode = 'rate'; });
  await page.click('.msheet .btn >> text=만들기'); await page.waitForSelector('.ai-msg.err', { timeout: 20000 });
  check('Pollinations rate limit: "one image per ~45 seconds" (consent is remembered, no second dialog)', /45초/.test(await page.locator('.ai-msg.err').textContent()) && (await page.locator('.dialog').count()) === 0);
  await page.evaluate(() => { window.__ai.plMode = 'ok'; });

  // ---------------------------------------------------------------- 2) Cloudflare FLUX.1 schnell: 키 설정 → 번역 → 생성
  console.log('▶ 홈: Cloudflare FLUX.1 schnell (번역 → 생성)');
  await page.click('.msheet .chip[data-id=cloudflare]'); await page.waitForTimeout(150);
  check('Cloudflare tab: setup card + translate switch (on by default), no shape chips (fixed 1024×1024)', (await page.locator('.msheet .ai-setup').count()) === 1 && (await page.locator('.msheet .switch').getAttribute('aria-checked')) === 'true' && (await page.locator('.msheet .seg button >> text=가로').count()) === 0);
  await page.click('.msheet .ai-setup .btn'); await page.waitForTimeout(250);
  await page.fill('.msheet:last-of-type input[name=imagefix-ai-account]', ACC);
  await page.fill('.msheet:last-of-type input[type=password]', 'cf-token-abcdef123456');
  await page.click('.msheet:last-of-type .btn >> text=키 저장'); await page.waitForTimeout(200);
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  check('after saving the key the setup card is gone (sheet re-rendered)', (await page.locator('.msheet .ai-setup').count()) === 0);
  await page.click('.msheet .chip >> text=노을 지는 바다 위의 작은 돛단배'); await page.waitForTimeout(100);
  check('example chip fills the prompt', (await page.inputValue('.msheet textarea.ai-prompt')).includes('돛단배'));
  await h.shot('g4_generate_cloudflare');
  await page.click('.msheet .btn >> text=만들기');
  const ct2 = await consentText();
  check('text-only consent: names Cloudflare and says no photo is sent', /api\.cloudflare\.com/.test(ct2) && /사진은 보내지 않아요/.test(ct2) && !/주변 이미지/.test(ct2), ct2.slice(0, 80));
  await page.click('.dialog .btn >> text=동의하고 계속');
  await waitDone();
  log = await logOf();
  const tr = log.find((l) => l.kind === 'translate'), gen = log.find((l) => l.provider === 'cloudflare' && l.kind === 'generate');
  check('Korean prompt was translated first (m2m100, ko → en)', tr && tr.source_lang === 'ko' && tr.target_lang === 'en' && /돛단배/.test(tr.text) && /m2m100-1\.2b$/.test(tr.path), JSON.stringify(tr));
  check('FLUX.1 schnell got the English prompt and nothing else (no photo)', gen && gen.model === '@cf/black-forest-labs/flux-1-schnell' && gen.prompt === 'a small sailboat on a sunset sea, watercolor' && gen.keys.join() === 'prompt' && /\{account\}/.test(gen.path), JSON.stringify(gen));
  const dims = await page.evaluate(() => { const i = document.querySelector('.ai-gen-result'); return [i.naturalWidth, i.naturalHeight]; });
  check('result image is shown (1024×1024)', dims[0] === 1024 && dims[1] === 1024, JSON.stringify(dims));
  check('shows the prompt that was actually sent (translated)', /a small sailboat/.test(await noteText()) && /번역/.test(await noteText()));
  await page.click('.msheet .btn >> text=편집하기');
  await page.waitForFunction(() => window.imagefix.screen === 'editor' && window.imagefix.editor.info && window.imagefix.editor.info.w === 1024 && !window.imagefix.editor.busy, null, { timeout: 30000 });
  const ei2 = await editorInfo();
  check('"Edit" opens the generated image in the editor', ei2.w === 1024 && ei2.h === 1024 && ei2.name === 'AI 이미지', JSON.stringify(ei2));

  // 번역 끄기 / 번역 실패 시 원문으로 진행 / 무료 한도 오류
  await page.evaluate(() => window.imagefix.goHome(true));
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(250);
  check('the sheet remembers the last provider (Cloudflare)', (await page.locator('.msheet .chip[data-id=cloudflare]').getAttribute('aria-checked')) === 'true');
  await page.fill('.msheet textarea.ai-prompt', '창가에서 낮잠 자는 귀여운 고양이');
  const nTr0 = (await logOf()).filter((l) => l.kind === 'translate').length;
  await page.click('.msheet .switch'); await page.waitForTimeout(80);
  await page.click('.msheet .btn >> text=만들기'); await waitDone();
  log = await logOf();
  check('with the switch off nothing is translated and the Korean prompt is sent as-is', log.filter((l) => l.kind === 'translate').length === nTr0 && log.filter((l) => l.kind === 'generate').at(-1).prompt === '창가에서 낮잠 자는 귀여운 고양이');
  await page.click('.msheet .btn >> text=문구 고치기'); await page.waitForTimeout(100);
  await page.click('.msheet .switch'); await page.waitForTimeout(80);
  await page.evaluate(() => { window.__ai.tr = 'fail'; });
  await page.click('.msheet .btn >> text=만들기'); await waitDone();
  log = await logOf();
  check('translation failure falls back to the original prompt (generation still works)', log.filter((l) => l.kind === 'translate').length === nTr0 + 1 && log.filter((l) => l.kind === 'generate').at(-1).prompt === '창가에서 낮잠 자는 귀여운 고양이' && /번역/.test(await noteText()) === false);
  await page.evaluate(() => { window.__ai.tr = 'ok'; window.__ai.mode = 'e429free'; });
  await page.click('.msheet .btn >> text=다시 만들기'); await page.waitForSelector('.ai-msg.err', { timeout: 20000 });
  check('free daily allowance message for generation', /오늘의 무료 사용량/.test(await page.locator('.ai-msg.err').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });

  // ---------------------------------------------------------------- 3) ModelScope: 작업 → 확인 → 내려받기
  console.log('▶ 홈: ModelScope (비동기 작업)');
  await page.click('.msheet .chip[data-id=modelscope]'); await page.waitForTimeout(150);
  check('ModelScope tab: token-only setup card, shape chips, no translate switch', (await page.locator('.msheet .ai-setup').count()) === 1 && /액세스 토큰/.test(await page.locator('.msheet .ai-setup').textContent()) && (await page.locator('.msheet .seg button >> text=세로').count()) === 1 && (await page.locator('.msheet .switch').count()) === 0);
  await page.click('.msheet .ai-setup .btn'); await page.waitForTimeout(250);
  check('settings opened on ModelScope: token only (no account ID)', (await page.locator('.msheet:last-of-type input[name=imagefix-ai-account]').count()) === 0 && (await page.locator('.msheet .chip[data-id=modelscope]').last().getAttribute('aria-checked')) === 'true');
  await page.fill('.msheet:last-of-type input[type=password]', 'ms-1a2b3c4d-5e6f7a8b');
  await page.click('.msheet:last-of-type .btn >> text=키 저장'); await page.waitForTimeout(200);
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  check('after saving the token the setup card is gone', (await page.locator('.msheet .ai-setup').count()) === 0);
  await page.fill('.msheet textarea.ai-prompt', 'A traditional Korean village with falling cherry blossoms');
  await page.click('.msheet .seg button >> text=세로'); await page.waitForTimeout(80);
  await page.click('.msheet .btn >> text=만들기');
  const ct3 = await consentText();
  check('text-only consent: names the ModelScope host, says no photo is sent and where the image comes from', /api-inference\.modelscope\.cn/.test(ct3) && /사진은 보내지 않아요/.test(ct3) && /알리바바/.test(ct3), ct3.slice(0, 80));
  await page.click('.dialog .btn >> text=동의하고 계속');
  await waitDone(45000);
  log = await logOf();
  const sub = log.filter((l) => l.kind === 'submit').at(-1), dl = log.filter((l) => l.kind === 'download');
  check('submit: Qwen-Image, the prompt as typed, the portrait size class', sub && sub.model === 'Qwen/Qwen-Image' && sub.prompt === 'A traditional Korean village with falling cherry blossoms' && sub.size === '768x1152', JSON.stringify(sub));
  check('the result was downloaded from the returned Alibaba Cloud address', dl.length === 1 && /^https:\/\/muse-ai\.oss-cn-hangzhou\.aliyuncs\.com\//.test(dl[0].url));
  const dims3 = await page.evaluate(() => { const i = document.querySelector('.ai-gen-result'); return [i.naturalWidth, i.naturalHeight]; });
  check('result image is shown (768×1152)', dims3[0] === 768 && dims3[1] === 1152, JSON.stringify(dims3));
  await h.shot('g5_generated_modelscope');
  await closeModal();

  // ---------------------------------------------------------------- 4) 영역 수정: 문구로 채우기 (Cloudflare, 사진 미전송)
  console.log('▶ 영역 수정: 문구로 채우기 (Cloudflare)');
  await page.evaluate(() => window.imagefix.goHome(true));
  await openFixture();
  await selTool(page, 'ai'); await waitIdle(page, 300);
  const before = { corner: await px(0.1, 0.1) };
  await lasso();
  await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(150);
  check('the tool follows the provider chosen last (ModelScope paints from the prompt only: no mode switch)', /ModelScope/.test(await page.locator('.sheet-body .row.wrap .sheet-note').first().textContent()) && (await page.locator('.seg button >> text=사진 보고 편집').count()) === 0);
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  await page.click('.msheet .chip[data-id=cloudflare]'); await page.waitForTimeout(150);
  await closeModal();
  check('Cloudflare shows the mode switch (edit with photo / fill from prompt)', (await page.locator('.seg button >> text=문구로 채우기').count()) === 1 && (await page.locator('.seg button >> text=사진 보고 편집').count()) === 1);
  await page.click('.seg button >> text=문구로 채우기'); await page.waitForTimeout(150);
  check('fill mode explains it never sees the photo + swaps in content examples', (await page.locator('.sheet .sheet-note >> text=사진을 보지 않고').count()) >= 1 && (await page.locator('.sheet .chip >> text=맑은 하늘').count()) === 1 && (await page.locator('.sheet .chip >> text=물체 지우기').count()) === 0);
  await h.shot('g6_fill_mode');
  await page.click('.sheet .chip >> text=맑은 하늘'); await page.waitForTimeout(100);
  const nGen0 = (await logOf()).filter((l) => l.kind === 'generate').length;
  await page.click('.sheet-head .btn >> text=AI로 수정'); await page.waitForTimeout(300);
  check('no new consent dialog (text-only consent was already given)', (await page.locator('.dialog').count()) === 0);
  await waitPhase('busy', 5000);
  await page.waitForSelector('.sheet .sheet-note >> text=사진은 보내지 않고', { timeout: 8000 });
  check('busy view says no photo was sent and shows no sent-image preview', (await page.locator('.ai-sent').count()) === 0);
  await waitPhase('review', 25000); await page.waitForTimeout(250);
  log = await logOf();
  const g2 = log.filter((l) => l.kind === 'generate' && l.provider === 'cloudflare').slice(-1)[0];
  check('request: prompt only (translated), no image / mask fields', g2 && g2.keys.join() === 'prompt' && /sky/i.test(g2.prompt) && !/[가-힣]/.test(g2.prompt) && log.filter((l) => l.kind === 'generate').length > nGen0, JSON.stringify(g2));
  check('no photo or mask was uploaded in fill mode', !log.slice(-6).some((l) => l.kind === 'edit'));
  const inside = await px(0.44, 0.4), corner = await px(0.1, 0.1);
  check('selection filled with the generated content (no tone shift in fill mode)', near(inside, [30, 160, 60], 4), JSON.stringify(inside));
  check('pixels outside the selection are untouched', near(corner, before.corner, 0));
  await h.shot('g7_fill_review');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  const L = await layers();
  check('applied as a locked AI layer tagged mode=generate', L.length === 1 && L[0].ai.provider === 'cloudflare' && L[0].lock && L[0].ai.mode === 'generate');
  await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(100);
  await page.click('.seg button >> text=사진 보고 편집'); await page.waitForTimeout(150);
  check('switching back restores automatic model selection (edit)', (await page.evaluate(() => window.imagefix.settings.ai.p.cloudflare.model)) === 'auto' && (await page.locator('.sheet .chip >> text=물체 지우기').count()) === 1);

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ ai_gen all passed');
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    if (HH) {
      console.log('--- modal:', await HH.page.evaluate(() => (document.querySelector('.msheet') || {}).innerText));
      console.log('--- sheet:', await HH.page.evaluate(() => (document.querySelector('.sheet') || {}).innerText));
      console.log('--- errors:', HH.errors.join('\n'));
      await HH.shot('g_fail');
    }
  } catch (e2) { /* noop */ }
  process.exit(1);
});
