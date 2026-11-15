// AI 제공자 레지스트리 — 제공자마다 요청 만들기 · 응답 읽기가 다르다.
//  cloudflare  : POST /accounts/{account}/ai/run/@cf/… — Workers AI. FLUX.2 사진 편집(마스크 없음 → "표시 이미지") + FLUX.1 schnell 문구 생성 + 번역. 하루 무료 한도.
//  modelscope  : POST /images/generations(비동기) → GET /tasks/{id} 폴링 → 결과 주소 내려받기 — Qwen-Image-Edit 사진 편집(표시한 사진 1장 + 문구). 무료 체험 토큰.
//  gemini      : POST /models/<모델>:generateContent — 사진 편집(원본 + 표시 이미지) 또는 문구 생성. 사용자의 Gemini API 키.
//  fal         : POST fal.run/fal-ai/flux-lora-fill (fal.ai 직접, 동기) — FLUX.1 Fill [dev] 마스크 인페인팅(진짜 마스크). fal API 키.
// 어느 경우든 결과는 "선택 안쪽에만" 합성하므로, 모델이 다른 곳을 바꿔도 사진 나머지는 그대로다.
import { t } from '../i18n.js';
import { buildMultipart } from './common.js';
import { AiError, relayRaw } from './client.js';
import { blobToB64 } from '../bridge.js';

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
/** 1024 안팎 (Gemini · fal.ai FLUX.1 Fill · ModelScope Qwen-Image-Edit, Cloudflare 생성 모델) */
export const SIZES_FREE = withAr([{ w: 1024, h: 1024 }, { w: 1152, h: 768 }, { w: 768, h: 1152 }]);
/** Cloudflare FLUX.2: 입력 이미지는 "512×512 미만"(문서) → 480 이하로 보내고, 출력은 2배(width/height 로 지정, 16의 배수) */
export const SIZES_CF = withAr([{ w: 480, h: 480, out: { w: 960, h: 960 } }, { w: 480, h: 320, out: { w: 960, h: 640 } }, { w: 320, h: 480, out: { w: 640, h: 960 } }]);

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

