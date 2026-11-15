// 제공자별 E2E (영역 수정 도구) — deAPI 포함: Gemini(편집 / 문구로 채우기 / 모델 지정 / 오류) · ModelScope Qwen-Image-Edit(작업 만들기 → 확인 → 내려받기, 표시한 사진 1장) ·
// fal.ai FLUX.1 Fill(진짜 흰색 마스크, data URI / fal 주소 결과, 권한 오류) · 제공자 전환 · 옛 설정(OpenAI/OpenRouter/Pollinations) 정리.
const path = require('path');
const { launch, close, waitIdle, selTool } = require('./lib.cjs');
const { init, installRoute, helpers } = require('./ai_lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

let HH = null;
(async () => {
  const h = HH = await launch({ shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }], init });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await installRoute(page);
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await waitIdle(page, 300);
  const { lasso, px, layers, waitPhase } = helpers(page);
  const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) <= e);
  const logOf = () => page.evaluate(() => window.__ai.log);
  const askTab = async () => { await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(120); };
  const run = async () => { await page.click('.sheet-head .btn >> text=AI로 수정'); };
  const consent = async (expect) => {
    await page.waitForSelector('.dialog', { timeout: 5000 });
    const txt = await page.locator('.dialog p').textContent();
    if (expect) check('consent: ' + expect.join(' · '), expect.every((e) => txt.includes(e)), txt.slice(0, 110));
    await page.click('.dialog .btn >> text=동의하고 계속');
  };
  const runToSelect = async (timeout = 25000) => { await run(); await waitPhase('busy', 5000); await waitPhase('select', timeout); await page.waitForTimeout(200); };
  const runToReview = async (timeout = 40000) => { await run(); await waitPhase('busy', 5000); await waitPhase('review', timeout); await page.waitForTimeout(250); };
  const errText = () => page.locator('.ai-msg.err').textContent();
  const discard = async () => { await page.click('.sheet-head [aria-label="버리기"]'); await page.waitForTimeout(200); await askTab(); };
  const closeModal = async () => { await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150); };
  const providerRow = () => page.locator('.sheet-body .row.wrap .sheet-note').first().textContent();
  const chip = (id) => page.locator(`.msheet .chip[data-id=${id}]`);
  const openSettingsOn = async (id) => { await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200); await chip(id).click(); await page.waitForTimeout(150); };
  const saveToken = async (v) => { await page.fill('.msheet input[type=password]', v); await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150); };
  const last = async (kind, provider) => (await logOf()).filter((l) => l.kind === kind && l.provider === provider).at(-1);
  const GOAL = [214, 34, 194];

  await selTool(page, 'ai'); await waitIdle(page, 300);
  const before = { center: await px(0.51, 0.49), corner: await px(0.1, 0.1) };
  await lasso();
  await askTab();
  await page.fill('.sheet textarea.ai-prompt', 'a clear blue sky with soft fluffy clouds');

  // ---------------------------------------------------------------- 1) Gemini
  console.log('▶ Gemini (사진 편집 · 문구로 채우기)');
  check('with nothing set up the card offers only "key setup" (no keyless provider any more)', (await page.locator('.ai-setup .btn').count()) === 1 && (await page.locator('.ai-setup .btn >> text=키 설정').count()) === 1);
  await openSettingsOn('gemini');
  check('settings list the four providers with their tags', (await page.locator('.msheet .chip[data-id]').evaluateAll((els) => els.map((e) => e.dataset.id))).join() === 'cloudflare,modelscope,gemini,fal,deapi' && /하루 무료/.test(await chip('cloudflare').textContent()) && /Qwen/.test(await chip('modelscope').textContent()) && /내 API 키/.test(await chip('gemini').textContent()) && /진짜 마스크/.test(await chip('fal').textContent()));
  check('Gemini tab: API key only (no account ID), model selection, connection test', (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 0 && (await page.locator('.msheet input[type=password]').getAttribute('placeholder')) === 'Gemini API 키 (AIza…)' && /gemini-2\.5-flash-image/.test(await page.locator('.msheet').last().textContent()) && (await page.locator('.msheet .btn >> text=연결 테스트').count()) === 1);
  await saveToken('AIzaSyTestKey-abcdef123456');
  check('key saved natively in its own slot', (await page.locator('.msheet .kv b').textContent()).includes('3456') && JSON.stringify(await page.evaluate(() => window.__ai.setKeyCalls.at(-1))) === JSON.stringify(['gemini', 'key', '']));
  await page.evaluate(() => { window.__ai.mode = 'e401'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('a rejected key is reported by the connection test', /API 키\(토큰\)가 올바르지 않아요/.test(await page.locator('.msheet .ai-msg').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  const gl = await page.locator('.msheet .ai-msg').textContent();
  check('connection test lists the image models only', /gemini-2\.5-flash-image/.test(gl) && /gemini-3-pro-image-preview/.test(gl) && !/gemini-2\.5-pro,|gemini-2\.5-pro$/.test(gl), gl);
  await h.shot('p1_settings_gemini');
  await closeModal();
  check('provider row shows Gemini and the "edit with photo / fill from prompt" switch', /Gemini/.test(await providerRow()) && (await page.locator('.seg button >> text=사진 보고 편집').count()) === 1 && (await page.locator('.seg button >> text=문구로 채우기').count()) === 1 && (await page.locator('.ai-setup').count()) === 0);
  await page.evaluate(() => { window.__ai.delay = 3000; });
  await run();
  await consent(['generativelanguage.googleapis.com', 'Google', '주변 이미지']);
  await waitPhase('busy', 5000);
  await page.waitForSelector('.ai-sent', { timeout: 15000 });
  check('busy view shows the sent image preview', (await page.locator('.ai-sent').count()) === 1);
  await waitPhase('review', 30000);
  await page.evaluate(() => { window.__ai.delay = 600; });
  await page.waitForTimeout(250);
  let g = await last('edit', 'gemini');
  check('generateContent: default model, 3 parts (instruction + original + marked copy), image requested back', g && g.model === 'gemini-2.5-flash-image' && g.path === '/models/gemini-2.5-flash-image:generateContent' && g.nParts === 3 && /Image 1/.test(g.prompt) && /Image 2/.test(g.prompt) && /magenta/.test(g.prompt) && /a clear blue sky with soft fluffy clouds$/.test(g.prompt) && g.modalities.join() === 'TEXT,IMAGE', JSON.stringify(g && [g.model, g.nParts]));
  const gf = g ? g.transparent / (g.imgW * g.imgH) : 0;
  check('the 1024-class crop is sent; the marked copy highlights the selection only', g && g.imgW <= 1152 && g.imgH <= 1152 && g.markedW === g.imgW && g.markedH === g.imgH && gf > 0.04 && gf < 0.6, g && `${g.imgW}x${g.imgH} ${gf.toFixed(3)}`);
  const gm = await px(0.51, 0.49), gc = await px(0.1, 0.1);
  check('result blended inside the selection (tone-matched)', near(gm, GOAL, 8), JSON.stringify(gm));
  check('pixels far outside the selection are untouched', near(gc, before.corner, 0));
  await h.shot('p2_review_gemini');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  let L = await layers();
  check('applied as a locked AI layer tagged gemini / edit', L.length === 1 && L[0].ai.provider === 'gemini' && L[0].ai.mode === 'edit' && L[0].ai.model === 'gemini-2.5-flash-image' && L[0].lock, JSON.stringify(L[0] && L[0].ai));

  // 오류
  await lasso(); await askTab();
  await page.evaluate(() => { window.__ai.gmMode = 'text'; });
  await runToSelect();
  check('a text-only answer is explained with the model\'s words', /이미지를 받지 못했어요/.test(await errText()) && /cannot edit images/.test(await errText()));
  await page.evaluate(() => { window.__ai.gmMode = 'blocked'; });
  await runToSelect();
  check('a safety block is reported as a policy refusal', /안전 정책/.test(await errText()));
  await page.evaluate(() => { window.__ai.gmMode = 'ok'; window.__ai.mode = 'e401'; });
  await runToSelect();
  check('invalid key (HTTP 400 "API key not valid") → key error + settings shortcut', /API 키가 올바르지 않아요/.test(await errText()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  await page.evaluate(() => { window.__ai.mode = 'e429free'; });
  await runToSelect();
  check('free quota 0 → explains that a free Gemini key may have no image quota', /무료 한도가 0/.test(await errText()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });
  check('no layer was added after the errors', (await layers()).length === 1);

  // 문구로 채우기 (사진 미전송)
  await page.click('.seg button >> text=문구로 채우기'); await page.waitForTimeout(150);
  check('fill mode: note says no photo is sent; content examples', (await page.locator('.sheet .sheet-note >> text=사진을 보지 않고').count()) >= 1 && (await page.locator('.sheet .chip >> text=맑은 하늘').count()) === 1 && (await page.evaluate(() => window.imagefix.settings.ai.p.gemini.mode)) === 'generate');
  await run();
  await consent(['generativelanguage.googleapis.com', '사진은 보내지 않아요']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 30000); await page.waitForTimeout(250);
  g = await last('generate', 'gemini');
  check('request: prompt only (one part), no image', g && g.nParts === 1 && g.prompt === 'a clear blue sky with soft fluffy clouds', JSON.stringify(g));
  const fm = await px(0.44, 0.4);
  check('selection filled with the generated image (no tone shift)', near(fm, [30, 160, 60], 5), JSON.stringify(fm));
  check('pixels outside the selection are untouched', near(await px(0.1, 0.1), before.corner, 0));
  await h.shot('p3_fill_gemini');
  await discard();
  await page.click('.seg button >> text=사진 보고 편집'); await page.waitForTimeout(150);
  check('switching back restores editing with the photo', (await page.evaluate(() => window.imagefix.settings.ai.p.gemini.mode)) === 'edit');

  // 모델 직접 지정
  await openSettingsOn('gemini');
  await page.click('.msheet .seg button >> text=직접 지정'); await page.waitForTimeout(150);
  await page.click('.msheet .chip >> text=gemini-3-pro-image-preview'); await page.waitForTimeout(100);
  await closeModal();
  await runToReview();
  g = await last('edit', 'gemini');
  check('the chosen model is used', g && g.model === 'gemini-3-pro-image-preview' && g.path === '/models/gemini-3-pro-image-preview:generateContent', g && g.model);
  await discard();

  // ---------------------------------------------------------------- 2) ModelScope · Qwen-Image-Edit
  console.log('▶ ModelScope · Qwen-Image-Edit');
  await openSettingsOn('modelscope');
  check('ModelScope tab: token only, Qwen-Image-Edit as the auto model', (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 0 && (await page.locator('.msheet input[type=password]').getAttribute('placeholder')) === 'ModelScope 액세스 토큰' && /Qwen-Image-Edit/.test(await page.locator('.msheet').last().textContent()));
  await saveToken('ms-1a2b3c4d-5e6f7a8b');
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('connection test confirms the token', /연결됐어요/.test(await page.locator('.msheet .ai-msg').textContent()) && /Qwen\/Qwen-Image-Edit/.test(await page.locator('.msheet .ai-msg').textContent()));
  await closeModal();
  check('no mode switch (editing only); the note explains the single marked photo', /ModelScope/.test(await providerRow()) && (await page.locator('.seg button >> text=문구로 채우기').count()) === 0 && (await page.locator('.sheet .sheet-note >> text=마젠타로 표시한 사진 1장').count()) === 1);
  await run();
  await consent(['api-inference.modelscope.cn', '알리바바', '주변 이미지']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 45000); await page.waitForTimeout(250);
  let log = await logOf();
  const sub = log.filter((l) => l.provider === 'modelscope' && l.kind === 'submit').at(-1);
  check('submit: image-to-image task type, Qwen-Image-Edit, the marked photo as a data URL (image + image_url), no size', sub && sub.tt === 'image-to-image-generation' && sub.model === 'Qwen/Qwen-Image-Edit' && sub.hasImage && sub.sameImage && sub.keys.join() === 'model,prompt,image_url,image' && /Image|magenta/.test(sub.prompt) && /a clear blue sky/.test(sub.prompt), JSON.stringify(sub && [sub.tt, sub.keys]));
  check('the marked photo carries the highlighted selection', sub && sub.imgW <= 1152 && sub.transparent / (sub.imgW * sub.imgH) > 0.04 && sub.transparent / (sub.imgW * sub.imgH) < 0.6, sub && sub.transparent);
  const polls = log.filter((l) => l.provider === 'modelscope' && l.kind === 'poll'), dl = log.filter((l) => l.kind === 'download' && /aliyuncs\.com/.test(l.url));
  check('status checks carry the same task type; the result is downloaded once from the Alibaba Cloud address', polls.length >= 1 && polls.every((x) => x.tt === 'image-to-image-generation') && dl.length === 1, JSON.stringify([polls.length, dl.length]));
  const mm = await px(0.51, 0.49);
  check('result blended inside the selection', near(mm, GOAL, 14), JSON.stringify(mm));
  check('pixels far outside the selection are untouched', near(await px(0.1, 0.1), before.corner, 0));
  await h.shot('p4_review_modelscope');
  await discard();
  for (const [mode, re, label] of [['notask', /작업 번호를 돌려주지 않았어요/, 'no task id'], ['fail', /ModelScope 가 이미지를 만들지 못했어요[\s\S]*prompt blocked|prompt blocked[\s\S]*|ModelScope 가 이미지를 만들지/, 'task FAILED with the reason'], ['noimage', /이미지를 받지 못했어요/, 'finished without an image'], ['dlhtml', /이미지를 받지 못했어요/, 'expired link (not an image)']]) {
    await page.evaluate((m) => { window.__ai.msMode = m; }, mode);
    await runToSelect(40000);
    check('ModelScope: ' + label + ' → explained', re.test(await errText()));
  }
  await page.evaluate(() => { window.__ai.msMode = 'ok'; });
  const sub0 = (await logOf()).filter((l) => l.kind === 'submit').length;
  await run(); await waitPhase('busy', 5000);
  await page.waitForFunction((n) => window.__ai.log.filter((l) => l.kind === 'submit').length > n, sub0, { timeout: 15000 });
  const p0 = (await logOf()).filter((l) => l.kind === 'poll').length;
  await page.click('.sheet-head .btn >> text=취소'); await waitPhase('select', 8000);
  await page.waitForTimeout(4500);
  check('cancel while waiting for the task: no further status checks, no error shown', (await logOf()).filter((l) => l.kind === 'poll').length === p0 && (await page.locator('.ai-msg.err').count()) === 0);
  check('no layer was added by the failed / cancelled runs', (await layers()).length === 1);

  // ---------------------------------------------------------------- 3) fal.ai · FLUX.1 Fill
  console.log('▶ fal.ai · FLUX.1 Fill (진짜 마스크)');
  await openSettingsOn('fal');
  check('fal.ai tab: key only, no model list, no connection test, how-to points to the Keys page', (await page.locator('.msheet input[type=password]').getAttribute('placeholder')) === 'fal.ai API 키 (아이디:비밀값)' && (await page.locator('.msheet .btn >> text=연결 테스트').count()) === 0 && (await page.locator('.msheet .seg button >> text=직접 지정').count()) === 0 && /Keys/.test(await page.locator('.msheet').last().textContent()));
  await saveToken('fal-1a2b3c4d:secretvalue1234567890');
  check('token saved natively', (await page.locator('.msheet .kv b').textContent()).includes('7890') && JSON.stringify(await page.evaluate(() => window.__ai.setKeyCalls.at(-1))) === JSON.stringify(['fal', 'key', '']));
  await h.shot('p5_settings_fal');
  await closeModal();
  check('the ask tab explains the fill-style prompts; content examples are shown', (await page.locator('.sheet .sheet-note >> text=FLUX.1 Fill').count()) >= 1 && (await page.locator('.sheet .chip >> text=맑은 하늘').count()) === 1 && (await page.locator('.seg button >> text=문구로 채우기').count()) === 0);
  await run();
  await consent(['fal.run', 'fal', '마스크']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 40000); await page.waitForTimeout(250);
  let hf = await last('edit', 'fal');
  check('POST /fal-ai/flux-lora-fill: the prompt as typed (not wrapped), image + mask as data URLs, synchronous', hf && hf.path === '/fal-ai/flux-lora-fill' && hf.type === 'application/json' && hf.prompt === 'a clear blue sky with soft fluffy clouds' && hf.sync === true && ['prompt', 'image_url', 'mask_url', 'sync_mode'].every((k) => hf.keys.includes(k)), JSON.stringify(hf && hf.keys));
  const hr = hf ? hf.transparent / (hf.imgW * hf.imgH) : 0;
  check('the mask has the same size as the image and a white fill area inside it', hf && hf.maskW === hf.imgW && hf.maskH === hf.imgH && hr > 0.04 && hr < 0.7 && hf.bbox[0] > 0 && hf.bbox[2] < hf.imgW, JSON.stringify(hf && [hr.toFixed(3), hf.bbox]));
  const hm = await px(0.51, 0.49);
  check('result blended inside the selection', near(hm, GOAL, 12), JSON.stringify(hm));
  check('pixels far outside the selection are untouched', near(await px(0.1, 0.1), before.corner, 0));
  await h.shot('p6_review_fal');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  L = await layers();
  check('applied as a locked AI layer tagged fal', L.length === 2 && L[1].ai.provider === 'fal' && L[1].ai.mode === 'edit' && L[1].lock, JSON.stringify(L[1] && L[1].ai));
  await lasso(); await askTab();
  await page.evaluate(() => { window.__ai.hfMode = 'url'; });
  const dl0 = (await logOf()).filter((l) => l.kind === 'download').length;
  await runToReview();
  const dls = (await logOf()).filter((l) => l.kind === 'download');
  check('a result given as a fal address is downloaded (https, fal.media only)', dls.length === dl0 + 1 && /^https:\/\/v3\.fal\.media\/files\//.test(dls.at(-1).url) && near(await px(0.51, 0.49), GOAL, 12));
  await discard();
  await page.evaluate(() => { window.__ai.hfMode = 'gated'; });
  await runToSelect();
  check('403 → permission message with a settings shortcut', /권한/.test(await errText()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  await page.evaluate(() => { window.__ai.hfMode = 'ok'; });

  // ---------------------------------------------------------------- 3b) deAPI · OpenAI 호환 이미지 편집
  console.log('▶ deAPI · 이미지 편집');
  await openSettingsOn('deapi');
  check('deAPI tab: key only, model selection, connection test', (await page.locator('.msheet input[type=password]').getAttribute('placeholder')) === 'deAPI API 키' && (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 0 && (await page.locator('.msheet .btn >> text=연결 테스트').count()) === 1 && /Flux_2_Klein_4B_BF16/.test(await page.locator('.msheet').last().textContent()));
  await saveToken('deapi-testkey-1234567890');
  check('key saved natively in its own slot', (await page.locator('.msheet .kv b').textContent()).includes('7890') && JSON.stringify(await page.evaluate(() => window.__ai.setKeyCalls.at(-1))) === JSON.stringify(['deapi', 'key', '']));
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('connection test lists the models', /Flux_2_Klein_4B_BF16/.test(await page.locator('.msheet .ai-msg').textContent()) && /QwenImageEdit_Plus_NF4/.test(await page.locator('.msheet .ai-msg').textContent()));
  await closeModal();
  check('provider row shows deAPI; one marked photo (no mode switch)', /deAPI/.test(await providerRow()) && (await page.locator('.seg button >> text=문구로 채우기').count()) === 0);
  await lasso(); await askTab();
  await run();
  await consent(['oai.deapi.ai', 'deAPI', '주변 이미지']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 40000); await page.waitForTimeout(250);
  const dp = await last('edit', 'deapi');
  check('multipart /images/edits: model + prompt + image, the marked photo carries the selection', dp && dp.path === '/images/edits' && dp.model === 'Flux_2_Klein_4B_BF16' && dp.fields === 'model,prompt,image' && /magenta/.test(dp.prompt) && /a clear blue sky/.test(dp.prompt) && dp.transparent / (dp.imgW * dp.imgH) > 0.04, JSON.stringify(dp && [dp.fields, dp.model]));
  check('result blended inside the selection', near(await px(0.51, 0.49), GOAL, 14));
  await discard();
  await page.evaluate(() => { window.__ai.dpMode = 'url'; });
  const dl1 = (await logOf()).filter((l) => l.kind === 'download').length;
  await runToReview();
  const dls1 = (await logOf()).filter((l) => l.kind === 'download');
  check('a result given as a deapi.ai address is downloaded', dls1.length === dl1 + 1 && /^https:\/\/img\.deapi\.ai\//.test(dls1.at(-1).url) && near(await px(0.51, 0.49), GOAL, 14));
  await discard();
  await page.evaluate(() => { window.__ai.dpMode = 'err'; });
  await runToSelect();
  check('an API error object is shown (model not found → settings shortcut)', /모델을 찾을 수 없어요/.test(await errText()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  await page.evaluate(() => { window.__ai.dpMode = 'ok'; });

  // ---------------------------------------------------------------- 4) 전환 · 설정 유지
  console.log('▶ 전환 / 설정 유지');
  await openSettingsOn('cloudflare');
  check('Cloudflare slot is empty (keys are kept per provider)', (await page.locator('.msheet .kv b').textContent()).includes('없음') && (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 1);
  await chip('gemini').click(); await page.waitForTimeout(120);
  check('Gemini keeps its key when switching back', (await page.locator('.msheet .kv b').textContent()).includes('3456'));
  await page.click('.msheet .btn >> text=키 삭제'); await page.waitForTimeout(150);
  check('removing the key clears only this provider and its consents', (await page.locator('.msheet .kv b').textContent()).includes('없음') && (await page.evaluate(() => !window.__ai.prov.gemini.key && !!window.__ai.prov.modelscope.key && !('gemini' in window.imagefix.settings.ai.consents) && !('gemini:text' in window.imagefix.settings.ai.consents))));
  await closeModal();
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('imagefix.settings')).ai);
  check('settings persist the provider, per-provider state and consents (never a key)', st.provider === 'gemini' && st.consents.modelscope === 'api-inference.modelscope.cn' && st.consents.fal === 'fal.run' && !JSON.stringify(st).includes('AIzaSy') && !JSON.stringify(st).includes('secretvalue') && !JSON.stringify(st).includes('ms-1a2b3c4d'), JSON.stringify(st.consents));

  // ---------------------------------------------------------------- 5) 옛 설정 정리
  console.log('▶ 옛 설정 정리');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('imagefix.settings') || '{}');
    s.ai = { provider: 'pollinations', genProvider: 'openai', quality: 'high', n: 2, model: 'manual', consent: { base: 'https://api.openai.com/v1', ts: 1 },
      p: { openai: { model: 'manual' }, openrouter: { model: 'auto', free: ['a/b:free'] }, pollinations: { model: 'auto' }, cloudflare: { model: 'auto', custom: '', models: [] } },
      consents: { openai: 'api.openai.com', openrouter: 'openrouter.ai', 'openrouter:text': 'openrouter.ai', pollinations: 'image.pollinations.ai', 'pollinations:text': 'image.pollinations.ai', cloudflare: 'api.cloudflare.com' } };
    localStorage.setItem('imagefix.settings', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('.home .tile', { timeout: 15000 });
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(300);
  const mig = await page.evaluate(() => { const a = window.imagefix.settings.ai; return { provider: a.provider, gen: a.genProvider, p: Object.keys(a.p), consents: Object.keys(a.consents), extra: ['quality', 'n', 'model', 'consent'].filter((k) => k in a) }; });
  check('legacy OpenAI / OpenRouter / Pollinations settings and consents are dropped; Cloudflare kept; provider falls back', mig.provider === 'cloudflare' && mig.gen === undefined && mig.p.join() === 'cloudflare' && mig.consents.join() === 'cloudflare' && mig.extra.length === 0, JSON.stringify(mig));
  const ids = (await page.locator('.msheet .chip[data-id]').evaluateAll((els) => els.map((e) => e.dataset.id))).filter((id) => !/^\d+$/.test(id));
  check('the generator offers only Cloudflare and Gemini (the others cannot create images from text)', ids.join() === 'cloudflare,gemini', ids.join());
  await h.shot('p7_generator_providers');

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ ai_providers all passed');
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    if (HH) {
      console.log('--- sheet:', await HH.page.evaluate(() => (document.querySelector('.sheet') || {}).innerText));
      console.log('--- modal:', await HH.page.evaluate(() => (document.querySelector('.msheet') || {}).innerText));
      console.log('--- phase:', JSON.stringify(await HH.page.evaluate(() => { const t = window.imagefix.editor.tool; return t && t.selection ? { p: t.selection().phase, tab: t.selection().tab, msg: t.selection().msg } : null; })));
      console.log('--- errors:', HH.errors.join('\n'));
      await HH.shot('p_fail');
    }
  } catch (e2) { /* noop */ }
  process.exit(1);
});
