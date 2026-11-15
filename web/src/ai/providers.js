// AI 제공자 레지스트리 — 제공자마다 요청 만들기 · 응답 읽기가 다르다.
//  cloudflare   : POST /accounts/{account}/ai/run/@cf/… — Workers AI. FLUX.2 사진 편집(마스크 없음 → "표시 이미지") + FLUX.1 schnell 문구 생성. 하루 무료 한도.
//  pollinations : GET /prompt/<문구>?width&height&seed — 키 없는 무료 클래식 API. 문구로 생성만. 한 번에 한 장 · 약 45초 간격 · 768 면적 · 작은 로고.
//  modelscope   : POST /images/generations(비동기) → GET /tasks/{id} 폴링 → 결과 이미지 주소 내려받기 — 문구로 생성만(Qwen-Image 등). 무료 체험 토큰.
// 사진을 보고 고치는 "편집"은 Cloudflare 만 한다. 나머지는 "문구로 채우기 / 이미지 만들기"(사진 미전송)로 쓴다.
// 어느 경우든 결과는 "선택 안쪽에만" 합성하므로, 모델이 다른 곳을 바꿔도 사진 나머지는 그대로다.
import { t } from '../i18n.js';
import { buildMultipart } from './common.js';
import { AiError, relayRaw } from './client.js';

// ------------------------------------------------------------ 바이너리 도우미 (브라우저/Node 공용)
export function sniffType(u8) {
  if (u8.length >= 4 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'image/webp';
  return null;
}

export function base64ToBlob(b64, type) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: sniffType(u8) || type || 'application/octet-stream' });
}

/**
 * 응답 본문이 이미지인지 바이트로 확인한다(Content-Type 은 믿지 않는다). 이미지면 알맞은 형식의 Blob, 아니면 사유를 담아 no_image 오류.
 * 일반 텍스트/JSON 이면 앞부분을 메시지로 붙인다(예: 한도 안내).
 */
export async function ensureImageBlob(blob) {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const type = sniffType(head);
  if (type) return blob.type === type ? blob : new Blob([blob], { type });
  let hint = '';
  try { hint = (await blob.slice(0, 400).text()).replace(/\s+/g, ' ').trim().slice(0, 120); } catch (e) { /* 힌트 없음 */ }
  throw new AiError({ code: 'no_image', status: 200, message: /^[<{]/.test(hint) ? '' : hint });
}

// ------------------------------------------------------------ 크기 클래스
const withAr = (list) => list.map((s) => ({ ...s, ar: s.w / s.h, str: `${s.w}x${s.h}` }));
/** 1024 안팎 (ModelScope 생성, Cloudflare 생성 모델) */
export const SIZES_FREE = withAr([{ w: 1024, h: 1024 }, { w: 1152, h: 768 }, { w: 768, h: 1152 }]);
/** Cloudflare FLUX.2: 입력 이미지는 "512×512 미만"(문서) → 480 이하로 보내고, 출력은 2배(width/height 로 지정, 16의 배수) */
export const SIZES_CF = withAr([{ w: 480, h: 480, out: { w: 960, h: 960 } }, { w: 480, h: 320, out: { w: 960, h: 640 } }, { w: 320, h: 480, out: { w: 640, h: 960 } }]);
/** Pollinations 클래식: 전체 면적이 768×768(589,824px) 이하여야 한다(비율 유지) */
export const SIZES_PLN = withAr([{ w: 768, h: 768 }, { w: 896, h: 640 }, { w: 640, h: 896 }]);

// ------------------------------------------------------------ 지시형 프롬프트 (마스크가 없는 모델용)
/** 이미지 1 = 원본 크롭, 이미지 2 = 편집할 곳을 마젠타로 표시한 같은 크롭 */
export function instruct(prompt) {
  const u = String(prompt || '').trim().slice(0, 1500);
  return 'You are a precise photo editor.\n'
    + 'Image 1 is the original photo crop. Image 2 is the same crop with the area to edit highlighted in magenta.\n'
    + 'Change ONLY the highlighted area of image 1 as requested below. Keep everything else exactly the same: same framing, composition, lighting, colors and aspect ratio. '
    + 'Return the complete edited version of image 1 with no magenta highlight or outline.\n'
    + `Request: ${u}`;
}

// ------------------------------------------------------------ Cloudflare
/** Cloudflare 계정 ID(32자리 16진수). 대시보드 주소·"Account ID: …" 처럼 앞뒤에 글자가 붙은 채 붙여넣어도 32자리를 찾아 돌려준다. 없으면 '' */
export function parseAccountId(v) {
  const m = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])/.exec(String(v || ''));
  return m ? m[1].toLowerCase() : '';
}

