// 무료 AI 제공자 E2E (영역 수정 도구): Pollinations(키 없이) · ModelScope API-Inference(무료 체험 토큰: 작업 만들기 → 상태 확인 → 결과 내려받기).
// 둘 다 문구만으로 그리는 제공자라 사진은 보내지 않고, 결과는 선택 안쪽에만 합성되는지 확인한다. 제공자 전환 · 옛 설정(OpenAI/OpenRouter) 정리도 확인한다.
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
    if (expect) check('consent names the server / notes: ' + expect.join(' · '), expect.every((e) => txt.includes(e)), txt.slice(0, 100));
    await page.click('.dialog .btn >> text=동의하고 계속');
  };
  const runToSelect = async (timeout = 25000) => { await run(); await waitPhase('busy', 5000); await waitPhase('select', timeout); await page.waitForTimeout(200); };
  const errText = () => page.locator('.ai-msg.err').textContent();
  const discard = async () => { await page.click('.sheet-head [aria-label="버리기"]'); await page.waitForTimeout(200); };
  const closeModal = async () => { await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150); };
  const providerRow = () => page.locator('.sheet-body .row.wrap .sheet-note').first().textContent();
  const count = async (kind, provider) => (await logOf()).filter((l) => l.kind === kind && l.provider === provider).length;

  await selTool(page, 'ai'); await waitIdle(page, 300);
  const before = { center: await px(0.51, 0.49), corner: await px(0.1, 0.1) };
  await lasso();
  await askTab();
  await page.fill('.sheet textarea.ai-prompt', 'a clear blue sky with soft fluffy clouds');

  // ---------------------------------------------------------------- 1) Pollinations: 키 없이
  console.log('▶ Pollinations (키 없이 무료)');
  check('with nothing set up the card offers "key setup" and the keyless shortcut', (await page.locator('.ai-setup .btn >> text=키 설정').count()) === 1 && (await page.locator('.ai-setup .btn >> text=키 없이 쓰기: Pollinations').count()) === 1);
  await h.shot('f1_start');
  await page.click('.ai-setup .btn >> text=Pollinations'); await page.waitForTimeout(200);
  const row = await providerRow();
  check('Pollinations is ready without a key (setup card gone, provider row shows it)', (await page.locator('.ai-setup').count()) === 0 && /Pollinations/.test(row) && /키 없이 무료/.test(row), row);
  check('notes: one image per ~45 s, the provider never sees the photo', (await page.locator('.sheet .sheet-note >> text=약 45초 간격').count()) >= 1 && (await page.locator('.sheet .sheet-note >> text=사진을 보지 못하고').count()) >= 1);
  check('no "edit with photo" mode switch; examples are content presets', (await page.locator('.seg button >> text=사진 보고 편집').count()) === 0 && (await page.locator('.sheet .chip >> text=맑은 하늘').count()) === 1 && (await page.locator('.sheet .chip >> text=물체 지우기').count()) === 0);
  await h.shot('f2_pollinations_ask');
  await run();
  await consent(['image.pollinations.ai', '사진은 보내지 않아요', '45초']);
  await waitPhase('busy', 5000);
  await page.waitForSelector('.sheet .sheet-note >> text=사진은 보내지 않고', { timeout: 8000 }); // 이미지 준비(영역 계산)가 끝나면 안내가 바뀐다
  check('busy view says no photo was sent and shows no sent-image preview', (await page.locator('.ai-sent').count()) === 0 && (await page.locator('.sheet .sheet-note >> text=사진은 보내지 않고').count()) === 1);
  await waitPhase('review', 25000); await page.waitForTimeout(250);
  let log = await logOf();
  const pl = log.filter((l) => l.provider === 'pollinations');
  check('one GET /prompt request with the prompt untouched (no translation, nothing else sent)', pl.length === 1 && /^\/prompt\/[A-Za-z0-9%._~-]+\?width=\d+&height=\d+&seed=\d+$/.test(pl[0].path) && pl[0].prompt === 'a clear blue sky with soft fluffy clouds' && log.every((l) => l.provider === 'pollinations'), JSON.stringify(pl[0]));
  check('size is one of the Pollinations classes (area ≤ 768×768)', pl[0] && [[768, 768], [896, 640], [640, 896]].some(([w, hh]) => pl[0].width === w && pl[0].height === hh), pl[0] && `${pl[0].width}x${pl[0].height}`);
  check('no photo or mask was uploaded (only the prompt travels, inside the URL)', await page.evaluate(() => window.__ai.specs.every((s) => !s.len && !s.type)));
  const m1 = await px(0.51, 0.49), c1 = await px(0.1, 0.1);
  check('selection filled with the generated JPEG (no tone shift in generate mode)', near(m1, [220, 120, 30], 10), JSON.stringify(m1));
  check('pixels far outside the selection are untouched', near(c1, before.corner, 0), JSON.stringify([c1, before.corner]));
  await h.shot('f3_review_pollinations');
  check('single result: no variant picker, apply available', (await page.locator('.sheet .thumb').count()) === 0 && (await page.locator('.sheet-head .btn >> text=적용').count()) === 1);
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  let L = await layers();
  check('applied as a locked AI layer tagged pollinations / generate', L.length === 1 && L[0].ai.provider === 'pollinations' && L[0].ai.model === 'pollinations' && L[0].ai.mode === 'generate' && L[0].lock, JSON.stringify(L[0]));

  // 오류: 한도(429) / 이미지가 아닌 응답
  await lasso(); await askTab();
  await page.evaluate(() => { window.__ai.plMode = 'rate'; });
  await runToSelect();
  check('429 → "one image per ~45 seconds" (not a generic error)', /45초/.test(await errText()));
  await page.evaluate(() => { window.__ai.plMode = 'html'; });
  await runToSelect();
  check('an HTML page instead of an image is reported, without leaking markup', /이미지를 받지 못했어요/.test(await errText()) && !/<html>/.test(await errText()));
  await page.evaluate(() => { window.__ai.plMode = 'text'; });
  await runToSelect();
  check('a plain-text reply is shown as the reason', /이미지를 받지 못했어요/.test(await errText()) && /Queue full/.test(await errText()));
  check('no layer was added after the errors', (await layers()).length === 1);
  await page.evaluate(() => { window.__ai.plMode = 'ok'; });
  const seed1 = pl[0].seed;
  await run(); await waitPhase('busy', 5000); await waitPhase('review', 25000); await page.waitForTimeout(250);
  const pl2 = (await logOf()).filter((l) => l.provider === 'pollinations' && l.kind === 'generate').at(-1);
  check('"Regenerate" style requests use a fresh random seed', pl2 && pl2.seed !== seed1, `${seed1} → ${pl2 && pl2.seed}`);
  await discard(); await askTab();

  // ---------------------------------------------------------------- 2) ModelScope
  console.log('▶ ModelScope API-Inference (무료 체험)');
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  check('settings open on the active provider (Pollinations): no key needed', (await page.locator('.msheet .chip[data-id=pollinations]').getAttribute('aria-checked')) === 'true' && (await page.locator('.msheet .kv b').textContent()) === '필요 없음' && (await page.locator('.msheet input[type=password]').count()) === 0 && (await page.locator('.msheet .btn >> text=연결 테스트').count()) === 0);
  check('every provider chip carries its tag (daily free / free, no key / free trial)', /하루 무료/.test(await page.locator('.msheet .chip[data-id=cloudflare]').textContent()) && /키 없이 무료/.test(await page.locator('.msheet .chip[data-id=pollinations]').textContent()) && /무료 체험/.test(await page.locator('.msheet .chip[data-id=modelscope]').textContent()));
  await page.click('.msheet .chip[data-id=modelscope]'); await page.waitForTimeout(150);
  check('ModelScope tab: token only (no account ID), model selection, connection test', (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 0 && (await page.locator('.msheet input[type=password]').getAttribute('placeholder')) === 'ModelScope 액세스 토큰' && (await page.locator('.msheet .seg button >> text=자동 (권장)').count()) === 1 && (await page.locator('.msheet .btn >> text=연결 테스트').count()) === 1 && /Qwen\/Qwen-Image/.test(await page.locator('.msheet').last().textContent()));
  await page.fill('.msheet input[type=password]', 'ms-1a2b3c4d-5e6f7a8b');
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('token saved natively in its own slot (no account value)', (await page.locator('.msheet .kv b').textContent()).includes('7a8b') && JSON.stringify(await page.evaluate(() => window.__ai.setKeyCalls.at(-1))) === JSON.stringify(['modelscope', 'key', '']));
  await page.evaluate(() => { window.__ai.mode = 'e401'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('a rejected token is reported by the connection test', /API 키\(토큰\)가 올바르지 않아요/.test(await page.locator('.msheet .ai-msg').textContent()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; });
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  check('connection test confirms the token and names the model', /연결됐어요/.test(await page.locator('.msheet .ai-msg').textContent()) && /Qwen\/Qwen-Image/.test(await page.locator('.msheet .ai-msg').textContent()));
  await h.shot('f4_settings_modelscope');
  await closeModal();
  check('the provider row now shows ModelScope (saving a token selects it)', /ModelScope/.test(await providerRow()) && (await page.locator('.ai-setup').count()) === 0);
  await run();
  await consent(['api-inference.modelscope.cn', '알리바바', '사진은 보내지 않아요']);
  await waitPhase('busy', 5000);
  await waitPhase('review', 40000); await page.waitForTimeout(250);
  log = await logOf();
  const sub = log.find((l) => l.provider === 'modelscope' && l.kind === 'submit');
  check('POST /images/generations (JSON): default model Qwen-Image, prompt, size class — and nothing else', sub && sub.type === 'application/json' && sub.model === 'Qwen/Qwen-Image' && sub.prompt === 'a clear blue sky with soft fluffy clouds' && /^(1024x1024|1152x768|768x1152)$/.test(sub.size) && sub.keys.join() === 'model,prompt,size', JSON.stringify(sub));
  const polls = log.filter((l) => l.provider === 'modelscope' && l.kind === 'poll'), dl = log.filter((l) => l.kind === 'download');
  check('status checked via GET /tasks/{id}; the result image was downloaded once from the Alibaba Cloud address', polls.length >= 1 && polls.every((p) => /^task-\d+-abcdef$/.test(p.taskId)) && dl.length === 1 && /^https:\/\/muse-ai\.oss-cn-hangzhou\.aliyuncs\.com\/img\/task-\d+-abcdef\.png\?/.test(dl[0].url), JSON.stringify([polls.length, dl[0] && dl[0].url]));
  check('no photo or mask was uploaded', await page.evaluate(() => window.__ai.specs.every((s) => !/multipart|image/.test(s.type || ''))));
  const m2 = await px(0.51, 0.49), c2 = await px(0.1, 0.1);
  check('selection filled with the downloaded image', near(m2, [40, 90, 200], 8), JSON.stringify(m2));
  check('pixels far outside the selection are untouched', near(c2, before.corner, 0), JSON.stringify(c2));
  await h.shot('f5_review_modelscope');
  await discard(); await askTab();

  // 실패 / 이상 응답
  const pollsNow = () => count('poll', 'modelscope');
  await page.evaluate(() => { window.__ai.mode = 'e401'; });
  await runToSelect();
  check('401 on submit → key error + settings shortcut', /API 키\(토큰\)가 올바르지 않아요/.test(await errText()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  await page.evaluate(() => { window.__ai.mode = 'e429free'; });
  await runToSelect();
  check('free allowance exhausted → explained', /오늘의 무료 사용량/.test(await errText()));
  await page.evaluate(() => { window.__ai.mode = 'ok'; window.__ai.msMode = 'notask'; });
  await runToSelect();
  check('no task id in the reply → explained', /작업 번호를 돌려주지 않았어요/.test(await errText()));
  await page.evaluate(() => { window.__ai.msMode = 'fail'; });
  await runToSelect(40000);
  check('task FAILED → the reason is shown', /ModelScope 가 이미지를 만들지 못했어요/.test(await errText()) && /prompt blocked/.test(await errText()));
  await page.evaluate(() => { window.__ai.msMode = 'noimage'; });
  await runToSelect(40000);
  check('task finished without an image → explained', /이미지를 받지 못했어요/.test(await errText()));
  await page.evaluate(() => { window.__ai.msMode = 'dlhtml'; });
  await runToSelect(40000);
  check('downloaded file is not an image (expired link) → explained, nothing added', /이미지를 받지 못했어요/.test(await errText()) && (await layers()).length === 1);
  await page.evaluate(() => { window.__ai.msMode = 'ok'; });

  // 취소: 상태 확인을 기다리는 동안 눌러도 더 이상 요청하지 않는다
  const sub0 = await count('submit', 'modelscope');
  await run(); await waitPhase('busy', 5000);
  await page.waitForFunction((n) => window.__ai.log.filter((l) => l.kind === 'submit').length > n, sub0, { timeout: 10000 });
  const p0 = await pollsNow();
  await page.click('.sheet-head .btn >> text=취소');
  await waitPhase('select', 8000);
  await page.waitForTimeout(4500); // 다음 상태 확인 시각(3초)이 지나도 아무 요청이 없어야 한다
  check('cancel while waiting for the task: returns quietly and no further status checks are sent', (await pollsNow()) === p0 && (await page.locator('.ai-msg.err').count()) === 0 && (await layers()).length === 1, `${p0} → ${await pollsNow()}`);

  // 모델 직접 지정 + 느린 작업(진행 중 한 번)
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  await page.click('.msheet .seg button >> text=직접 지정'); await page.waitForTimeout(150);
  check('manual model: presets listed (Qwen-Image · Z-Image-Turbo · FLUX.1 Krea)', (await page.locator('.msheet .chip >> text=Qwen/Qwen-Image').count()) === 1 && (await page.locator('.msheet .chip >> text=Tongyi-MAI/Z-Image-Turbo').count()) === 1 && (await page.locator('.msheet .chip >> text=black-forest-labs/FLUX.1-Krea-dev').count()) === 1);
  await page.click('.msheet .chip >> text=Tongyi-MAI/Z-Image-Turbo'); await page.waitForTimeout(100);
  check('the choice is saved in the settings', (await page.evaluate(() => window.imagefix.settings.ai.p.modelscope.model)) === 'Tongyi-MAI/Z-Image-Turbo');
  await closeModal();
  await page.evaluate(() => { window.__ai.msPolls = 1; });
  await run(); await waitPhase('busy', 5000);
  await waitPhase('review', 45000); await page.waitForTimeout(250);
  log = await logOf();
  const sub2 = log.filter((l) => l.kind === 'submit').at(-1);
  const lastTask = log.filter((l) => l.kind === 'poll').at(-1).taskId;
  const polls2 = log.filter((l) => l.kind === 'poll' && l.taskId === lastTask);
  check('the chosen model is sent; a still-running task is polled again (PENDING → SUCCEED)', sub2.model === 'Tongyi-MAI/Z-Image-Turbo' && polls2.length === 2, `${sub2.model} polls=${polls2.length}`);
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  L = await layers();
  check('applied as a second AI layer tagged modelscope / generate', L.length === 2 && L[1].ai.provider === 'modelscope' && L[1].ai.model === 'Tongyi-MAI/Z-Image-Turbo' && L[1].ai.mode === 'generate' && L[1].lock, JSON.stringify(L[1]));
  await page.evaluate(() => { window.__ai.msPolls = 0; });

  // ---------------------------------------------------------------- 3) 제공자 전환 · 설정 유지
  console.log('▶ 전환 / 설정 유지');
  await lasso(); await askTab();
  await page.click('.sheet .btn >> text=바꾸기'); await page.waitForTimeout(200);
  await page.click('.msheet .chip[data-id=cloudflare]'); await page.waitForTimeout(120);
  check('Cloudflare slot is empty (keys are kept per provider)', (await page.locator('.msheet .kv b').textContent()).includes('없음') && (await page.locator('.msheet input[name=imagefix-ai-account]').count()) === 1);
  await page.click('.msheet .chip[data-id=modelscope]'); await page.waitForTimeout(120);
  check('ModelScope keeps its token when switching back', (await page.locator('.msheet .kv b').textContent()).includes('7a8b'));
  await page.click('.msheet .btn >> text=키 삭제'); await page.waitForTimeout(150);
  check('removing the token clears only this provider and its consent', (await page.locator('.msheet .kv b').textContent()).includes('없음') && (await page.evaluate(() => !window.__ai.prov.modelscope.key && !('modelscope:text' in window.imagefix.settings.ai.consents))));
  await closeModal();
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('imagefix.settings')).ai);
  check('settings persist the provider, per-provider model state and consents (never a key)', st.provider === 'modelscope' && st.consents['pollinations:text'] === 'image.pollinations.ai' && st.p.modelscope.model === 'Tongyi-MAI/Z-Image-Turbo' && !JSON.stringify(st).includes('ms-1a2b3c4d'), JSON.stringify(st).slice(0, 240));

  // ---------------------------------------------------------------- 4) 옛 설정(OpenAI / OpenRouter) 정리
  console.log('▶ 옛 설정 정리');
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('imagefix.settings') || '{}');
    s.ai = { provider: 'openrouter', genProvider: 'openai', quality: 'high', n: 2, model: 'manual', consent: { base: 'https://api.openai.com/v1', ts: 1 },
      p: { openai: { model: 'manual', custom: 'gpt-image-x', models: ['gpt-image-1'] }, openrouter: { model: 'auto', free: ['a/b:free'], models: [] }, cloudflare: { model: 'auto', custom: '', models: [] } },
      consents: { openai: 'api.openai.com', 'openai:text': 'api.openai.com', openrouter: 'openrouter.ai', 'openrouter:text': 'openrouter.ai', cloudflare: 'api.cloudflare.com' } };
    localStorage.setItem('imagefix.settings', JSON.stringify(s));
  });
  await page.reload();
  await page.waitForSelector('.home .tile', { timeout: 15000 });
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(300);
  const mig = await page.evaluate(() => { const a = window.imagefix.settings.ai; return { provider: a.provider, gen: a.genProvider, p: Object.keys(a.p), consents: Object.keys(a.consents), extra: ['quality', 'n', 'model', 'consent'].filter((k) => k in a) }; });
  check('legacy OpenAI / OpenRouter settings and consents are dropped; Cloudflare kept; provider falls back', mig.provider === 'cloudflare' && mig.gen === undefined && mig.p.join() === 'cloudflare' && mig.consents.join() === 'cloudflare' && mig.extra.length === 0, JSON.stringify(mig));
  check('the generator offers only the three providers; the keyless one is selected (nothing is set up)', (await page.locator('.msheet .chip[data-id]').evaluateAll((els) => els.map((e) => e.dataset.id).filter((id) => !/^\d+$/.test(id)))).join() === 'cloudflare,pollinations,modelscope' && (await page.locator('.msheet .chip[data-id=pollinations]').getAttribute('aria-checked')) === 'true');
  await h.shot('f6_generator_providers');

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ ai_free all passed');
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