/** (Gemini 는 pc.mode 로 edit/generate 선택, Cloudflare 는 모델로) 모델별 동작: edit = 사진을 보고 고침(Cloudflare FLUX.2) / generate = 문구만으로 그림(선택 안쪽을 새 그림으로 채움, 사진 미전송) */
export function modelProfile(pid, model, pc) {
  const P = PROVIDERS[pid] || PROVIDERS.cloudflare;
  if (pid === 'cloudflare' && isCfGenerateModel(model)) return { mode: 'generate', usesMask: false, sizes: SIZES_FREE, noPhoto: true };
  if (pid === 'gemini' && pc && pc.mode === 'generate') return { mode: 'generate', usesMask: false, sizes: P.sizes, noPhoto: true };
  return { mode: 'edit', usesMask: !!P.usesMask, maskKind: P.maskKind || 'alpha', sizes: P.sizes, noPhoto: false, oneImage: !!P.oneImage };
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


// ------------------------------------------------------------ 공통
const toDataUrl = async (blob, type = 'image/png') => `data:${type};base64,${await blobToB64(blob)}`;
/** data:image/…;base64,… → Blob (아니면 null) */
export function dataUrlToBlob(u) {
  const m = /^data:([A-Za-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(u || ''));
  return m ? base64ToBlob(m[2], m[1]) : null;
}
/** 사진 1장만 받는 모델용 지시: 표시된 곳만 바꾸라고 한다 */
export function instructOne(prompt) {
  const u = String(prompt || '').trim().slice(0, 1500);
  return 'You are a precise photo editor.\n'
    + 'The image has one area highlighted in magenta (tinted, with an outline). Change ONLY that highlighted area as requested below. Keep everything else exactly the same: same framing, composition, lighting, colors and aspect ratio. '
    + 'Return the complete edited image with no magenta highlight or outline.\n'
    + `Request: ${u}`;
}
const parseJsonBlob = async (blob) => { try { return JSON.parse(await blob.text()); } catch (e) { throw new AiError({ code: 'bad_response', status: 200, message: 'not json' }); } };

// ------------------------------------------------------------ ModelScope API-Inference (비동기 작업)
export const MS_MODELS = ['Qwen/Qwen-Image-Edit', 'Qwen/Qwen-Image-Edit-2509'];
export const MS_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const MS_TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{5,79}$/;
export const MS_EDIT_TASK = 'image-to-image-generation';

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
  return parseJsonBlob(blob);
}

/**
 * 작업 만들기(POST) → 끝날 때까지 상태 확인(GET, 3~4초 간격, 최대 pollTimeoutMs) → 결과 이미지 주소 내려받기.
 * o: {model, prompt, size?, image?(data URI — 있으면 편집: 작업 종류 image-to-image-generation)}, opts: {signal, onPhase, pollTimeoutMs}. relay/wait 는 테스트용.
 */
export async function modelscopeGenerate(o, opts = {}, relay = relayRaw, wait = sleepAbortable) {
  if (!MS_MODEL_RE.test(String(o.model || ''))) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
  const payload = { model: o.model, prompt: String(o.prompt || '').slice(0, 2000) };
  if (o.image) { payload.image_url = o.image; payload.image = o.image; } // 공개 주소만 받는 경우를 대비해 두 필드 모두(예제 코드가 둘 다 쓴다)
  else payload.size = (o.size && o.size.str) || '1024x1024';
  const tt = o.image ? MS_EDIT_TASK : undefined;
  const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const sub = await relayJson('modelscope', { method: 'POST', path: '/images/generations', contentType: 'application/json', body, tt }, opts, relay);
  let url = sub && Array.isArray(sub.images) && sub.images[0] && typeof sub.images[0].url === 'string' ? sub.images[0].url : '';
  if (!url) {
    const taskId = sub && (sub.task_id || sub.taskId);
    if (typeof taskId !== 'string' || !MS_TASK_RE.test(taskId)) throw new AiError({ code: 'no_task', status: 200, message: '' });
    const t0 = Date.now(), limit = opts.pollTimeoutMs || 300000;
    for (let i = 0; !url; i++) {
      await wait(i === 0 ? 3000 : 4000, opts.signal);
      const r = parseModelScopeTask(await relayJson('modelscope', { method: 'GET', path: `/tasks/${taskId}`, tt }, opts, relay));
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

// ------------------------------------------------------------ Gemini (generateContent)
export const GM_MODELS = ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview'];
export const GM_MODEL_RE = /^gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,50}$/;
const aspectOf = (size) => { const a = (size && size.ar) || 1; return a > 1.2 ? '3:2' : a < 0.83 ? '2:3' : '1:1'; };

/** generateContent 응답 → {b64, type} 또는 {b64:'', reason, blocked} (이미지 없이 글만 왔거나 안전 정책으로 막힘) */
export function parseGeminiImage(json) {
  const parts = [];
  for (const c of (json && Array.isArray(json.candidates) ? json.candidates : [])) for (const p of (c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [])) parts.push(p);
  const img = parts.map((p) => p && (p.inlineData || p.inline_data)).find((d) => d && typeof d.data === 'string' && d.data);
  if (img) return { b64: img.data, type: img.mimeType || img.mime_type || 'image/png' };
  const text = parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim();
  const block = json && json.promptFeedback && json.promptFeedback.blockReason;
  const fin = json && Array.isArray(json.candidates) && json.candidates[0] && json.candidates[0].finishReason;
  const blocked = !!block || /SAFETY|PROHIBITED|BLOCK/i.test(String(fin || ''));
  return { b64: '', blocked, reason: (block ? `blocked: ${block}` : (text || (fin && fin !== 'STOP' ? String(fin) : ''))).slice(0, 120) };
}
async function geminiImage(blob) {
  const r = parseGeminiImage(await parseJsonBlob(blob));
  if (!r.b64) throw new AiError({ code: r.blocked ? 'moderation_blocked' : 'no_image', status: 200, message: r.reason });
  return [await ensureImageBlob(base64ToBlob(r.b64, r.type))];
}
const gmPath = (model) => {
  if (!GM_MODEL_RE.test(String(model || ''))) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
  return `/models/${model}:generateContent`;
};
export function parseGeminiModels(json) {
  const arr = json && Array.isArray(json.models) ? json.models : [];
  return arr.map((m) => String((m && m.name) || '').replace(/^models\//, '')).filter((n) => GM_MODEL_RE.test(n) && /image/i.test(n));
}

// ------------------------------------------------------------ fal.ai · FLUX.1 Fill [dev] (fal.run 직접 호출)
export const FAL_MODEL = 'fal-ai/flux-lora-fill';
/** fal 응답 {images:[{url}]} 또는 {image:{url}} → 이미지 Blob (data URI 이거나 fal 주소) */
export async function parseFalImage(json, relay, opts) {
  const first = json && ((Array.isArray(json.images) && json.images[0]) || json.image);
  const u = first && (typeof first === 'string' ? first : first.url);
  if (typeof u !== 'string' || !u) throw new AiError({ code: 'no_image', status: 200, message: '' });
  if (u.startsWith('data:')) { const b = dataUrlToBlob(u); if (!b) throw new AiError({ code: 'no_image', status: 200, message: '' }); return ensureImageBlob(b); }
  if (opts && opts.onPhase) opts.onPhase('download');
  const { blob } = await relay('fal', { method: 'GET', url: u }, opts);
  return ensureImageBlob(blob);
}

// ------------------------------------------------------------ deAPI (OpenAI 호환 /images/edits)
export const DEAPI_MODELS = ['qwen-image-edit', 'flux-kontext-dev'];
export const DEAPI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,60}$/;
/** OpenAI 형식 이미지 응답 {data:[{b64_json|url}]} → 이미지 Blob (url 이면 허용된 도메인에서 내려받음). {error:{message}} 는 오류로 */
export async function parseOpenAiImage(json, relay, opts, provider) {
  const er = json && json.error;
  if (er) throw new AiError({ status: 200, code: String((typeof er === 'object' && (er.code || er.type)) || 'error'), message: String((typeof er === 'object' ? er.message : er) || '').slice(0, 160) });
  const d = json && Array.isArray(json.data) ? json.data[0] : null;
  if (d && typeof d.b64_json === 'string' && d.b64_json) return ensureImageBlob(base64ToBlob(d.b64_json, 'image/png'));
  if (d && typeof d.url === 'string' && d.url) {
    if (d.url.startsWith('data:')) { const b = dataUrlToBlob(d.url); if (b) return ensureImageBlob(b); }
    else { if (opts && opts.onPhase) opts.onPhase('download'); const { blob } = await relay(provider, { method: 'GET', url: d.url }, opts); return ensureImageBlob(blob); }
  }
  throw new AiError({ code: 'no_image', status: 200, message: '' });
}

// ------------------------------------------------------------ 레지스트리
const COMMON_PRIVACY = () => t('전체 사진은 보내지 않아요.', 'The full photo is not sent.');
const FREE_PRIVACY = () => t('무료/체험 서비스는 제공사 정책에 따라 보낸 내용이 저장·개선에 쓰일 수 있어요. 민감한 문구나 사진은 피해 주세요.', 'Free/trial services may store or use submitted content under the provider\'s policy. Avoid sensitive prompts or photos.');
const PHOTO_SENT = (host) => t(`선택한 영역과 그 주변 이미지, 입력한 문구가 ${host} 로 전송돼요. ${COMMON_PRIVACY()}`, `The selected area with its surroundings and your prompt are sent to ${host}. ${COMMON_PRIVACY()}`);

export const PROVIDERS = {
  cloudflare: {
    id: 'cloudflare', short: 'Cloudflare', free: true, noKey: false, genOnly: false, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_CF, canFill: true,
    name: () => t('Cloudflare Workers AI (하루 무료)', 'Cloudflare Workers AI (daily free)'),
    tag: () => t('하루 무료', 'Daily free'),
    desc: () => t('FLUX.2 이미지 편집 모델을 무료 계정의 하루 무료 한도 안에서 써요(카드 불필요). 문구로 새로 그리는 FLUX.1 schnell 과 한국어 → 영어 번역에도 써요.', 'Uses FLUX.2 image-editing models within the free daily allowance of a free account (no card). Also powers FLUX.1 schnell text-to-image and Korean → English translation.'),
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

  modelscope: {
    id: 'modelscope', short: 'ModelScope', free: true, noKey: false, genOnly: false, usesMask: false, oneImage: true, maxN: 1, hasQuality: false, sizes: SIZES_FREE,
    name: () => t('ModelScope · Qwen-Image-Edit (무료 체험)', 'ModelScope · Qwen-Image-Edit (free trial)'),
    tag: () => t('Qwen 편집 · 체험', 'Qwen edit · trial'),
    desc: () => t('Alibaba ModelScope(魔搭)의 Qwen-Image-Edit 로 사진을 고쳐요. 편집할 곳을 마젠타로 표시한 사진 1장과 문구를 보내요. 보통 10~60초 걸려요. (요청 형식은 공개 예제 기준이라 서버가 거부할 수 있어요 — 그 사유를 그대로 보여 줘요.)', 'Edits photos with Qwen-Image-Edit from Alibaba ModelScope. Sends one photo with the edit area marked in magenta plus your prompt. Usually takes 10–60 seconds. (The request format follows public examples, so the server may refuse it — the reason is shown as-is.)'),
    howto: () => t('modelscope.cn 에 가입하고 알리바바 클라우드 계정 인증을 마친 뒤, 계정 설정의 "액세스 토큰"에서 토큰을 만들어 붙여 넣어요. 무료 사용량은 모델·시기에 따라 달라요.', 'Sign up at modelscope.cn, finish the Alibaba Cloud account verification, then create a token under "Access tokens" in your account settings and paste it. The free allowance varies by model and time.'),
    host: () => 'api-inference.modelscope.cn',
    privacy: (host) => t(`표시를 넣은 선택 영역과 주변 이미지 1장(데이터 주소로 포함)과 입력한 문구가 ${host} 로 전송돼요. 만든 이미지는 알리바바 클라우드의 주소에서 내려받아요. ${COMMON_PRIVACY()} ${FREE_PRIVACY()}`, `One image of the selected area with its surroundings (marked in magenta, embedded as a data URL) and your prompt are sent to ${host}. The result is downloaded from an Alibaba Cloud address. ${COMMON_PRIVACY()} ${FREE_PRIVACY()}`),
    extra: null, modelPresets: MS_MODELS, fallbackModel: MS_MODELS[0], autoModel: MS_MODELS[0],
    async test(info, opts) {
      try { await relayRaw('modelscope', { method: 'GET', path: '/models' }, opts); } catch (e) {
        if (e instanceof AiError && e.info && e.info.status === 404) return { kind: 'warn', text: t('토큰 확인용 주소를 찾지 못했어요. 한 번 편집해 보며 확인해 주세요.', 'Could not find the token-check address. Try one edit to verify.') };
        throw e;
      }
      return { kind: 'ok', text: t('연결됐어요(토큰 확인). 사용할 모델: ', 'Connected (token verified). Model: ') + MS_MODELS[0], d: { list: MS_MODELS.slice(), best: MS_MODELS[0], free: [] } };
    },
    /** 표시한 사진 1장 + 문구 → 편집 요청 정보(작업 만들기 본문은 edit 에서 만든다) */
    async buildEdit(o, imgs) {
      if (!MS_MODEL_RE.test(String(o.model || ''))) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
      return { model: o.model, prompt: instructOne(o.prompt), image: await toDataUrl(imgs.marked) };
    },
    async edit(req, opts, relay = relayRaw) { return modelscopeGenerate(req, opts, relay); },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요.`, `Your prompt is sent to ${host}.`),
  },

  gemini: {
    id: 'gemini', short: 'Gemini', free: true, noKey: false, genOnly: false, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_FREE, canFill: true,
    name: () => t('Google Gemini (이미지 모델)', 'Google Gemini (image model)'),
    tag: () => t('내 API 키', 'Your API key'),
    desc: () => t('Gemini 이미지 모델(기본 gemini-2.5-flash-image, 일명 “나노 바나나”)로 사진을 고치거나 문구로 그려요. 내 Gemini API 키가 필요하고, 이미지 모델의 무료 한도는 계정·시기에 따라 달라요(없을 수도 있어요).', 'Edits photos or paints from a prompt with Gemini image models (default gemini-2.5-flash-image, a.k.a. "Nano Banana"). Needs your Gemini API key; the free allowance for image models depends on the account and time (it may be none).'),
    howto: () => t('aistudio.google.com 에서 “Get API key” 로 키(AIza…)를 만들어 붙여 넣어요. 무료 키로는 이미지 모델이 한도 0 으로 거부될 수 있어요(결제 설정 필요).', 'Create a key (AIza…) with "Get API key" at aistudio.google.com and paste it. A free key may be refused for image models with a zero quota (billing may be required).'),
    host: () => 'generativelanguage.googleapis.com',
    privacy: (host) => t(`${PHOTO_SENT(host)} 무료 사용 시 Google 이 보낸 내용을 제품 개선에 쓸 수 있어요.`, `${PHOTO_SENT(host)} On the free tier Google may use submitted content to improve its products.`),
    extra: null, modelPresets: GM_MODELS, fallbackModel: GM_MODELS[0], autoModel: GM_MODELS[0],
    async test(info, opts) {
      const { blob } = await relayRaw('gemini', { method: 'GET', path: '/models?pageSize=100' }, opts);
      let names = [];
      try { names = parseGeminiModels(JSON.parse(await blob.text())); } catch (e) { /* 목록을 못 읽어도 키는 맞다 */ }
      const list = names.length ? names : GM_MODELS.slice();
      return { kind: 'ok', text: t('연결됐어요(키 확인). 이미지 모델: ', 'Connected (key verified). Image models: ') + list.slice(0, 5).join(', '), d: { list, best: list[0], free: [] } };
    },
    /** 원본 크롭 + 표시한 크롭 + 지시문 → generateContent 본문 */
    async buildEdit(o, imgs) {
      const parts = [{ text: instruct(o.prompt) }, { inlineData: { mimeType: 'image/png', data: await blobToB64(imgs.image) } }, { inlineData: { mimeType: 'image/png', data: await blobToB64(imgs.marked) } }];
      const body = new Blob([JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })], { type: 'application/json' });
      return { method: 'POST', path: gmPath(o.model), contentType: 'application/json', body };
    },
    async edit(req, opts, relay = relayRaw) { const { blob } = await relay('gemini', req, opts); return geminiImage(blob); },
    /** 문구만으로 그리기 → Blob[] (사진 미전송). 비율은 가로/세로/정사각 중 가까운 것 */
    async generate(o, opts, relay = relayRaw) {
      const cfg = { responseModalities: ['TEXT', 'IMAGE'] };
      const ar = aspectOf(o.size);
      if (ar !== '1:1') cfg.imageConfig = { aspectRatio: ar };
      const body = new Blob([JSON.stringify({ contents: [{ role: 'user', parts: [{ text: String(o.prompt || '').slice(0, 2000) }] }], generationConfig: cfg })], { type: 'application/json' });
      const { blob } = await relay('gemini', { method: 'POST', path: gmPath(o.model), contentType: 'application/json', body }, opts);
      return geminiImage(blob);
    },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요. 사진은 보내지 않아요. 무료 사용 시 Google 이 보낸 내용을 제품 개선에 쓸 수 있어요.`, `Your prompt is sent to ${host}. No photo is sent. On the free tier Google may use submitted content to improve its products.`),
  },

  fal: {
    id: 'fal', short: 'fal.ai', free: false, noKey: false, genOnly: false, usesMask: true, maskKind: 'white', maxN: 1, hasQuality: false, sizes: SIZES_FREE,
    name: () => t('fal.ai · FLUX.1 Fill [dev] (마스크 인페인팅)', 'fal.ai · FLUX.1 Fill [dev] (mask inpainting)'),
    tag: () => t('진짜 마스크', 'Real mask'),
    desc: () => t('FLUX.1 Fill [dev] 는 선택 영역(마스크) 안쪽만 새로 그리는 인페인팅 전용 모델이에요. 선택 안쪽에 들어갈 “내용”을 영어로 설명하면 가장 잘 돼요(예: a clear blue sky). fal.ai 의 API(fal-ai/flux-lora-fill)를 직접 불러요 — 사용량만큼 fal 계정에 청구돼요(가입 시 체험 크레딧이 있을 수 있어요). 비상업 라이선스 모델이에요.', 'FLUX.1 Fill [dev] is an inpainting-only model that repaints just inside your selection (the mask). Describe what should appear there, in English (e.g. a clear blue sky). Calls the fal.ai API (fal-ai/flux-lora-fill) directly — usage is billed to your fal account (new accounts may get trial credit). Non-commercial license.'),
    howto: () => t('fal.ai 에 가입하고 대시보드의 Keys 에서 API Key 를 만들어 붙여 넣어요(형식: 아이디:비밀값).', 'Sign up at fal.ai, create an API key under Keys in the dashboard and paste it (format: id:secret).'),
    host: () => 'fal.run',
    privacy: (host) => t(`선택 영역과 주변 이미지, 마스크, 입력한 문구가 ${host}(fal.ai)로 전송돼요. ${COMMON_PRIVACY()} 사용량은 fal 계정에 청구돼요. 결과 이미지는 fal 주소에서 받을 수 있어요.`, `The selected area with its surroundings, the mask and your prompt are sent to ${host} (fal.ai). ${COMMON_PRIVACY()} Usage is billed to your fal account. The result may be downloaded from a fal address.`),
    extra: null, modelPresets: [], fallbackModel: FAL_MODEL, autoModel: FAL_MODEL,
    /** 원본 크롭 + 마스크(흰색 = 채울 곳) + 문구 → fal flux-lora-fill 본문 (결과는 data URI 로 받는다) */
    async buildEdit(o, imgs) {
      const payload = { prompt: String(o.prompt || '').trim().slice(0, 1500), image_url: await toDataUrl(imgs.image), mask_url: await toDataUrl(imgs.mask), sync_mode: true, output_format: 'png', num_inference_steps: 28, guidance_scale: 30 };
      return { method: 'POST', path: '/fal-ai/flux-lora-fill', contentType: 'application/json', body: new Blob([JSON.stringify(payload)], { type: 'application/json' }) };
    },
    async edit(req, opts, relay = relayRaw) {
      const { blob } = await relay('fal', req, opts);
      return [await parseFalImage(await parseJsonBlob(blob), relay, opts)];
    },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요.`, `Your prompt is sent to ${host}.`),
  },

  deapi: {
    id: 'deapi', short: 'deAPI', free: false, noKey: false, genOnly: false, usesMask: false, oneImage: true, maxN: 1, hasQuality: false, sizes: SIZES_FREE,
    name: () => t('deAPI · 이미지 편집 (OpenAI 호환)', 'deAPI · image edit (OpenAI-compatible)'),
    tag: () => t('내 API 키', 'Your API key'),
    desc: () => t('deapi.ai 의 이미지 편집(/v1/images/edits)으로 사진을 고쳐요. 편집할 곳을 마젠타로 표시한 사진 1장과 문구를 보내요(마스크는 지원하지 않아요). 모델 이름이 다르면 설정의 “직접 지정”에서 deAPI 가 제공하는 이름으로 바꿔 주세요. 요청 형식은 OpenAI 호환 규약 기준이라 서버가 거부하면 그 사유를 그대로 보여 줘요.', 'Edits photos with deapi.ai image editing (/v1/images/edits). Sends one photo with the edit area marked in magenta plus your prompt (masks are not supported). If the model name differs, set the name deAPI offers under Manual in settings. The request follows the OpenAI-compatible convention; if the server refuses it, its reason is shown as-is.'),
    howto: () => t('deapi.ai 에 가입해 대시보드에서 API 키를 만들어 붙여 넣어요. 사용량만큼 deAPI 계정에 청구될 수 있어요.', 'Sign up at deapi.ai and create an API key in the dashboard. Usage may be billed to your deAPI account.'),
    host: () => 'oai.deapi.ai',
    privacy: (host) => t(`표시를 넣은 선택 영역과 주변 이미지 1장과 입력한 문구가 ${host}(deAPI)로 전송돼요. ${COMMON_PRIVACY()} 사용량은 계정에 청구될 수 있어요.`, `One image of the selected area with its surroundings (marked in magenta) and your prompt are sent to ${host} (deAPI). ${COMMON_PRIVACY()} Usage may be billed to your account.`),
    extra: null, modelPresets: DEAPI_MODELS, fallbackModel: DEAPI_MODELS[0], autoModel: DEAPI_MODELS[0],
    async test(info, opts) {
      const { blob } = await relayRaw('deapi', { method: 'GET', path: '/models' }, opts);
      let ids = [];
      try { const j = JSON.parse(await blob.text()); ids = (Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : []).map((m) => String((m && (m.id || m.name)) || '')).filter(Boolean); } catch (e) { /* 목록을 못 읽어도 키는 통과 */ }
      const list = ids.length ? ids : DEAPI_MODELS.slice();
      return { kind: 'ok', text: t('연결됐어요(키 확인). 모델: ', 'Connected (key verified). Models: ') + list.slice(0, 8).join(', '), d: { list, best: list[0], free: [] } };
    },
    /** 표시한 사진 1장 + 문구 → multipart(model · prompt · image) */
    async buildEdit(o, imgs) {
      if (!DEAPI_MODEL_RE.test(String(o.model || ''))) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
      const mp = buildMultipart({ model: o.model, prompt: instructOne(o.prompt) }, [{ name: 'image', filename: 'image.png', type: 'image/png', blob: imgs.marked }]);
      return { method: 'POST', path: '/images/edits', contentType: mp.contentType, body: mp.body };
    },
    async edit(req, opts, relay = relayRaw) {
      const { blob } = await relay('deapi', req, opts);
      return [await parseOpenAiImage(await parseJsonBlob(blob), relay, opts, 'deapi')];
    },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요.`, `Your prompt is sent to ${host}.`),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const getProvider = (id) => PROVIDERS[id] || PROVIDERS.cloudflare;