export const CF_MODELS = ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b', '@cf/black-forest-labs/flux-2-dev'];
export const CF_MODEL_RE = /^@cf\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/** 유튜브에서 가장 많이 소개되는 무료 모델(FLUX.1 schnell, Cloudflare Workers AI). 입력은 문구뿐이라 사진을 보내지 않는다 */
export const CF_GENERATE_MODELS = ['@cf/black-forest-labs/flux-1-schnell'];
export const isCfGenerateModel = (m) => /flux-1-schnell|stable-diffusion-xl|dreamshaper|sdxl-lightning/i.test(String(m || ''));

/** 모델별 동작: edit = 사진을 보고 고침(Cloudflare FLUX.2) / generate = 문구만으로 그림(선택 안쪽을 새 그림으로 채움, 사진 미전송) */
export function modelProfile(pid, model) {
  const P = PROVIDERS[pid] || PROVIDERS.cloudflare;
  if (P.genOnly) return { mode: 'generate', usesMask: false, sizes: P.sizes, noPhoto: true };
  if (pid === 'cloudflare' && isCfGenerateModel(model)) return { mode: 'generate', usesMask: false, sizes: SIZES_FREE, noPhoto: true };
  return { mode: 'edit', usesMask: P.usesMask, sizes: P.sizes, noPhoto: false };
}

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;
export const hasHangul = (s) => HANGUL.test(String(s || ''));

/**
 * 한국어 문구 → 영어 (Cloudflare m2m100, 무료 — Cloudflare 설정이 돼 있어야 한다). FLUX 같은 모델은 영어 문구에서 훨씬 잘 그린다.
 * 실패하거나 Cloudflare 가 설정되지 않았으면 원문 그대로 진행(best-effort). relay 는 테스트용으로 바꿀 수 있다.
 */
export async function translateToEnglish(text, opts, relay = relayRaw) {
  const src = String(text || '').trim();
  if (!src || !HANGUL.test(src)) return { text: src, translated: false };
  const body = new Blob([JSON.stringify({ text: src.slice(0, 500), source_lang: 'ko', target_lang: 'en' })], { type: 'application/json' });
  try {
    const { blob } = await relay('cloudflare', { method: 'POST', path: '/accounts/{account}/ai/run/@cf/meta/m2m100-1.2b', contentType: 'application/json', body }, opts);
    const j = JSON.parse(await blob.text());
    const out = j && j.result && (j.result.translated_text || j.result.translation);
    if (typeof out === 'string' && out.trim() && !HANGUL.test(out)) return { text: out.trim().slice(0, 800), translated: true };
  } catch (e) {
    if (e instanceof AiError && e.info && e.info.code === 'cancelled') throw e;
  }
  return { text: src, translated: false };
}

export function parseCfModels(json) {
  const arr = json && Array.isArray(json.result) ? json.result : [];
  return arr.map((m) => String((m && (m.name || m.id)) || '')).filter((n) => CF_MODEL_RE.test(n) && /flux|inpaint|img2img|kontext|edit/i.test(n));
}

