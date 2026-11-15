// AI E2E 공용: 가짜 window.Android(기본 브리지 + AI 릴레이) + 페이지 도우미.
// 가짜 릴레이는 네이티브(AiClient)와 같은 허용 목록(제공자별 경로/본문 형식)을 검사해서, 웹이 허용되지 않는 요청을 보내면 'ERR:path' 로 실패한다.
// 모델은 업로드된 이미지를 실제로 읽어서(OpenAI: 마스크 / OpenRouter·Cloudflare: 표시 이미지와 원본의 차이) 선택 영역만 색칠한 결과를 돌려준다.
const path = require('path');
const { OUT, DATE } = require('./lib.cjs');
void path; void OUT; void DATE;

/** addInitScript 로 직렬화되므로 자체 완결이어야 한다 */
const init = () => {
  let started = null;
  try { started = sessionStorage.getItem('t_started'); sessionStorage.setItem('t_started', '1'); } catch (e) { /* noop */ }
  let pending = started ? 0 : 1;
  const prov = { openai: { key: null, base: 'https://api.openai.com/v1', hint: '', extra: '', prot: 'hw', unreadable: false }, openrouter: { key: null, base: 'https://openrouter.ai/api/v1', hint: '', extra: '', prot: 'hw', unreadable: false }, cloudflare: { key: null, base: 'https://api.cloudflare.com/client/v4', hint: '', extra: '', prot: 'hw', unreadable: false } };
  const orModel = (id, created, free, edit) => ({ id, name: id, created, architecture: { input_modalities: edit ? ['image', 'text'] : ['text'], output_modalities: ['image', 'text'] }, pricing: free ? { prompt: '0', completion: '0', image: '0', request: '0' } : { prompt: '0.0000003', completion: '0.0000025', image: '0.001', request: '0' } });
  const S = window.__ai = {
    log: [], specs: [], mode: 'ok', tr: 'ok', jobs: {}, results: {}, delay: 600, setKeyCalls: [], cfBinary: false, keyMode: 'ok', selfTest: 'hw=ok sw=ok', prov,
    modelIds: ['gpt-4o', 'gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini'],
    orModels: [orModel('paid/nano-banana', 500, false, true), orModel('x-ai/grok-imagine-free:free', 300, true, true), orModel('free/text-to-image-only:free', 400, true, false), orModel('old/flux-edit:free', 100, true, true), orModel('some/text-model', 50, true, false)],
    cfModels: ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-dev', '@cf/meta/llama-3.1-8b-instruct'],
  };
  const ROUTES = {
    openai: [['POST', /^\/images\/edits$/, /^multipart\/form-data; boundary=/], ['POST', /^\/images\/generations$/, /^application\/json$/], ['GET', /^\/models$/, null]],
    openrouter: [['POST', /^\/chat\/completions$/, /^application\/json$/], ['GET', /^\/models$/, null], ['GET', /^\/key$/, null]],
    cloudflare: [['POST', /^\/accounts\/\{account\}\/ai\/run\/@cf\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/, /^(application\/json|multipart\/form-data; boundary=)/], ['GET', /^\/accounts\/\{account\}\/ai\/models\/search$/, null]],
  };
  let seq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const blobB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  const textB64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const toPng = async (c) => blobB64(await new Promise((r) => c.toBlob(r, 'image/png')));
  const fail = (j, status, code, message) => { j.state = 'error'; j.err = { status, code, message }; };
  const finishRaw = (j, id, type, b64) => { S.results[id] = [{ b64, type }]; j.n = 1; j.ctype = type; j.raw = true; j.state = 'done'; };
  const bmpOf = async (blob) => createImageBitmap(blob);
  const dataOf = (bmp) => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0); return { c, x, d: x.getImageData(0, 0, c.width, c.height) }; };
  const u8ToBlob = (u8, type) => new Blob([u8], { type });
  const decodeChunks = (j) => { const bin = atob(j.chunks.join('')); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  async function waitOrCancel(j) { const end = Date.now() + S.delay; while (Date.now() < end) { if (j.cancelled) { j.state = 'cancelled'; return false; } await sleep(40); } if (j.cancelled) { j.state = 'cancelled'; return false; } return true; }
  /** 표시 이미지(마젠타 덧칠)와 원본의 차이로 "편집 영역" 마스크를 구한다 (원본 해상도) */
  function diffMask(a, b) {
    const n = a.d.width * a.d.height, m = new Uint8Array(n);
    let cnt = 0, x0 = a.d.width, y0 = a.d.height, x1 = -1, y1 = -1;
    for (let p = 0; p < n; p++) {
      const dd = Math.abs(a.d.data[p * 4] - b.d.data[p * 4]) + Math.abs(a.d.data[p * 4 + 1] - b.d.data[p * 4 + 1]) + Math.abs(a.d.data[p * 4 + 2] - b.d.data[p * 4 + 2]);
      if (dd > 40) { m[p] = 1; cnt++; const px = p % a.d.width, py = (p / a.d.width) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    }
    return { m, cnt, bbox: [x0, y0, x1 + 1, y1 + 1] };
  }
  /** 결과 이미지 생성: 편집 영역은 변형별 색, 나머지는 원본 + 전역 밝기 drift(+6) 흉내 (outW×outH 로 최근접 확대) */
  function paintResult(orig, region, outW, outH, i) {
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = false;
    x.drawImage(orig.c, 0, 0, outW, outH);
    const o = x.getImageData(0, 0, outW, outH);
    for (let py = 0; py < outH; py++) for (let px = 0; px < outW; px++) {
      const sx = Math.min(orig.d.width - 1, Math.floor((px / outW) * orig.d.width)), sy = Math.min(orig.d.height - 1, Math.floor((py / outH) * orig.d.height));
      const p = (py * outW + px) * 4;
      if (region.m[sy * orig.d.width + sx]) { o.data[p] = 220 - 40 * i; o.data[p + 1] = 40; o.data[p + 2] = 200; }
      else { o.data[p] += 6; o.data[p + 1] += 6; o.data[p + 2] += 6; }
      o.data[p + 3] = 255;
    }
    x.putImageData(o, 0, 0);
    return c;
  }

  async function run(id) {
    const j = S.jobs[id], p = j.spec.provider, route = String(j.spec.path).split('?')[0];
    if (S.mode === 'e401' && route.endsWith('/models')) return fail(j, 401, 'invalid_api_key', 'Incorrect API key provided');
    // ------------------------------------------------------------ 목록/키 확인
    if (p === 'openai' && route === '/models') { await sleep(40); j.ids = S.modelIds; j.n = 0; j.state = 'done'; return; }
    if (p === 'openrouter' && route === '/models') { await sleep(40); return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ data: S.orModels }))); }
    if (p === 'openrouter' && route === '/key') { await sleep(20); if (S.mode === 'e401key') return fail(j, 401, '401', 'No auth credentials found'); return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ data: { label: 'test', is_free_tier: true } }))); }
    if (p === 'cloudflare' && route.endsWith('/ai/models/search')) { await sleep(30); return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ result: S.cfModels.map((name) => ({ name })), success: true, errors: [], messages: [] }))); }
    // ------------------------------------------------------------ 문구만으로 그리는 요청(생성/번역): 사진 없음
    const isTr = p === 'cloudflare' && /\/ai\/run\/@cf\/meta\/m2m100-1\.2b$/.test(route);
    const isGen = (p === 'openai' && route === '/images/generations') || (p === 'cloudflare' && /\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/.test(route));
    if (isTr || isGen) {
      const gb = JSON.parse(new TextDecoder().decode(decodeChunks(j)));
      if (isTr) {
        S.log.push({ provider: p, kind: 'translate', path: String(j.spec.path), text: gb.text, source_lang: gb.source_lang, target_lang: gb.target_lang });
        await sleep(30);
        if (S.tr === 'fail') return fail(j, 400, 'bad_request', 'invalid language');
        const out = S.tr === 'garbage' ? gb.text : (/돛단배/.test(gb.text) ? 'a small sailboat on a sunset sea, watercolor' : /하늘/.test(gb.text) ? 'a clear blue sky with soft fluffy clouds' : 'an english version of the prompt');
        return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ result: { translated_text: out }, success: true, errors: [], messages: [] })));
      }
      S.log.push({ provider: p, kind: 'generate', path: String(j.spec.path), model: p === 'openai' ? gb.model : String(j.spec.path).split('/ai/run/')[1], prompt: gb.prompt, keys: Object.keys(gb), size: gb.size, n: gb.n, quality: gb.quality });
      if (!(await waitOrCancel(j))) return;
      if (S.mode === 'e429free') return fail(j, 429, p === 'cloudflare' ? 'cf_3036' : '429', 'you have used up your daily free allocation of 10,000 neurons, please upgrade');
      if (S.mode === 'e401') return fail(j, 401, 'invalid_api_key', 'Incorrect API key provided');
      const gc = document.createElement('canvas'); gc.width = 1024; gc.height = 1024;
      const gx = gc.getContext('2d'); gx.fillStyle = 'rgb(30,160,60)'; gx.fillRect(0, 0, 1024, 1024);
      const g64 = await toPng(gc);
      if (p === 'openai') { S.results[id] = [{ b64: g64, type: 'image/png' }]; j.n = 1; j.state = 'done'; return; }
      if (S.cfBinary) return finishRaw(j, id, 'image/png', g64);
      return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ result: { image: g64 }, success: true, errors: [], messages: [] })));
    }
    // ------------------------------------------------------------ 편집 요청
    const u8 = decodeChunks(j);
    let rec, region, orig, outW, outH, n = 1;
    if (p === 'openai') {
      const fd = await new Response(new Blob([u8]), { headers: { 'content-type': j.spec.type } }).formData();
      const img = await bmpOf(fd.get('image')), msk = await bmpOf(fd.get('mask'));
      orig = dataOf(img); const mk = dataOf(msk);
      const W = img.width, H = img.height;
      let tr = 0, x0 = W, y0 = H, x1 = -1, y1 = -1; const m = new Uint8Array(W * H);
      for (let q = 0; q < W * H; q++) if (mk.d.data[q * 4 + 3] === 0) { m[q] = 1; tr++; const px = q % W, py = (q / W) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
      region = { m, cnt: tr, bbox: [x0, y0, x1 + 1, y1 + 1] };
      outW = W; outH = H; n = +fd.get('n') || 1;
      rec = { provider: p, path: route, type: j.spec.type, len: u8.length, model: fd.get('model'), size: fd.get('size'), quality: fd.get('quality'), n, prompt: String(fd.get('prompt')), imgW: W, imgH: H, maskW: msk.width, maskH: msk.height, transparent: tr, bbox: region.bbox, imgType: fd.get('image').type, imgName: fd.get('image').name };
    } else if (p === 'openrouter') {
      const body = JSON.parse(new TextDecoder().decode(u8));
      const parts = body.messages[0].content;
      const toBlob = (url) => { const b = atob(url.split(',')[1]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return u8ToBlob(a, url.slice(5, url.indexOf(';'))); };
      const A = await bmpOf(toBlob(parts[1].image_url.url)), B = await bmpOf(toBlob(parts[2].image_url.url));
      orig = dataOf(A); const mk = dataOf(B);
      region = diffMask(orig, mk); outW = A.width; outH = A.height;
      rec = { provider: p, path: route, type: j.spec.type, len: u8.length, model: body.model, modalities: body.modalities, stream: body.stream, nParts: parts.length, prompt: parts[0].text, imgW: A.width, imgH: A.height, markedW: B.width, markedH: B.height, transparent: region.cnt, bbox: region.bbox, hasN: 'n' in body, hasQuality: 'quality' in body };
    } else {
      const fd = await new Response(new Blob([u8]), { headers: { 'content-type': j.spec.type } }).formData();
      const A = await bmpOf(fd.get('input_image_0')), B = await bmpOf(fd.get('input_image_1'));
      orig = dataOf(A); const mk = dataOf(B);
      region = diffMask(orig, mk); outW = +fd.get('width'); outH = +fd.get('height');
      rec = { provider: p, path: String(j.spec.path), type: j.spec.type.split(';')[0], len: u8.length, model: String(j.spec.path).split('/ai/run/')[1], prompt: String(fd.get('prompt')), width: outW, height: outH, imgW: A.width, imgH: A.height, markedW: B.width, markedH: B.height, transparent: region.cnt, bbox: region.bbox, files: [fd.get('input_image_0').name, fd.get('input_image_1').name] };
    }
    S.log.push(rec);
    if (!(await waitOrCancel(j))) return;
    if (S.mode === 'e401') return fail(j, 401, p === 'openrouter' ? '401' : 'invalid_api_key', 'Incorrect API key provided: sk-...1234');
    if (S.mode === 'e429') return fail(j, 429, 'insufficient_quota', 'You exceeded your current quota');
    if (S.mode === 'e429free') return fail(j, 429, p === 'cloudflare' ? 'cf_3036' : '429', p === 'cloudflare' ? 'you have used up your daily free allocation of 10,000 neurons, please upgrade' : 'Rate limit exceeded: free-models-per-day | upstream');
    if (S.mode === 'noimage' && p === 'openrouter') return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'I am sorry, I cannot edit images.' } }] })));
    const outs = [];
    for (let i = 0; i < n; i++) outs.push(await toPng(paintResult(orig, region, outW, outH, i)));
    if (p === 'openai') { S.results[id] = outs.map((b64) => ({ b64, type: 'image/png' })); j.n = n; j.state = 'done'; return; }
    if (p === 'openrouter') return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ id: 'gen-1', choices: [{ message: { role: 'assistant', content: 'done', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + outs[0] } }] } }] })));
    if (S.cfBinary) return finishRaw(j, id, 'image/png', outs[0]);
    return finishRaw(j, id, 'application/json', textB64(JSON.stringify({ result: { image: outs[0] }, success: true, errors: [], messages: [] })));
  }

  window.Android = {
    deviceInfo: () => JSON.stringify({ sdk: 34, memMB: 6000, camera: true, model: 'Fake' }),
    pendingCount: () => pending, clearPending: () => { pending = 0; },
    pickImages: () => { pending = 1; setTimeout(() => window.__nativeImages && window.__nativeImages(), 30); }, takePhoto: () => {}, setBars: () => {}, toast: () => {}, haptic: () => {}, keepScreenOn: () => {}, exit: () => {},
    aiInfo: () => JSON.stringify({ v: 2, providers: Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, { hasKey: !!v.key, hint: v.hint, base: v.base, extra: v.extra, readable: !v.unreadable, prot: v.key ? v.prot : '' }])) }),
    aiSetKey: (provider, k, b, extra) => {
      S.setKeyCalls.push([provider, k ? 'key' : '', b, extra]);
      const P = prov[provider]; if (!P) return 'ERR:provider';
      if (provider === 'openai' && b && !/^https:\/\//.test(b)) return 'ERR:badbase';
      if (provider === 'cloudflare' && extra && !/^[0-9a-f]{32}$/i.test(extra)) return 'ERR:badextra';
      if (k && S.keyMode === 'store') return 'ERR:store:hw:KeyStoreException/sw:IOException';
      if (k) { if (provider === 'cloudflare' && !extra && !P.extra) return 'ERR:badextra'; P.key = k; P.hint = k.slice(0, 3) + '…' + k.slice(-4); P.prot = S.keyMode === 'sw' ? 'sw' : 'hw'; P.unreadable = S.keyMode === 'unreadable'; } else if (!P.key) return 'ERR:badkey';
      if (provider === 'openai' && b) P.base = b;
      if (provider === 'cloudflare' && extra) P.extra = extra.toLowerCase();
      return 'OK';
    },
    aiClearKey: (provider) => { if (prov[provider]) { prov[provider].key = null; prov[provider].hint = ''; prov[provider].unreadable = false; if (provider === 'cloudflare') prov[provider].extra = ''; } },
    aiSelfTest: () => S.selfTest,
    aiBegin: (spec) => {
      let s; try { s = JSON.parse(spec); } catch (e) { return 'ERR:spec'; }
      const rs = ROUTES[s.provider || 'openai']; if (!rs) return 'ERR:provider';
      const pth = String(s.path || '').split('?')[0];
      const r = rs.find((x) => x[0] === s.method && x[1].test(pth));
      if (!r) return 'ERR:path';
      if (s.method === 'POST' && !(r[2] && r[2].test(s.type || ''))) return 'ERR:type';
      if (/[?]/.test(s.path || '') && !/^[A-Za-z0-9=&._,%:-]{0,160}$/.test(String(s.path).split('?')[1])) return 'ERR:path';
      const id = 'a' + (++seq); S.jobs[id] = { spec: s, chunks: [], state: 'uploading' }; S.specs.push(s); return id;
    },
    aiChunk: (id, b64) => { S.jobs[id].chunks.push(b64); return true; },
    aiSend: (id) => {
      const j = S.jobs[id], pr = prov[j.spec.provider || 'openai'];
      j.state = 'running';
      if (!pr.key) { fail(j, 401, 'no_key', 'no api key'); return true; }
      if (pr.unreadable) { fail(j, 401, 'key_unreadable', 'stored api key cannot be decrypted'); return true; }
      if (String(j.spec.path).includes('{account}') && !pr.extra) { fail(j, 0, 'no_account', 'account id is missing'); return true; }
      run(id).catch((e) => { fail(j, 0, 'bad_response', String(e)); });
      return true;
    },
    aiStatus: (id) => {
      const j = S.jobs[id]; if (!j) return JSON.stringify({ state: 'error', status: 0, code: 'gone' });
      if (j.state === 'done') return JSON.stringify({ state: 'done', n: j.n, ids: j.ids, raw: j.raw || undefined, ctype: j.ctype });
      if (j.state === 'error') return JSON.stringify({ state: 'error', ...j.err });
      return JSON.stringify({ state: j.state });
    },
    aiCancel: (id) => { if (S.jobs[id]) S.jobs[id].cancelled = true; },
    aiRelease: (id) => { if (S.jobs[id]) S.jobs[id].released = true; },
  };
};

