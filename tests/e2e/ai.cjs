// AI 수정 E2E: 가짜 window.Android(AI 릴레이)로 선택(올가미) → 키 설정 → 동의 → 요청(마스크/이미지 검증) → 결과 합성(선택 안쪽만) →
// 적용/실행 취소/레이어/저장 내보내기 → 오류·취소·변형 2장 → 자동 복구(새로고침 후 복원)까지 확인한다.
const path = require('path');
const { launch, close, waitIdle } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

const init = () => {
  let started = null;
  try { started = sessionStorage.getItem('t_started'); sessionStorage.setItem('t_started', '1'); } catch (e) { /* noop */ }
  let pending = started ? 0 : 1;
  const ai = { key: null, base: 'https://api.openai.com/v1', hint: '' };
  const S = window.__ai = { log: [], mode: 'ok', jobs: {}, results: {}, modelIds: ['gpt-4o', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini'], delay: 600, setKeyCalls: [] };
  let seq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const blobB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  async function run(id) {
    const j = S.jobs[id];
    if (j.spec.path === '/models') {
      await sleep(40);
      if (S.mode === 'e401') { j.state = 'error'; j.err = { status: 401, code: 'invalid_api_key', message: 'Incorrect API key provided' }; return; }
      j.ids = S.modelIds; j.n = 0; j.state = 'done'; return;
    }
    const bin = atob(j.chunks.join('')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const fd = await new Response(new Blob([u8]), { headers: { 'content-type': j.spec.type } }).formData();
    const img = await createImageBitmap(fd.get('image')), msk = await createImageBitmap(fd.get('mask'));
    const W = img.width, H = img.height;
    const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
    x.drawImage(msk, 0, 0); const md = x.getImageData(0, 0, W, H).data;
    let tr = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    for (let p = 0; p < W * H; p++) if (md[p * 4 + 3] === 0) { tr++; const px = p % W, py = (p / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    S.log.push({ path: j.spec.path, type: j.spec.type, len: u8.length, model: fd.get('model'), size: fd.get('size'), quality: fd.get('quality'), n: +fd.get('n'), prompt: String(fd.get('prompt')), imgW: W, imgH: H, maskW: msk.width, maskH: msk.height, transparent: tr, bbox: [x0, y0, x1 + 1, y1 + 1], imgType: fd.get('image').type, imgName: fd.get('image').name });
    // 지연(취소 가능)
    const end = Date.now() + S.delay;
    while (Date.now() < end) { if (j.cancelled) { j.state = 'cancelled'; return; } await sleep(40); }
    if (j.cancelled) { j.state = 'cancelled'; return; }
    if (S.mode === 'e401') { j.state = 'error'; j.err = { status: 401, code: 'invalid_api_key', message: 'Incorrect API key provided: sk-...1234' }; return; }
    if (S.mode === 'e429') { j.state = 'error'; j.err = { status: 429, code: 'insufficient_quota', message: 'You exceeded your current quota' }; return; }
    // 결과 생성: 편집 영역(마스크 alpha 0)은 변형별 색, 나머지는 원본 + 전역 밝기 drift(+6) 흉내
    x.clearRect(0, 0, W, H); x.drawImage(img, 0, 0);
    const od = x.getImageData(0, 0, W, H);
    const n = +fd.get('n') || 1;
    const outs = [];
    for (let i = 0; i < n; i++) {
      const o = new ImageData(new Uint8ClampedArray(od.data), W, H);
      for (let p = 0; p < W * H; p++) {
        if (md[p * 4 + 3] === 0) { o.data[p * 4] = 220 - 40 * i; o.data[p * 4 + 1] = 40; o.data[p * 4 + 2] = 200; }
        else { o.data[p * 4] += 6; o.data[p * 4 + 1] += 6; o.data[p * 4 + 2] += 6; }
        o.data[p * 4 + 3] = 255;
      }
      x.putImageData(o, 0, 0);
      outs.push(await blobB64(await new Promise((r) => c.toBlob(r, 'image/png'))));
    }
    S.results[id] = outs; j.n = n; j.state = 'done';
  }
  window.Android = {
    deviceInfo: () => JSON.stringify({ sdk: 34, memMB: 6000, camera: true, model: 'Fake' }),
    pendingCount: () => pending, clearPending: () => { pending = 0; },
    pickImages: () => {}, takePhoto: () => {}, setBars: () => {}, toast: () => {}, haptic: () => {}, keepScreenOn: () => {}, exit: () => {},
    aiInfo: () => JSON.stringify({ v: 1, hasKey: !!ai.key, hint: ai.hint, base: ai.base }),
    aiSetKey: (k, b) => { S.setKeyCalls.push([k ? 'key' : '', b]); if (b && !/^https:\/\//.test(b)) return 'ERR:badbase'; if (k) { ai.key = k; ai.hint = k.slice(0, 3) + '…' + k.slice(-4); } else if (!ai.key) return 'ERR:badkey'; if (b) ai.base = b; return 'OK'; },
    aiClearKey: () => { ai.key = null; ai.hint = ''; },
    aiBegin: (spec) => { const s = JSON.parse(spec); const id = 'a' + (++seq); S.jobs[id] = { spec: s, chunks: [], state: 'uploading' }; return id; },
    aiChunk: (id, b64) => { S.jobs[id].chunks.push(b64); return true; },
    aiSend: (id) => { S.jobs[id].state = 'running'; run(id).catch((e) => { S.jobs[id].state = 'error'; S.jobs[id].err = { status: 0, code: 'bad_response', message: String(e) }; }); return true; },
    aiStatus: (id) => {
      const j = S.jobs[id]; if (!j) return JSON.stringify({ state: 'error', status: 0, code: 'gone' });
      if (j.state === 'done') return JSON.stringify({ state: 'done', n: j.n, ids: j.ids });
      if (j.state === 'error') return JSON.stringify({ state: 'error', ...j.err });
      return JSON.stringify({ state: j.state });
    },
    aiCancel: (id) => { if (S.jobs[id]) S.jobs[id].cancelled = true; },
    aiRelease: (id) => { if (S.jobs[id]) S.jobs[id].released = true; },
  };
};

let HH = null;
(async () => {
  const h = HH = await launch({ shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }], init });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await page.route('**/__ai/**', async (route) => {
    const m = /\/__ai\/([^/]+)\/(\d+)/.exec(route.request().url());
    const b64 = m ? await page.evaluate(([id, i]) => (window.__ai.results[id] || [])[i], [m[1], +m[2]]) : null;
    if (!b64) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(b64, 'base64') });
  });
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await waitIdle(page, 300);

  // 사진 위 상대 좌표 → 화면 좌표
  const pt = async (fx, fy) => page.evaluate(([fx, fy]) => { const r = window.imagefix.editor.view.photo.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);
  const lasso = async () => {
    const ring = [[0.40, 0.30], [0.51, 0.28], [0.62, 0.30], [0.66, 0.50], [0.62, 0.68], [0.51, 0.70], [0.40, 0.68], [0.36, 0.50], [0.40, 0.30]];
    const P = []; for (const [a, b] of ring) P.push(await pt(a, b));
    await page.mouse.move(P[0][0], P[0][1]); await page.mouse.down();
    for (let i = 1; i < P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i]; for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6); }
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  const sel = () => page.evaluate(() => { const s = window.imagefix.editor.tool.selection(); let sum = 0; for (let i = 0; i < s.mask.length; i++) sum += s.mask[i]; const at = (fx, fy) => s.mask[Math.floor(fy * s.h) * s.w + Math.floor(fx * s.w)]; return { cov: sum / 255 / s.mask.length, center: at(0.51, 0.49), corner: at(0.1, 0.1), phase: s.phase }; });
  const px = (fx, fy) => page.evaluate(([fx, fy]) => { const cv = window.imagefix.editor.view.photo; const d = cv.getContext('2d').getImageData(Math.floor(fx * cv.width), Math.floor(fy * cv.height), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
  const layers = () => page.evaluate(() => window.imagefix.editor.doc().layers.map((l) => ({ t: l.t, ai: l.ai ? { model: l.ai.model } : null, lock: !!l.lock, opacity: l.opacity, w: l.w, x: l.x, y: l.y, asset: l.asset })));
  const phase = () => page.evaluate(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase);

  // ---------------------------------------------------------------- 1) 열기 + 올가미 선택
  console.log('▶ 선택');
  await page.click('[data-tool=ai]'); await waitIdle(page, 300);
  check('AI tool opens with step tabs', (await page.locator('.seg button >> text=영역 선택').count()) === 1 && (await page.locator('.seg button >> text=AI 요청').count()) === 1);
  check('tool strip has AI edit label', (await page.locator('[data-tool=ai] .lbl').textContent()) === 'AI 수정');
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
  check('setup banner shown without key', (await page.locator('.ai-setup').count()) === 1);
  await page.fill('.sheet textarea.ai-prompt', '셔츠를 파란색으로 바꿔 주세요');
  await h.shot('a2_ask');
  await page.click('.sheet-head .btn >> text=AI로 수정'); await page.waitForTimeout(200);
  check('running without key opens AI settings', (await page.locator('.msheet').count()) === 1 && (await page.locator('.msheet h2').first().textContent()) === 'AI 설정');
  await page.fill('.msheet input[type=password]', 'sk-test-abcdefghijkl');
  await page.click('.msheet .btn >> text=키 저장'); await page.waitForTimeout(150);
  check('key saved natively (hint shown, input cleared)', (await page.locator('.msheet .kv b').textContent()).includes('abcdefghijkl'.slice(-4)) && (await page.inputValue('.msheet input[type=password]')) === '');
  await h.shot('a6_settings');
  await page.click('.msheet .btn >> text=연결 테스트'); await page.waitForTimeout(700);
  const tm = await page.locator('.msheet .ai-msg').textContent();
  check('connection test lists image models', /gpt-image-1\.5/.test(tm) && /gpt-image-1-mini/.test(tm) && !/gpt-4o/.test(tm), tm);
  await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(150);

  // ---------------------------------------------------------------- 3) 요청 → 동의 → 결과
  console.log('▶ 요청 / 결과');
  await page.click('.sheet-head .btn >> text=AI로 수정'); await page.waitForTimeout(250);
  check('consent dialog before the first request', (await page.locator('.dialog').count()) === 1 && /api\.openai\.com/.test(await page.locator('.dialog p').textContent()));
  await page.click('.dialog .btn >> text=동의하고 계속');
  await page.waitForFunction(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase === 'busy', null, { timeout: 5000 });
  await page.waitForTimeout(300);
  await h.shot('a3_busy');
  check('busy state shows sent image preview + cancel', (await page.locator('.ai-sent').count()) === 1 && (await page.locator('.sheet-head .btn >> text=취소').count()) === 1);
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'review', null, { timeout: 20000 });
  await page.waitForTimeout(250);
  const log = await page.evaluate(() => window.__ai.log);
  const rq = log.find((l) => l.path === '/images/edits');
  check('model auto-resolved to the newest gpt-image', rq && rq.model === 'gpt-image-1.5', rq && rq.model);
  check('request: size/quality/n/format', rq && /^(1024x1024|1536x1024|1024x1536)$/.test(rq.size) && rq.quality === 'medium' && rq.n === 1 && rq.imgType === 'image/png' && rq.imgName === 'image.png', JSON.stringify(rq && [rq.size, rq.quality, rq.n, rq.imgType]));
  check('request: image and mask are the provider size', rq && `${rq.imgW}x${rq.imgH}` === rq.size && rq.maskW === rq.imgW && rq.maskH === rq.imgH, rq && `${rq.imgW}x${rq.imgH} mask ${rq.maskW}x${rq.maskH}`);
  check('request: prompt = user text + keep-outside rules', rq && rq.prompt.startsWith('셔츠를 파란색으로 바꿔 주세요') && /masked/.test(rq.prompt));
  const tf = rq ? rq.transparent / (rq.imgW * rq.imgH) : 0;
  check('request: mask has a transparent (edit) region inside the image', tf > 0.04 && tf < 0.6 && rq.bbox[0] > 0 && rq.bbox[1] > 0 && rq.bbox[2] < rq.imgW && rq.bbox[3] < rq.imgH, JSON.stringify([tf.toFixed(3), rq && rq.bbox]));
  check('request: only the selected area + context was sent (not the whole photo)', rq && rq.len < 12 * 1024 * 1024 && rq.imgW <= 1536);
  const mid = await px(0.51, 0.49), corner = await px(0.1, 0.1);
  check('result blended inside the selection (tone-matched AI color)', Math.abs(mid[0] - 214) <= 4 && Math.abs(mid[1] - 34) <= 4 && Math.abs(mid[2] - 194) <= 4, JSON.stringify(mid));
  check('pixels far outside the selection are untouched', corner.every((v, i) => v === before.corner[i]), JSON.stringify([corner, before.corner]));
  await h.shot('a4_review');
  check('review actions: apply + discard', (await page.locator('.sheet-head .btn >> text=적용').count()) === 1 && (await page.locator('[aria-label="버리기"]').count()) === 1);
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
  check('applied as a locked AI image layer', L.length === 1 && L[0].t === 'image' && L[0].ai && L[0].ai.model === 'gpt-image-1.5' && L[0].lock === true && L[0].w > 0, JSON.stringify(L));
  const hist = await page.evaluate(() => window.imagefix.editor.store.history().map((x) => x.label));
  check('history label', hist.includes('AI 수정'), hist.join('|'));
  check('selection reset after apply, back to select step', (await sel()).cov === 0);
  await page.evaluate(() => window.imagefix.editor.undo()); await page.waitForTimeout(200);
  check('undo removes the AI layer', (await layers()).length === 0 && (await px(0.51, 0.49)).every((v, i) => Math.abs(v - before.center[i]) <= 2));
  await page.evaluate(() => window.imagefix.editor.redo()); await page.waitForTimeout(200);
  check('redo restores it', (await layers()).length === 1);
  await page.evaluate(() => window.imagefix.editor.closeTool(true)); await page.waitForTimeout(200);
  await page.click('[data-tool=layers]'); await page.waitForTimeout(200);
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
  await page.click('[data-tool=ai]'); await waitIdle(page, 200);
  await lasso();
  await page.evaluate(() => { window.__ai.mode = 'e401'; });
  await page.click('.seg button >> text=AI 요청'); await page.fill('.sheet textarea.ai-prompt', '하늘을 바꿔 주세요');
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'busy', null, { timeout: 5000 });
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select', null, { timeout: 15000 });
  await page.waitForTimeout(200);
  check('401 shows a key error with a settings shortcut', /API 키가 올바르지 않아요/.test(await page.locator('.ai-msg.err').textContent()) && (await page.locator('.sheet .btn >> text=AI 설정 열기').count()) === 1);
  check('no layer added and no stale preview after an error', (await layers()).length === 1 && (await page.evaluate(() => window.imagefix.editor.store.get() === window.imagefix.editor.store.getBase())));
  await h.shot('a7_error');
  await page.evaluate(() => { window.__ai.mode = 'e429'; });
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'select' && document.querySelector('.ai-msg.err'), null, { timeout: 15000 });
  check('429 quota message', /잔액|한도/.test(await page.locator('.ai-msg.err').textContent()));
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
  check('cancel stops the job natively and returns quietly', cancelled >= 1 && (await page.locator('.ai-msg.err').count()) === 0 && (await layers()).length === 1);
  await page.evaluate(() => { window.__ai.delay = 600; });

  // ---------------------------------------------------------------- 6) 변형 2장
  console.log('▶ 변형 2장');
  await page.click('.seg button >> text=AI 요청');
  await page.locator('.seg[aria-label="생성 개수"] button >> text=2').click();
  await page.click('.sheet-head .btn >> text=AI로 수정');
  await page.waitForFunction(() => window.imagefix.editor.tool.selection().phase === 'review', null, { timeout: 20000 });
  await page.waitForTimeout(300);
  check('two variants listed', (await page.locator('.sheet .thumb').count()) === 2);
  const v1 = await px(0.51, 0.49);
  await page.locator('.sheet .thumb').nth(1).click(); await page.waitForTimeout(250);
  const v2 = await px(0.51, 0.49);
  check('switching variants changes the preview', Math.abs(v1[0] - v2[0]) > 20, JSON.stringify([v1, v2]));
  await h.shot('a5_variants');
  await page.click('.sheet-head .btn >> text=적용'); await page.waitForTimeout(300);
  L = await layers();
  check('second AI layer added (variant 2); unused variant asset dropped', L.length === 2 && (await page.evaluate(() => window.imagefix.editor.assets.size)) === 2, String(L.length));
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
  await page.click('.msheet .btn >> text=AI 설정'); await page.waitForTimeout(200);
  check('AI settings reachable from app settings', (await page.locator('.msheet h2 >> text=AI 설정').count()) >= 1);

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
      console.log('--- phase:', await HH.page.evaluate(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase));
      console.log('--- errors:', HH.errors.join('\n'));
      await HH.shot('a_fail');
    }
  } catch (e2) { /* noop */ }
  process.exit(1);
});
