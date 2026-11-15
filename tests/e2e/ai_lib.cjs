// AI E2E 공용: 가짜 window.Android(기본 브리지 + AI 릴레이) + 페이지 도우미.
// 가짜 릴레이는 네이티브(AiClient)와 같은 허용 목록(제공자별 경로/본문 형식/쿼리, 결과 이미지 주소 도메인)을 검사해서, 웹이 허용되지 않는 요청을 보내면 'ERR:path' 로 실패한다.
// 제공자 4종을 흉내 낸다:
//  - cloudflare  : 표시 이미지 편집(FLUX.2, multipart) / 문구 생성(FLUX.1 schnell) / 번역(m2m100) / 모델 목록
//  - modelscope  : Qwen-Image-Edit — POST /images/generations(image 데이터 주소 + tt 헤더) → task_id → GET /tasks/{id} (msPolls 번 "진행 중") → 결과 URL → 내려받기(https, 허용 도메인만)
//  - gemini      : POST /models/<m>:generateContent — 3 parts(문구+원본+표시)=편집, 1 part=문구 생성, GET /models 목록 (gmMode: text | blocked)
//  - fal : POST /fal-ai/flux-lora-fill — 흰색 마스크 안쪽만 채운 결과를 data URI(또는 hfMode='url' 이면 fal 주소) 로
// 편집 모델은 업로드된 이미지를 실제로 읽어서(표시 이미지와 원본의 차이) 선택 영역만 색칠한 결과를 돌려준다.
const path = require('path');
const { OUT, DATE } = require('./lib.cjs');
void path; void OUT; void DATE;