/** 응답(JSON {result:{image:b64}} 또는 이미지 바이너리) → 이미지 Blob 배열 */
export async function parseCloudflareImage(blob, ctype) {
  if (/^image\//i.test(ctype || '')) return [blob];
  let json;
  try { json = JSON.parse(await blob.text()); } catch (e) { throw new AiError({ code: 'bad_response', status: 200, message: 'not json' }); }
  if (json && json.success === false) {
    const e0 = (json.errors && json.errors[0]) || {};
    throw new AiError({ status: 200, code: e0.code != null ? `cf_${e0.code}` : 'bad_response', message: e0.message || 'request failed' });
  }
  const r = json && json.result;
  const b64 = (r && (r.image || (Array.isArray(r.images) && r.images[0]))) || (json && json.image);
  if (typeof b64 !== 'string' || !b64) throw new AiError({ code: 'no_image', status: 200 });
  return [base64ToBlob(b64, 'image/png')];
}

// ------------------------------------------------------------ Pollinations (클래식, 키 없음)
/** 문구에서 짝이 맞지 않는 서로게이트(깨진 글자)를 없앤다 — encodeURIComponent 가 예외를 던지지 않게 */
const wellFormed = (s) => String(s).replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

/**
 * URL 경로에 넣을 문구: 퍼센트 인코딩(네이티브가 허용하는 문자 A-Za-z0-9%._~- 만 남도록 !'()* 도 인코딩).
 * 인코딩한 길이가 maxLen 을 넘으면 문구를 조금씩 줄인다. 빈 문구면 ''
 */
export function encodePromptPath(text, maxLen = 1800) {
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  let chars = Array.from(wellFormed(String(text || '').replace(/\s+/g, ' ').trim()));
  let out = enc(chars.join(''));
  while (out.length > maxLen && chars.length > 1) { chars = chars.slice(0, Math.max(1, Math.floor(chars.length * 0.85))); out = enc(chars.join('')); }
  return out;
}

/** 요청 경로: /prompt/<문구>?width=&height=&seed= */
export function pollinationsPath(prompt, size, seed) {
  const s = size || SIZES_PLN[0];
  return `/prompt/${encodePromptPath(prompt)}?width=${s.w}&height=${s.h}&seed=${Math.abs(Math.floor(Number(seed) || 0)) % 2147483647}`;
}

/** 한도(402/429) → 쉬운 오류. 그 밖은 그대로 */
function pollinationsError(e) {
  if (e instanceof AiError && e.info && (e.info.status === 402 || e.info.status === 429)) return new AiError({ status: e.info.status, code: 'rate_free', message: e.info.message });
  return e;
}

// ------------------------------------------------------------ ModelScope API-Inference (비동기 작업)
export const MS_MODELS = ['Qwen/Qwen-Image', 'Tongyi-MAI/Z-Image-Turbo', 'black-forest-labs/FLUX.1-Krea-dev'];
export const MS_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MS_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,79}$/;

/** 작업 조회 응답 → {state: 'done'|'failed'|'pending', images: [https 주소…], message} */
export function parseModelScopeTask(json) {
  const st = String((json && (json.task_status || json.status)) || '').toUpperCase();
  const imgs = json && Array.isArray(json.output_images) ? json.output_images.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) : [];
  const er = json && json.errors;
  const msg = (er && typeof er === 'object' && (Array.isArray(er) ? er[0] && er[0].message : er.message)) || (json && (json.message || json.error_message)) || '';
  if (['SUCCEED', 'SUCCEEDED', 'SUCCESS'].includes(st)) return { state: 'done', images: imgs, message: '' };
  if (['FAILED', 'FAIL', 'ERROR', 'CANCELED', 'CANCELLED'].includes(st)) return { state: 'failed', images: [], message: String(msg || '').slice(0, 160) };
  return { state: 'pending', images: [], message: '' };
}

/** 중간에 취소할 수 있는 기다리기 */
export const sleepAbortable = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { reject(new AiError({ code: 'cancelled' })); return; }
  let tm = 0;
  const onAbort = () => { clearTimeout(tm); reject(new AiError({ code: 'cancelled' })); };
  tm = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

async function relayJson(provider, req, opts, relay) {
  const { blob } = await relay(provider, req, opts);
  try { return JSON.parse(await blob.text()); } catch (e) { throw new AiError({ code: 'bad_response', status: 200, message: 'not json' }); }
}

/**
 * 문구로 이미지 만들기: 작업 만들기(POST) → 끝날 때까지 상태 확인(GET, 3~4초 간격, 최대 pollTimeoutMs) → 결과 이미지 주소 내려받기.
 * o: {model, prompt, size}, opts: {signal, onPhase, pollTimeoutMs}. relay/wait 는 테스트용.
 */
