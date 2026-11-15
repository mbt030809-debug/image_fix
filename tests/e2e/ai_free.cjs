// 무료 AI 제공자 E2E: OpenRouter(무료 이미지 모델 자동 탐색) · Cloudflare Workers AI(FLUX.2, 하루 무료)
// 마스크가 없는 모델이라 "표시 이미지(편집할 곳을 마젠타로 칠한 사본)"를 함께 보내고, 결과는 선택 안쪽에만 합성되는지 확인한다.
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
  const { lasso, sel, px, layers, waitPhase } = helpers(page);
  const near = (a, b, e) => a.every((v, i) => Math.abs(v - b[i]) <= e);
  const logOf = () => page.evaluate(() => window.__ai.log);
  const askTab = async () => { await page.click('.seg button >> text=AI 요청'); await page.waitForTimeout(120); };
  const selTab = async () => { await page.click('.seg button >> text=영역 선택'); await page.waitForTimeout(120); };
  const generate = async () => { await page.click('.sheet-head .btn >> text=AI로 수정'); };
  const consent = async (expect) => {
    await page.waitForSelector('.dialog', { timeout: 5000 });
    const txt = await page.locator('.dialog p').textContent();
    if (expect) check('consent names the server: ' + expect.join(' / '), expect.every((e) => txt.includes(e)), txt.slice(0, 90));
    await page.click('.dialog .btn >> text=동의하고 계속');
  };
  const closeModal = async () => { await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150); };

  await selTool(page, 'ai'); await waitIdle(page, 300);
  const before = { center: await px(0.51, 0.49), corner: await px(0.1, 0.1) };
  await lasso();
  await askTab();
  await page.fill('.sheet textarea.ai-prompt', '이 부분을 보라색 물체로 바꿔 주세요');

  // ---------------------------------------------------------------- 1) 키가 하나도 없을 때: 무료로 시작하기
  console.log('▶ 무료로 시작하기');
  check('free-start card offers Cloudflare / OpenRouter / OpenAI', (await page.locator('.ai-setup .btn >> text=Cloudflare').count()) === 1 && (await page.locator('.ai-setup .btn >> text=OpenRouter').count()) === 1 && (await page.locator('.ai-setup .btn >> text=OpenAI').count()) === 1);
  check('provider row shows the active provider', /OpenAI/.test(await page.locator('.sheet-body .row.wrap .sheet-note').first().textContent()));
  await h.shot('f1_start');

  // ---------------------------------------------------------------- 2) OpenRouter
  console.log('▶ OpenRouter (무료 모델)');
  await page.click('.ai-setup .btn >> text=OpenRouter'); await page.waitForTimeout(200);
  check('settings open on the OpenRouter tab', (await page.locator('.msheet .chip[data-id=openrouter]').getAttribute('aria-checked')) === 'true');
  check('free providers carry a "free" tag; OpenAI is tagged paid', /무료/.test(await page.locator('.msheet .chip[data-id=openrouter]').textContent()) && /무료/.test(await page.locator('.msheet .chip[data-id=cloudflare]').textContent()) && /유료/.test(await page.locator('.msheet .chip[data-id=openai]').textContent()));
  await page.fill('.msheet input[type=password]', 'sk-or-v1-abcdef123456');
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('OpenRouter key saved natively (own slot)', (await page.locator('.msheet .kv b').textContent()).includes('3456') && (await page.evaluate(() => window.__ai.setKeyCalls.at(-1))).join('|') === 'openrouter|key||');
  await page.evaluate(() => { window.__ai.mode = 'e401key'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('a rejected OpenRouter key is reported by the connection test (key check before listing models)', /API 키가 올바르지 않아요/.test(await page.locator('.msheet .ai-msg').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(800);
  const t1 = await page.locator('.msheet .ai-msg').textContent();
  check('connection test lists only FREE image-EDITING models (no paid, no text-to-image-only, no text models)', /grok-imagine-free:free/.test(t1) && /old\/flux-edit:free/.test(t1) && !/paid\//.test(t1) && !/text-to-image-only/.test(t1) && !/text-model/.test(t1), t1);
  await h.shot('f2_settings_openrouter');
  await closeModal();
  await generate(); await consent(['openrouter.ai', '저장·개선']);
  await waitPhase('busy', 5000);
  await page.waitForSelector('.ai-sent', { timeout: 20000 });
  await waitPhase('review', 25000); await page.waitForTimeout(250);
  let log = await logOf();
  let rq = log.find((l) => l.provider === 'openrouter' && l.path === '/chat/completions');
  check('auto model = newest free model that accepts image input', rq && rq.model === 'x-ai/grok-imagine-free:free', rq && rq.model);
  check('request: json chat completion with image+text output, no OpenAI-only params', rq && rq.type === 'application/json' && rq.modalities.join() === 'image,text' && rq.stream === false && !rq.hasN && !rq.hasQuality && rq.nParts === 3);
  check('request: instruction mentions both images + the user wording', rq && /Image 1/.test(rq.prompt) && /Image 2/.test(rq.prompt) && /magenta/.test(rq.prompt) && /보라색 물체/.test(rq.prompt));
  check('request: original and marked image have the same size (1024-class)', rq && rq.imgW === rq.markedW && rq.imgH === rq.markedH && /^(1024x1024|1152x768|768x1152)$/.test(`${rq.imgW}x${rq.imgH}`), rq && `${rq.imgW}x${rq.imgH}`);
  const mf = rq ? rq.transparent / (rq.imgW * rq.imgH) : 0;
  check('request: the marked copy highlights the selection (and only it)', mf > 0.04 && mf < 0.6 && rq.bbox[0] > 0 && rq.bbox[2] < rq.imgW, JSON.stringify([mf.toFixed(3), rq && rq.bbox]));
  const m1 = await px(0.51, 0.49), c1 = await px(0.1, 0.1);
  check('result blended inside the selection (tone-matched)', near(m1, [214, 34, 194], 6), JSON.stringify(m1));
  check('pixels far outside the selection are untouched', near(c1, before.corner, 0), JSON.stringify([c1, before.corner]));
  await h.shot('f3_review_openrouter');
  check('single result: no variant picker, no strength-less UI break', (await page.locator('.sheet .thumb').count()) === 0 && (await page.locator('.sheet-head .btn >> text=적용').count()) === 1);
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  let L = await layers();
  check('applied as an AI layer tagged with the provider', L.length === 1 && L[0].ai && L[0].ai.provider === 'openrouter' && L[0].ai.model === 'x-ai/grok-imagine-free:free' && L[0].lock, JSON.stringify(L[0]));

  // 오류: 무료 한도 / 이미지 없음
  await lasso(); await askTab();
  await page.evaluate(() => { window.__ai.mode = 'e429free'; });
  await generate(); await waitPhase('busy', 5000); await waitPhase('select', 25000); await page.waitForTimeout(200);
  check('free daily limit is explained (not a generic error)', /오늘의 무료 사용량/.test(await page.locator('.ai-msg.err').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'noimage'; });
  await generate(); await waitPhase('busy', 5000); await waitPhase('select', 25000); await page.waitForTimeout(200);
  check('a model that answers with text only is explained', /이미지를 돌려주지 않았어요/.test(await page.locator('.ai-msg.err').textContent()) && /cannot edit images/.test(await page.locator('.ai-msg.err').textContent()));
  check('no layer added after errors', (await layers()).length === 1);

  // 무료 모델이 하나도 없을 때
  await page.evaluate(() => { window.__ai.mode = 'ok'; window.__ai.orModels = window.__ai.orModels.filter((m) => !/:free$/.test(m.id)); });
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  check('"change provider" opens settings on the active provider', (await page.locator('.msheet .chip[data-id=openrouter]').getAttribute('aria-checked')) === 'true');
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(800);
  check('test explains that no free image-editing model is listed', /무료 이미지 편집 모델이 목록에 없어요/.test(await page.locator('.msheet .ai-msg').textContent()));
  await closeModal();
  const nOr = (await logOf()).filter((l) => l.provider === 'openrouter').length;
  await generate(); await waitPhase('busy', 5000); await waitPhase('select', 25000); await page.waitForTimeout(200);
  check('generating without any free model → clear message + settings shortcut', /무료 이미지 편집 모델을 찾지 못했어요/.test(await page.locator('.ai-msg.err').textContent()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  check('nothing was sent to the model in that case', (await logOf()).filter((l) => l.provider === 'openrouter').length === nOr);
  await page.evaluate(() => { window.__ai.orModels.push({ id: 'z/back-again:free', name: 'z', created: 900, architecture: { input_modalities: ['image', 'text'], output_modalities: ['image'] }, pricing: { prompt: '0', completion: '0' } }); });
  await generate(); await waitPhase('busy', 5000); await waitPhase('review', 25000); await page.waitForTimeout(200);
  rq = (await logOf()).filter((l) => l.provider === 'openrouter').at(-1);
  check('a newly listed free model is picked up automatically on the next request (image-only model → modalities [image])', rq.model === 'z/back-again:free' && rq.modalities.join() === 'image', rq.model + ' ' + rq.modalities);
  await page.click('.sheet-head [aria-label="버리기"]'); await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 3) Cloudflare
  console.log('▶ Cloudflare Workers AI (하루 무료)');
  await selTab(); await askTab();
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  await page.click('.msheet .chip[data-id=cloudflare]'); await page.waitForTimeout(150);
  check('Cloudflare tab asks for an account ID and a token', (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 1 && (await page.locator('.msheet input[type=password]').count()) === 1);
  await page.fill('.msheet input[name=imagefix-ai-account]', '1234');
  await page.fill('.msheet input[type=password]', 'cf-token-abcdef123456');
  const callsBefore = await page.evaluate(() => window.__ai.setKeyCalls.length);
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('malformed account ID is rejected in the page (nothing reaches native)', (await page.evaluate(() => window.__ai.setKeyCalls.length)) === callsBefore && (await page.locator('.msheet .kv b').textContent()).includes('없음'));
  const ACC = '0123456789abcdef0123456789abcdef';
  await page.fill('.msheet input[name=imagefix-ai-account]', ACC);
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('account ID + token saved natively', (await page.locator('.msheet .kv b').textContent()).includes('3456') && (await page.evaluate(() => window.__ai.setKeyCalls.at(-1))).join('|') === 'cloudflare|key||' + ACC);
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  const t2 = await page.locator('.msheet .ai-msg').textContent();
  check('connection test lists FLUX models only', /flux-2-klein-4b/.test(t2) && /flux-2-dev/.test(t2) && !/llama/.test(t2), t2);
  await h.shot('f4_settings_cloudflare');
  await closeModal();
  await lasso(); await askTab();
  await generate(); await consent(['api.cloudflare.com']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 30000); await page.waitForTimeout(250);
  rq = (await logOf()).find((l) => l.provider === 'cloudflare');
  check('request path uses the {account} placeholder and the default klein model', rq && rq.path === '/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b' && rq.model === '@cf/black-forest-labs/flux-2-klein-4b', rq && rq.path);
  check('request: multipart with input_image_0 / input_image_1', rq && rq.type === 'multipart/form-data' && rq.files.join() === 'image.png,marked.png');
  check('request: input ≤512 px (Cloudflare limit) and output size = 2× input', rq && rq.imgW <= 512 && rq.imgH <= 512 && rq.width === rq.imgW * 2 && rq.height === rq.imgH * 2 && rq.markedW === rq.imgW, rq && `${rq.imgW}x${rq.imgH} → ${rq.width}x${rq.height}`);
  const cf = rq ? rq.transparent / (rq.imgW * rq.imgH) : 0;
  check('request: marked copy highlights the selection', cf > 0.04 && cf < 0.6, cf.toFixed(3));
  const m2 = await px(0.51, 0.49), c2 = await px(0.1, 0.1);
  check('result blended inside the selection', near(m2, [214, 34, 194], 6), JSON.stringify(m2));
  check('pixels far outside the selection are untouched', near(c2, before.corner, 0), JSON.stringify(c2));
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  L = await layers();
  const lc = L.at(-1);
  check('Cloudflare layer: provider tag + patch kept at the 2× output resolution', lc.ai.provider === 'cloudflare' && lc.aw >= rq.imgW * 0.6 * 2 * 0.5 && lc.aw > rq.imgW, JSON.stringify([lc.ai, lc.aw, lc.ah, rq.imgW]));

  // 바이너리 응답 / 무료 한도 초과
  await lasso(); await askTab();
  await page.evaluate(() => { window.__ai.cfBinary = true; });
  await generate(); await waitPhase('busy', 5000); await waitPhase('review', 30000); await page.waitForTimeout(200);
  check('a binary PNG response is accepted as well', (await px(0.51, 0.49)).every((v, i) => Math.abs(v - [214, 34, 194][i]) <= 6));
  await page.click('.sheet-head [aria-label="버리기"]'); await page.waitForTimeout(200);
  await page.evaluate(() => { window.__ai.cfBinary = false; window.__ai.mode = 'e429free'; });
  await askTab();
  await generate(); await waitPhase('busy', 5000); await waitPhase('select', 25000); await page.waitForTimeout(200);
  check('Cloudflare daily free allowance message mentions the UTC reset', /UTC 자정/.test(await page.locator('.ai-msg.err').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });

  // ---------------------------------------------------------------- 4) 제공자 전환 + 설정 유지
  console.log('▶ 전환 / 이전 설정');
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  await page.click('.msheet .chip[data-id=openrouter]'); await page.waitForTimeout(120);
  check('switching providers keeps each provider\'s own key', (await page.locator('.msheet .kv b').textContent()).includes('3456') && (await page.locator('.msheet .chip[data-id=openrouter]').getAttribute('aria-checked')) === 'true');
  await page.click('.msheet .chip[data-id=openai]'); await page.waitForTimeout(120);
  check('OpenAI slot is still empty', (await page.locator('.msheet .kv b').textContent()).includes('없음'));
  await closeModal();
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('imagefix.settings')).ai);
  check('settings persist the active provider, per-provider model state and consents (never the key)', st.provider === 'openai' && st.consents.openrouter === 'openrouter.ai' && st.consents.cloudflare === 'api.cloudflare.com' && st.p.openrouter.resolved && !JSON.stringify(st).includes('sk-or-v1') && !JSON.stringify(st).includes('cf-token'), JSON.stringify(st).slice(0, 220));

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  process.exit(bad ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try {
    if (HH) {
      console.log('--- sheet:', await HH.page.evaluate(() => (document.querySelector('.sheet') || {}).innerText));
      console.log('--- modal:', await HH.page.evaluate(() => (document.querySelector('.msheet') || {}).innerText));
      console.log('--- phase:', JSON.stringify(await HH.page.evaluate(() => { const t = window.imagefix.editor.tool; return t && t.selection ? { p: t.selection().phase, tab: t.selection().tab, msg: t.selection().msg } : null; })));
      console.log('--- errors:', HH.errors.join('\n'));
      await HH.shot('f_fail');
    }
  } catch (e2) { /* noop */ }
  process.exit(1);
});