/** addInitScript 로 직렬화되므로 자체 완결이어야 한다 */
const init = () => {
  let started = null;
  try { started = sessionStorage.getItem('t_started'); sessionStorage.setItem('t_started', '1'); } catch (e) { /* noop */ }
  let pending = started ? 0 : 1;
  const mkProv = () => ({ key: null, hint: '', extra: '', prot: 'hw', unreadable: false });
  const prov = { cloudflare: mkProv(), modelscope: mkProv(), gemini: mkProv(), fal: mkProv() };
  const S = window.__ai = {
    log: [], specs: [], mode: 'ok', tr: 'ok', jobs: {}, results: {}, delay: 600, setKeyCalls: [], cfBinary: false, keyMode: 'ok', selfTest: 'hw=ok sw=ok', prov,
    cfModels: ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-dev', '@cf/meta/llama-3.1-8b-instruct'],
    gmMode: 'ok', // Gemini: ok | text | blocked
    hfMode: 'ok', // fal.ai: ok | url(fal 주소로 답함) | gated(403 권한 없음)
    msMode: 'ok', // ModelScope: ok | fail | noimage | notask | dlhtml
    msPolls: 0, // 성공하기 전에 "진행 중"으로 답하는 횟수 (JS 는 3초 + 4초 간격으로 확인하므로 0 이면 약 3초, 1 이면 약 7초)
    tasks: {}, downloads: [], msImages: {},
    keep: [], notes: [], // aiKeepAlive(on, text) / aiNotify(title, text) 호출 기록 (백그라운드 계속 · 완료 알림)
  };
  const ROUTES = {
    cloudflare: [['POST', /^\/accounts\/\{account\}\/ai\/run\/@cf\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/, /^(application\/json|multipart\/form-data; boundary=)/], ['GET', /^\/accounts\/\{account\}\/ai\/models\/search$/, null]],
    gemini: [['POST', /^\/models\/[A-Za-z0-9][A-Za-z0-9._-]{0,60}:generateContent$/, /^application\/json$/], ['GET', /^\/models$/, null]],
    fal: [['POST', /^\/fal-ai\/flux-lora-fill$/, /^application\/json$/]],
    modelscope: [['POST', /^\/images\/generations$/, /^application\/json$/], ['GET', /^\/tasks\/[A-Za-z0-9][A-Za-z0-9._-]{5,79}$/, null], ['GET', /^\/models$/, null]],
  };
  /** 결과 이미지 내려받기 주소 검사(네이티브 checkResultUrl 과 같은 규칙): https · 사용자 정보/포트/조각 없음 · 허용 도메인 */
  const HOSTS = { modelscope: /^([a-z0-9-]+\.)*(aliyuncs\.com|modelscope\.cn|modelscope\.ai)$/, fal: /^([a-z0-9-]+\.)*(fal\.media|fal\.run)$/ };
  const urlOk = (raw, provider) => {
    let u; try { u = new URL(String(raw)); } catch (e) { return false; }
    return HOSTS[provider] && u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash
      && HOSTS[provider].test(u.hostname)
      && /^\/[A-Za-z0-9._~%!$&'()*+,;=:@/-]{0,600}$/.test(u.pathname)
      && /^[A-Za-z0-9=&._,%:+/~!*'()-]{0,900}$/.test(u.search.slice(1));
  };
  let seq = 0, taskSeq = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const blobB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  const textB64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const toImg = async (c, type = 'image/png') => blobB64(await new Promise((r) => c.toBlob(r, type, 0.95)));
  const toPng = (c) => toImg(c, 'image/png');
  const solid = async (w, h, [r, g, b], type) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.fillStyle = `rgb(${r},${g},${b})`; x.fillRect(0, 0, w, h); return toImg(c, type); };
  const fail = (j, status, code, message) => { j.state = 'error'; j.err = { status, code, message }; };
  const finishRaw = (j, id, type, b64) => { S.results[id] = [{ b64, type }]; j.n = 1; j.ctype = type; j.raw = true; j.state = 'done'; };
  const finishJson = (j, id, o) => finishRaw(j, id, 'application/json', textB64(JSON.stringify(o)));
  const bmpOf = async (blob) => createImageBitmap(blob);
  const dataOf = (bmp) => { const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0); return { c, x, d: x.getImageData(0, 0, c.width, c.height) }; };
  const dataUrlBlob = (u) => { const m = /^data:([^;]+);base64,(.*)$/.exec(String(u)); const b = atob(m[2]); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return new Blob([a], { type: m[1] }); };
  const b64Blob = (b64, type = 'image/png') => dataUrlBlob(`data:${type};base64,${b64}`);
  /** 마젠타로 표시된 사진(색 덧칠 + 테두리)에서 "편집 영역"을 찾는다: 빨강·파랑이 초록보다 확실히 큰 픽셀 */
  function magentaMask(d) {
    const n = d.d.width * d.d.height, m = new Uint8Array(n); let cnt = 0, x0 = d.d.width, y0 = d.d.height, x1 = -1, y1 = -1;
    for (let p = 0; p < n; p++) { const r = d.d.data[p * 4], g = d.d.data[p * 4 + 1], b = d.d.data[p * 4 + 2]; if (r - g > 60 && b - g > 60) { m[p] = 1; cnt++; const px = p % d.d.width, py = (p / d.d.width) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; } }
    return { m, cnt, bbox: [x0, y0, x1 + 1, y1 + 1] };
  }
  /** 흰 마스크(R>128) 안쪽 = 편집 영역 */
  function whiteMask(d) {
    const n = d.d.width * d.d.height, m = new Uint8Array(n); let cnt = 0, x0 = d.d.width, y0 = d.d.height, x1 = -1, y1 = -1;
    for (let p = 0; p < n; p++) if (d.d.data[p * 4] > 128) { m[p] = 1; cnt++; const px = p % d.d.width, py = (p / d.d.width) | 0; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    return { m, cnt, bbox: [x0, y0, x1 + 1, y1 + 1] };
  }
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
  /** 결과 이미지 생성: 편집 영역은 색(220,40,200), 나머지는 원본 + 전역 밝기 drift(+6) 흉내 (outW×outH 로 최근접 확대) */
  function paintResult(orig, region, outW, outH) {
    const c = document.createElement('canvas'); c.width = outW; c.height = outH;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.imageSmoothingEnabled = false;
    x.drawImage(orig.c, 0, 0, outW, outH);
    const o = x.getImageData(0, 0, outW, outH);
    for (let py = 0; py < outH; py++) for (let px = 0; px < outW; px++) {
      const sx = Math.min(orig.d.width - 1, Math.floor((px / outW) * orig.d.width)), sy = Math.min(orig.d.height - 1, Math.floor((py / outH) * orig.d.height));
      const p = (py * outW + px) * 4;
      if (region.m[sy * orig.d.width + sx]) { o.data[p] = 220; o.data[p + 1] = 40; o.data[p + 2] = 200; }
      else { o.data[p] += 6; o.data[p + 1] += 6; o.data[p + 2] += 6; }
      o.data[p + 3] = 255;
    }
    x.putImageData(o, 0, 0);
    return c;
  }
  /** S.mode 로 흉내 내는 공통 오류. 처리했으면 true */
  function modeFail(j, p) {
    if (S.mode === 'e401') { fail(j, 401, 'invalid_api_key', 'Incorrect API key provided: abc...1234'); return true; }
    if (S.mode === 'e429') { fail(j, 429, 'insufficient_quota', 'You exceeded your current quota'); return true; }
    if (S.mode === 'e429free') { fail(j, 429, p === 'cloudflare' ? 'cf_3036' : 'http_429', 'you have used up your daily free allocation of 10,000 neurons, please upgrade'); return true; }
    return false;
  }

  async function run(id) {
    const j = S.jobs[id], p = j.spec.provider;
    // ------------------------------------------------------------ 결과 이미지 내려받기 (인증 없음): ModelScope(OSS) · fal.ai(fal.media)
    if (j.spec.url) {
      S.downloads.push(j.spec.url); S.log.push({ provider: p, kind: 'download', url: j.spec.url });
      await sleep(40);
      if (S.msMode === 'dlhtml' && p === 'modelscope') return finishRaw(j, id, 'text/html', textB64('<html><body>expired</body></html>'));
      const b64 = S.msImages[j.spec.url];
      if (!b64) return fail(j, 404, 'http_404', 'not found');
      return finishRaw(j, id, 'image/png', b64);
    }
    const route = String(j.spec.path).split('?')[0];
    // ------------------------------------------------------------ 목록 / 토큰 확인
    if (S.mode === 'e401' && (route === '/models' || route.endsWith('/ai/models/search'))) return fail(j, 401, 'invalid_api_key', 'Invalid token');
    if (p === 'modelscope' && route === '/models') { await sleep(40); return finishJson(j, id, { object: 'list', data: [{ id: 'Qwen/Qwen-Image-Edit' }] }); }
    if (p === 'cloudflare' && route.endsWith('/ai/models/search')) { await sleep(30); return finishJson(j, id, { result: S.cfModels.map((name) => ({ name })), success: true, errors: [], messages: [] }); }
    if (p === 'gemini' && route === '/models') { await sleep(30); return finishJson(j, id, { models: [{ name: 'models/gemini-2.5-flash-image' }, { name: 'models/gemini-2.5-pro' }, { name: 'models/gemini-3-pro-image-preview' }] }); }

    // ------------------------------------------------------------ Gemini: generateContent
    if (p === 'gemini') {
      const body = JSON.parse(new TextDecoder().decode(decodeChunks(j)));
      const parts = body.contents[0].parts;
      const model = route.slice('/models/'.length).replace(/:generateContent$/, '');
      const isEdit = parts.length >= 3;
      const aspect = body.generationConfig && body.generationConfig.imageConfig ? body.generationConfig.imageConfig.aspectRatio : '1:1';
      const rec = { provider: p, kind: isEdit ? 'edit' : 'generate', path: String(j.spec.path), model, prompt: parts[0].text, nParts: parts.length, aspect, modalities: (body.generationConfig || {}).responseModalities };
      let A = null, B = null;
      if (isEdit) { A = await bmpOf(b64Blob(parts[1].inlineData.data, parts[1].inlineData.mimeType)); B = await bmpOf(b64Blob(parts[2].inlineData.data, parts[2].inlineData.mimeType)); const orig = dataOf(A); const region = diffMask(orig, dataOf(B)); Object.assign(rec, { imgW: A.width, imgH: A.height, markedW: B.width, markedH: B.height, transparent: region.cnt, bbox: region.bbox }); rec.orig = orig; rec.region = region; }
      const keep = { orig: rec.orig, region: rec.region }; delete rec.orig; delete rec.region;
      S.log.push(rec);
      if (!(await waitOrCancel(j))) return;
      if (S.mode === 'e401') return fail(j, 400, '400', 'API key not valid. Please pass a valid API key.');
      if (S.mode === 'e429free') return fail(j, 429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0');
      if (S.mode === 'e429') return fail(j, 429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.');
      if (S.gmMode === 'text') return finishJson(j, id, { candidates: [{ content: { parts: [{ text: 'I am sorry, I cannot edit images.' }] }, finishReason: 'STOP' }] });
      if (S.gmMode === 'blocked') return finishJson(j, id, { promptFeedback: { blockReason: 'SAFETY' } });
      let b64;
      if (isEdit) b64 = await toPng(paintResult(keep.orig, keep.region, A.width, A.height));
      else { const [w, h] = aspect === '3:2' ? [1152, 768] : aspect === '2:3' ? [768, 1152] : [1024, 1024]; b64 = await solid(w, h, [30, 160, 60], 'image/png'); }
      return finishJson(j, id, { candidates: [{ content: { role: 'model', parts: [{ text: 'Here is the image.' }, { inlineData: { mimeType: 'image/png', data: b64 } }] }, finishReason: 'STOP' }] });
    }

    // ------------------------------------------------------------ fal.ai: FLUX.1 Fill (fal.run) — 흰 마스크 안쪽만 채운다
    if (p === 'fal') {
      const body = JSON.parse(new TextDecoder().decode(decodeChunks(j)));
      const A = await bmpOf(dataUrlBlob(body.image_url)), M = await bmpOf(dataUrlBlob(body.mask_url));
      const orig = dataOf(A), region = whiteMask(dataOf(M));
      S.log.push({ provider: p, kind: 'edit', path: String(j.spec.path), type: j.spec.type, prompt: body.prompt, keys: Object.keys(body), sync: body.sync_mode, imgW: A.width, imgH: A.height, maskW: M.width, maskH: M.height, transparent: region.cnt, bbox: region.bbox });
      if (!(await waitOrCancel(j))) return;
      if (S.hfMode === 'gated') return fail(j, 403, 'http_403', 'forbidden');
      if (modeFail(j, p)) return;
      const out = await toPng(paintResult(orig, region, A.width, A.height));
      if (S.hfMode === 'url') { const url = `https://v3.fal.media/files/zebra/res-${id}.png`; S.msImages[url] = out; return finishJson(j, id, { images: [{ url, content_type: 'image/png' }] }); }
      return finishJson(j, id, { images: [{ url: 'data:image/png;base64,' + out, content_type: 'image/png' }] });
    }

    // ------------------------------------------------------------ ModelScope: 작업 만들기 → 상태 확인
    if (p === 'modelscope' && route === '/images/generations') {
      const body = JSON.parse(new TextDecoder().decode(decodeChunks(j)));
      const rec = { provider: p, kind: 'submit', type: j.spec.type, tt: j.spec.tt || '', model: body.model, prompt: body.prompt, size: body.size, keys: Object.keys(body), hasImage: !!body.image, sameImage: body.image === body.image_url };
      let result = null;
      if (body.image) { const A = await bmpOf(dataUrlBlob(body.image)); const orig = dataOf(A), region = magentaMask(orig); Object.assign(rec, { imgW: A.width, imgH: A.height, transparent: region.cnt, bbox: region.bbox }); result = await toPng(paintResult(orig, region, A.width, A.height)); }
      S.log.push(rec);
      await sleep(40);
      if (modeFail(j, p)) return;
      if (S.msMode === 'notask') return finishJson(j, id, {});
      const taskId = 'task-' + (++taskSeq) + '-abcdef';
      S.tasks[taskId] = { polls: 0, size: body.size, result };
      return finishJson(j, id, { task_id: taskId, request_id: 'req-' + taskSeq });
    }
    if (p === 'modelscope' && route.startsWith('/tasks/')) {
      const tid = route.slice('/tasks/'.length), T = S.tasks[tid];
      S.log.push({ provider: p, kind: 'poll', taskId: tid, tt: j.spec.tt || '' });
      await sleep(30);
      if (!T) return fail(j, 404, 'http_404', 'task not found');
      T.polls++;
      if (S.msMode === 'fail') return finishJson(j, id, { task_status: 'FAILED', errors: { message: 'prompt blocked', code: '400' } });
      if (T.polls <= S.msPolls) return finishJson(j, id, { task_status: T.polls === 1 ? 'PENDING' : 'RUNNING' });
      if (S.msMode === 'noimage') return finishJson(j, id, { task_status: 'SUCCEED', output_images: [] });
      const url = `https://muse-ai.oss-cn-hangzhou.aliyuncs.com/img/${tid}.png?Expires=1&Signature=abc%3D`;
      if (T.result) S.msImages[url] = T.result;
      else { const [w, h] = String(T.size).split('x').map(Number); S.msImages[url] = await solid(w || 1024, h || 1024, [40, 90, 200], 'image/png'); }
      return finishJson(j, id, { task_status: 'SUCCEED', output_images: [url] });
    }

    // ------------------------------------------------------------ Cloudflare: 번역 / 문구 생성(사진 없음)
    const isTr = /\/ai\/run\/@cf\/meta\/m2m100-1\.2b$/.test(route);
    const isGen = /\/ai\/run\/@cf\/black-forest-labs\/flux-1-schnell$/.test(route);
    if (isTr || isGen) {
      const gb = JSON.parse(new TextDecoder().decode(decodeChunks(j)));
      if (isTr) {
        S.log.push({ provider: p, kind: 'translate', path: String(j.spec.path), text: gb.text, source_lang: gb.source_lang, target_lang: gb.target_lang });
        await sleep(30);
        if (S.tr === 'fail') return fail(j, 400, 'bad_request', 'invalid language');
        const out = S.tr === 'garbage' ? gb.text : (/돛단배/.test(gb.text) ? 'a small sailboat on a sunset sea, watercolor' : /하늘/.test(gb.text) ? 'a clear blue sky with soft fluffy clouds' : 'an english version of the prompt');
        return finishJson(j, id, { result: { translated_text: out }, success: true, errors: [], messages: [] });
      }
      S.log.push({ provider: p, kind: 'generate', path: String(j.spec.path), model: String(j.spec.path).split('/ai/run/')[1], prompt: gb.prompt, keys: Object.keys(gb), type: j.spec.type });
      if (!(await waitOrCancel(j))) return;
      if (modeFail(j, p)) return;
      const g64 = await solid(1024, 1024, [30, 160, 60], 'image/png');
      if (S.cfBinary) return finishRaw(j, id, 'image/png', g64);
      return finishJson(j, id, { result: { image: g64 }, success: true, errors: [], messages: [] });
    }

    // ------------------------------------------------------------ Cloudflare: 사진 편집 (원본 + 표시 이미지, multipart)
    const u8 = decodeChunks(j);
    const fd = await new Response(new Blob([u8]), { headers: { 'content-type': j.spec.type } }).formData();
    const A = await bmpOf(fd.get('input_image_0')), B = await bmpOf(fd.get('input_image_1'));
    const orig = dataOf(A), mk = dataOf(B);
    const region = diffMask(orig, mk), outW = +fd.get('width'), outH = +fd.get('height');
    S.log.push({ provider: p, kind: 'edit', path: String(j.spec.path), type: j.spec.type.split(';')[0], len: u8.length, model: String(j.spec.path).split('/ai/run/')[1], prompt: String(fd.get('prompt')), width: outW, height: outH, imgW: A.width, imgH: A.height, markedW: B.width, markedH: B.height, transparent: region.cnt, bbox: region.bbox, files: [fd.get('input_image_0').name, fd.get('input_image_1').name] });
    if (!(await waitOrCancel(j))) return;
    if (modeFail(j, p)) return;
    const out = await toPng(paintResult(orig, region, outW, outH));
    if (S.cfBinary) return finishRaw(j, id, 'image/png', out);
    return finishJson(j, id, { result: { image: out }, success: true, errors: [], messages: [] });
  }

  window.Android = {
    deviceInfo: () => JSON.stringify({ sdk: 34, memMB: 6000, camera: true, model: 'Fake' }),
    pendingCount: () => pending, clearPending: () => { pending = 0; },
    pickImages: () => { pending = 1; setTimeout(() => window.__nativeImages && window.__nativeImages(), 30); }, takePhoto: () => {}, setBars: () => {}, toast: () => {}, haptic: () => {}, keepScreenOn: () => {}, exit: () => {},
    aiInfo: () => JSON.stringify({ v: 3, providers: Object.fromEntries(Object.entries(prov).map(([k, v]) => [k, { hasKey: !!v.key, hint: v.hint, extra: v.extra, readable: !v.unreadable, prot: v.key ? v.prot : '' }])) }),
    aiSetKey: (provider, k, extra) => {
      S.setKeyCalls.push([provider, k ? 'key' : '', extra]);
      const P = prov[provider]; if (!P) return 'ERR:provider';
      if (provider === 'cloudflare' && extra && !/^[0-9a-f]{32}$/i.test(extra)) return 'ERR:badextra';
      if (k && S.keyMode === 'store') return 'ERR:store:hw:KeyStoreException/sw:IOException';
      if (k) { if (provider === 'cloudflare' && !extra && !P.extra) return 'ERR:badextra'; P.key = k; P.hint = k.slice(0, 3) + '…' + k.slice(-4); P.prot = S.keyMode === 'sw' ? 'sw' : 'hw'; P.unreadable = S.keyMode === 'unreadable'; } else if (!P.key) return 'ERR:badkey';
      if (provider === 'cloudflare' && extra) P.extra = extra.toLowerCase();
      return 'OK';
    },
    aiClearKey: (provider) => { if (prov[provider]) { prov[provider].key = null; prov[provider].hint = ''; prov[provider].unreadable = false; if (provider === 'cloudflare') prov[provider].extra = ''; } },
    aiSelfTest: () => S.selfTest,
    aiKeepAlive: (on, text) => { S.keep.push([!!on, text]); },
    aiNotify: (title, text) => { S.notes.push([title, text]); },
    aiBegin: (spec) => {
      let s; try { s = JSON.parse(spec); } catch (e) { return 'ERR:spec'; }
      const rs = ROUTES[s.provider]; if (!rs) return 'ERR:provider';
      if (s.url) { // 결과 이미지 내려받기: ModelScope 만 · GET · 허용 도메인(https)
        if (s.method !== 'GET' || s.path || !urlOk(s.url, s.provider)) return 'ERR:path';
      } else {
        if (s.tt && (s.provider !== 'modelscope' || !/^(image_generation|image-to-image-generation)$/.test(s.tt))) return 'ERR:spec';
        const pth = String(s.path || '').split('?')[0];
        const r = rs.find((x) => x[0] === s.method && x[1].test(pth));
        if (!r) return 'ERR:path';
        if (s.method === 'POST' && !(r[2] && r[2].test(s.type || ''))) return 'ERR:type';
        if (/[?]/.test(s.path || '') && !/^[A-Za-z0-9=&._,%:-]{0,160}$/.test(String(s.path).split('?')[1])) return 'ERR:path';
      }
      const id = 'a' + (++seq); S.jobs[id] = { spec: s, chunks: [], state: 'uploading' }; S.specs.push(s); return id;
    },
    aiChunk: (id, b64) => { S.jobs[id].chunks.push(b64); return true; },
    aiSend: (id) => {
      const j = S.jobs[id], pr = prov[j.spec.provider];
      j.state = 'running';
      const needsKey = !j.spec.url; // 결과 내려받기는 키를 쓰지 않는다
      if (needsKey && !pr.key) { fail(j, 401, 'no_key', 'no api key'); return true; }
      if (needsKey && pr.unreadable) { fail(j, 401, 'key_unreadable', 'stored api key cannot be decrypted'); return true; }
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
  const layers = () => page.evaluate(() => window.imagefix.editor.doc().layers.map((l) => ({ t: l.t, ai: l.ai ? { model: l.ai.model, provider: l.ai.provider, mode: l.ai.mode } : null, lock: !!l.lock, opacity: l.opacity, w: l.w, x: l.x, y: l.y, asset: l.asset, aw: (window.imagefix.editor.assets.get(l.asset) || {}).width, ah: (window.imagefix.editor.assets.get(l.asset) || {}).height })));
  const phase = () => page.evaluate(() => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase);
  const waitPhase = (p, timeout = 20000) => page.waitForFunction((want) => window.imagefix.editor.tool && window.imagefix.editor.tool.selection().phase === want, p, { timeout });
  return { pt, lasso, sel, px, layers, phase, waitPhase };
}

module.exports = { init, installRoute, helpers };