export async function modelscopeGenerate(o, opts = {}, relay = relayRaw, wait = sleepAbortable) {
  if (!MS_MODEL_RE.test(String(o.model || ''))) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
  const body = new Blob([JSON.stringify({ model: o.model, prompt: String(o.prompt || '').slice(0, 2000), size: (o.size && o.size.str) || '1024x1024' })], { type: 'application/json' });
  const sub = await relayJson('modelscope', { method: 'POST', path: '/images/generations', contentType: 'application/json', body }, opts, relay);
  let url = sub && Array.isArray(sub.images) && sub.images[0] && typeof sub.images[0].url === 'string' ? sub.images[0].url : '';
  if (!url) {
    const taskId = sub && (sub.task_id || sub.taskId);
    if (typeof taskId !== 'string' || !MS_TASK_RE.test(taskId)) throw new AiError({ code: 'no_task', status: 200, message: '' });
    const t0 = Date.now(), limit = opts.pollTimeoutMs || 300000;
    for (let i = 0; !url; i++) {
      await wait(i === 0 ? 3000 : 4000, opts.signal);
      const r = parseModelScopeTask(await relayJson('modelscope', { method: 'GET', path: `/tasks/${taskId}` }, opts, relay));
      if (r.state === 'failed') throw new AiError({ code: 'task_failed', status: 200, message: r.message });
      if (r.state === 'done') {
        if (!r.images.length) throw new AiError({ code: 'no_image', status: 200 });
        url = r.images[0];
      } else if (Date.now() - t0 > limit) throw new AiError({ code: 'timeout' });
    }
  }
  if (opts.onPhase) opts.onPhase('download');
  const { blob } = await relay('modelscope', { method: 'GET', url }, opts);
  return [await ensureImageBlob(blob)];
}

// ------------------------------------------------------------ 레지스트리
const COMMON_PRIVACY = () => t('전체 사진은 보내지 않아요.', 'The full photo is not sent.');
const FREE_PRIVACY = () => t('무료/체험 서비스는 제공사 정책에 따라 보낸 내용이 저장·개선에 쓰일 수 있어요. 민감한 문구나 사진은 피해 주세요.', 'Free/trial services may store or use submitted content under the provider\'s policy. Avoid sensitive prompts or photos.');