/** /__ai/<id>/<n> 요청에 가짜 결과를 돌려준다 */
async function installRoute(page) {
  await page.route('**/__ai/**', async (route) => {
    const m = /\/__ai\/([^/]+)\/(\d+)/.exec(route.request().url());
    const r = m ? await page.evaluate(([id, i]) => (window.__ai.results[id] || [])[i] || null, [m[1], +m[2]]) : null;
    if (!r) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ status: 200, contentType: r.type, body: Buffer.from(r.b64, 'base64') });
  });
}

/** 페이지 도우미: 사진 위 상대 좌표 / 올가미 선택 / 선택 정보 / 픽셀 / 레이어 */
function helpers(page) {
  const pt = async (fx, fy) => page.evaluate(([fx, fy]) => { const r = window.imagefix.editor.view.photo.getBoundingClientRect(); return [r.left + r.width * fx, r.top + r.height * fy]; }, [fx, fy]);
  const lasso = async () => {
    const ring = [[0.40, 0.30], [0.51, 0.28], [0.62, 0.30], [0.66, 0.50], [0.62, 0.68], [0.51, 0.70], [0.40, 0.68], [0.36, 0.50], [0.40, 0.30]];
    const P = []; for (const [a, b] of ring) P.push(await pt(a, b));
    await page.mouse.move(P[0][0], P[0][1]); await page.mouse.down();
    for (let i = 1; i < P.length; i++) { const [ax, ay] = P[i - 1], [bx, by] = P[i]; for (let s = 1; s <= 6; s++) await page.mouse.move(ax + ((bx - ax) * s) / 6, ay + ((by - ay) * s) / 6); }
    await page.mouse.up(); await page.waitForTimeout(150);
  };
  const sel = () => page.evaluate(() => { const s = window.imagefix.editor.tool.selection(); let sum = 0; for (let i = 0; i < s.mask.length; i++) sum += s.mask[i]; const at = (fx, fy) => s.mask[Math.floor(fy * s.h) * s.w + Math.floor(fx * s.w)]; return { cov: sum / 255 / s.mask.length, center: at(0.51, 0.49), corner: at(0.1, 0.1), phase: s.phase, tab: s.tab, msg: s.msg }; });
  const px = (fx, fy) => page.evaluate(([fx, fy]) => { const cv = window.imagefix.editor.view.photo; const d = cv.getContext('2d').getImageData(Math.floor(fx * cv.width), Math.floor(fy * cv.height), 1, 1).data; return [d[0], d[1], d[2]]; }, [fx, fy]);
  const layers = () => page.evaluate(() => window.imagefix.editor.doc().layers.map((l) => ({ t: l.t, ai: l.ai ? { model: l.ai.model, provider: l.ai.provider } : null, lock: !!l.lock, opacity: l.opacity, w: l.w, x: l.x, y: l.y, asset: l.asset, aw: (window.imagefix.editor.assets.get(l.asset) || {}).width, ah: (window.imagefix.editor.assets.get(l.asset) || {}).height })));
  const phase = () => page.evaluate(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase);
  const waitPhase = (p, timeout = 20000) => page.waitForFunction((want) => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase === want, p, { timeout });
  return { pt, lasso, sel, px, layers, phase, waitPhase };
}

module.exports = { init, installRoute, helpers };