export const PROVIDERS = {
  cloudflare: {
    id: 'cloudflare', short: 'Cloudflare', free: true, noKey: false, genOnly: false, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_CF,
    name: () => t('Cloudflare Workers AI (하루 무료)', 'Cloudflare Workers AI (daily free)'),
    tag: () => t('하루 무료', 'Daily free'),
    desc: () => t('FLUX.2 이미지 편집 모델을 무료 계정의 하루 무료 한도 안에서 써요(카드 불필요). 사진을 보고 고치는 "편집"은 이 제공자만 할 수 있어요. 문구로 새로 그리는 FLUX.1 schnell 과 한국어 → 영어 번역에도 써요.', 'Uses FLUX.2 image-editing models within the free daily allowance of a free account (no card). Editing with the photo is only available here. Also powers FLUX.1 schnell text-to-image and Korean → English translation.'),
    howto: () => t('dash.cloudflare.com 에 무료로 가입한 뒤, 계정 ID(대시보드 주소의 32자리 값)와 API 토큰(My Profile → API Tokens → Create Token → “Workers AI” 템플릿)을 입력해요.', 'Sign up free at dash.cloudflare.com, then enter your account ID (the 32-character value in the dashboard URL) and an API token (My Profile → API Tokens → Create Token → "Workers AI" template).'),
    host: () => 'api.cloudflare.com',
    privacy: (host) => t(`선택한 영역과 그 주변 이미지, 입력한 문구가 ${host}(Workers AI) 로 전송돼요. ${COMMON_PRIVACY()} 하루 무료 한도를 넘으면 요청이 거부돼요.`, `The selected area with its surroundings and your prompt are sent to ${host} (Workers AI). ${COMMON_PRIVACY()} Requests are refused once the daily free allowance is used up.`),
    extra: { id: 'account', label: () => t('계정 ID', 'Account ID'), placeholder: () => t('32자리 계정 ID', '32-character account ID'), parse: parseAccountId, check: (v) => !!parseAccountId(v) },
    modelPresets: CF_MODELS.concat(CF_GENERATE_MODELS), fallbackModel: CF_MODELS[0], autoModel: CF_MODELS[0], generateModel: CF_GENERATE_MODELS[0],
    async discover(opts) {
      const { blob } = await relayRaw('cloudflare', { method: 'GET', path: '/accounts/{account}/ai/models/search?per_page=50&search=flux' }, opts);
      let names = [];
      try { names = parseCfModels(JSON.parse(await blob.text())); } catch (e) { /* 목록을 못 읽어도 연결 자체는 성공 */ }
      return { list: names.length ? names : CF_MODELS.slice(), best: CF_MODELS[0], free: [] };
    },
    async test(info, opts) {
      const d = await this.discover(opts);
      return { kind: 'ok', text: t('연결됐어요(계정 ID와 토큰 확인). 사용할 모델: ', 'Connected (account ID and token verified). Models: ') + d.list.slice(0, 6).join(', '), d };
    },
    async buildEdit(o, imgs) {
      if (!CF_MODEL_RE.test(o.model)) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
      const out = o.size.out || { w: o.size.w * 2, h: o.size.h * 2 };
      const mp = buildMultipart({ prompt: instruct(o.prompt), width: String(out.w), height: String(out.h) }, [
        { name: 'input_image_0', filename: 'image.png', type: 'image/png', blob: imgs.image },
        { name: 'input_image_1', filename: 'marked.png', type: 'image/png', blob: imgs.marked },
      ]);
      return { method: 'POST', path: `/accounts/{account}/ai/run/${o.model}`, contentType: mp.contentType, body: mp.body };
    },
    async edit(req, opts, relay = relayRaw) {
      const { blob, ctype } = await relay('cloudflare', req, opts);
      return parseCloudflareImage(blob, ctype);
    },
    /** 문구만으로 그리기(FLUX.1 schnell 등) → Blob[]. 사진은 보내지 않는다 */
    async generate(o, opts, relay = relayRaw) {
      if (!CF_MODEL_RE.test(o.model)) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
      const body = new Blob([JSON.stringify({ prompt: String(o.prompt || '').slice(0, 2000) })], { type: 'application/json' });
      const { blob, ctype } = await relay('cloudflare', { method: 'POST', path: `/accounts/{account}/ai/run/${o.model}`, contentType: 'application/json', body }, opts);
      return parseCloudflareImage(blob, ctype);
    },
    privacyText: (host) => t(`입력한 문구(한국어는 영어로 번역해 보낼 수 있어요)가 ${host}(Workers AI) 로 전송돼요. 사진은 보내지 않아요. 하루 무료 한도를 넘으면 요청이 거부돼요.`, `Your prompt (Korean can be translated to English first) is sent to ${host} (Workers AI). No photo is sent. Requests are refused once the daily free allowance is used up.`),
  },

  pollinations: {
    id: 'pollinations', short: 'Pollinations', free: true, noKey: true, genOnly: true, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_PLN,
    name: () => t('Pollinations.ai (키 없이 무료)', 'Pollinations.ai (free, no key)'),
    tag: () => t('키 없이 무료', 'Free, no key'),
    desc: () => t('가입도 키도 필요 없어요. 문구로 이미지를 만들어요(사진 편집은 못 해요 — "문구로 채우기"·"이미지 만들기"에 써요). 한 번에 한 장, 약 45초 간격으로만 만들 수 있고 결과에 작은 로고가 붙을 수 있어요. 영어 문구가 가장 잘 그려져요.', 'No signup or key needed. Creates images from a prompt (no photo editing — use it for "Fill from prompt" and "Create image"). One image at a time, about 45 seconds apart, and results may carry a small logo. English prompts work best.'),
    howto: () => t('설정할 것이 없어요. 문구가 주소(URL)에 담겨 전송되니 개인 정보는 적지 마세요.', 'Nothing to set up. Your prompt travels inside the URL, so do not write personal details.'),
    host: () => 'image.pollinations.ai',
    privacy: (host) => t(`입력한 문구가 ${host} 로 전송돼요(주소에 포함돼 서버 기록에 남을 수 있어요). 사진은 보내지 않아요. ${FREE_PRIVACY()}`, `Your prompt is sent to ${host} (inside the URL, so it may appear in server logs). No photo is sent. ${FREE_PRIVACY()}`),
    extra: null, modelPresets: [], fallbackModel: 'pollinations', autoModel: 'pollinations',
    /** 문구만으로 새 이미지 (GET /prompt/<문구>) → Blob[] */
    async generate(o, opts, relay = relayRaw) {
      const path = pollinationsPath(o.prompt, o.size, Math.floor(Math.random() * 2147483646));
      if (path.startsWith('/prompt/?')) throw new AiError({ code: 'no_image', status: 200, message: 'empty prompt' });
      try {
        const { blob } = await relay('pollinations', { method: 'GET', path }, opts);
        return [await ensureImageBlob(blob)];
      } catch (e) { throw pollinationsError(e); }
    },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요(주소에 포함돼 서버 기록에 남을 수 있어요). 사진은 보내지 않아요. 무료 서비스는 보낸 내용이 저장·공개될 수 있으니 민감한 문구는 피해 주세요. 한 번에 한 장, 약 45초 간격으로만 만들 수 있어요.`, `Your prompt is sent to ${host} (inside the URL, so it may appear in server logs). No photo is sent. Free services may store or publish submitted content, so avoid sensitive prompts. One image at a time, about 45 seconds apart.`),
  },

  modelscope: {
    id: 'modelscope', short: 'ModelScope', free: true, noKey: false, genOnly: true, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_FREE,
    name: () => t('ModelScope API-Inference (무료 체험)', 'ModelScope API-Inference (free trial)'),
    tag: () => t('무료 체험', 'Free trial'),
    desc: () => t('Alibaba ModelScope(魔搭)의 Qwen-Image 같은 이미지 모델을 무료 체험 한도로 써요. 문구로 이미지를 만들어요(사진 편집은 못 해요 — "문구로 채우기"·"이미지 만들기"에 써요). 만드는 데 보통 10~60초 걸려요.', 'Uses image models such as Qwen-Image from Alibaba ModelScope within the free trial allowance. Creates images from a prompt (no photo editing — use it for "Fill from prompt" and "Create image"). Usually takes 10–60 seconds.'),
    howto: () => t('modelscope.cn 에 가입하고 알리바바 클라우드 계정 인증을 마친 뒤, 계정 설정의 "액세스 토큰"에서 토큰을 만들어 붙여 넣어요. 무료 사용량은 모델·시기에 따라 달라요.', 'Sign up at modelscope.cn, finish the Alibaba Cloud account verification, then create a token under "Access tokens" in your account settings and paste it. The free allowance varies by model and time.'),
    host: () => 'api-inference.modelscope.cn',
    privacy: (host) => t(`입력한 문구가 ${host} 로 전송돼요. 만든 이미지는 알리바바 클라우드의 주소에서 내려받아요. 사진은 보내지 않아요. ${FREE_PRIVACY()}`, `Your prompt is sent to ${host}. The created image is downloaded from an Alibaba Cloud address. No photo is sent. ${FREE_PRIVACY()}`),
    extra: null, modelPresets: MS_MODELS, fallbackModel: MS_MODELS[0], autoModel: MS_MODELS[0],
    async test(info, opts) {
      try { await relayRaw('modelscope', { method: 'GET', path: '/models' }, opts); } catch (e) {
        if (e instanceof AiError && e.info && e.info.status === 404) return { kind: 'warn', text: t('토큰 확인용 주소를 찾지 못했어요. 이미지를 한 번 만들어 확인해 보세요.', 'Could not find the token-check address. Create one image to verify.') };
        throw e;
      }
      return { kind: 'ok', text: t('연결됐어요(토큰 확인). 사용할 모델: ', 'Connected (token verified). Model: ') + MS_MODELS[0], d: { list: MS_MODELS.slice(), best: MS_MODELS[0], free: [] } };
    },
    /** 문구만으로 새 이미지 (비동기 작업) → Blob[] */
    async generate(o, opts, relay = relayRaw) { return modelscopeGenerate(o, opts, relay); },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요. 만든 이미지는 알리바바 클라우드의 주소에서 내려받아요. 사진은 보내지 않아요. 무료/체험 서비스는 보낸 내용이 저장·개선에 쓰일 수 있어요.`, `Your prompt is sent to ${host}. The created image is downloaded from an Alibaba Cloud address. No photo is sent. Free/trial services may store or use submitted content.`),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const getProvider = (id) => PROVIDERS[id] || PROVIDERS.cloudflare;
