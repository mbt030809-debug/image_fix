// AI 제공자 레지스트리 — 제공자마다 요청 만들기 · 응답 읽기 · 모델 찾기가 다르다.
//  openai     : POST /images/edits — 진짜 마스크 편집(투명 = 편집 영역). 유료.
//  openrouter : POST /chat/completions — 이미지를 내놓는 LLM(마스크 없음 → "표시 이미지"로 위치를 알려 줌). ":free" 무료 모델을 자동으로 찾는다.
//  cloudflare : POST /accounts/{account}/ai/run/@cf/… — Workers AI FLUX.2 편집(마스크 없음 → 표시 이미지). 하루 무료 한도.
// 어느 제공자든 결과는 "선택 안쪽에만" 합성하므로, 마스크가 없는 모델이 다른 곳을 바꿔도 사진 나머지는 그대로다.
import { t } from '../i18n.js';
import { DEFAULT_BASE, FALLBACK_MODEL, buildEditRequest, buildMultipart, pickBestImageModel, listImageModels } from './openai.js';
import { AiError, editImages, relayRaw, listModelIds } from './client.js';
import { SIZES } from './plan.js';

// ------------------------------------------------------------ 바이너리 도우미 (브라우저/Node 공용)
export async function blobToBase64(blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

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

/** data:image/png;base64,… → Blob (base64 가 아니면 null) */
export function dataUrlToBlob(url) {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null;
  const i = url.indexOf(',');
  if (i < 0) return null;
  const head = url.slice(5, i);
  if (!/;base64$/i.test(head)) return null;
  return base64ToBlob(url.slice(i + 1), head.replace(/;base64$/i, ''));
}

const dataUrl = async (blob) => `data:${blob.type || 'image/png'};base64,${await blobToBase64(blob)}`;

// ------------------------------------------------------------ 크기 클래스
const withAr = (list) => list.map((s) => ({ ...s, ar: s.w / s.h, str: `${s.w}x${s.h}` }));
/** 지시형(마스크 없는) 모델: 1024 안팎 */
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

// ------------------------------------------------------------ OpenRouter
/** 응답 JSON 에서 이미지 Blob 들을 꺼낸다 (message.images[] → content[] 파트 → 마크다운 data URL 순) */
export function extractOpenRouterImages(json) {
  const out = [];
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!msg) return out;
  const push = (u) => { const b = dataUrlToBlob(u); if (b) out.push(b); };
  for (const im of msg.images || []) push(im && (im.image_url ? (im.image_url.url || im.image_url) : im.url));
  if (!out.length && Array.isArray(msg.content)) for (const part of msg.content) if (part && part.image_url) push(part.image_url.url || part.image_url);
  if (!out.length && typeof msg.content === 'string') { const m = /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/.exec(msg.content); if (m) push(m[0]); }
  return out;
}

/** 모델 목록 → 이미지를 내놓는 모델만 [{id,name,created,free,edit}] (새것 먼저). 무료 = ":free" 이거나 가격이 전부 0 */
export function parseOpenRouterModels(json) {
  const out = [];
  for (const m of (json && json.data) || []) {
    if (!m || typeof m.id !== 'string') continue;
    const arch = m.architecture || {};
    const outs = arch.output_modalities || [], ins = arch.input_modalities || [];
    if (!outs.includes('image')) continue;
    const pr = m.pricing || {};
    const z = (v) => v == null || Number(v) === 0;
    const free = /:free$/.test(m.id) || (pr.prompt != null && pr.completion != null && z(pr.prompt) && z(pr.completion) && z(pr.image) && z(pr.request));
    out.push({ id: m.id, name: m.name || m.id, created: Number(m.created) || 0, free, edit: ins.includes('image'), outs: outs.slice() });
  }
  out.sort((a, b) => b.created - a.created);
  return out;
}

/** 가장 새로운 "무료 + 이미지 입력(편집 가능)" 모델 id, 없으면 null */
export function pickFreeImageModel(list) {
  const f = (list || []).find((m) => m.free && m.edit);
  return f ? f.id : null;
}

/** UI 목록: 무료 편집 모델 → 유료 편집 모델(최대 40) */
export function orderOpenRouterModels(list) {
  const edit = (list || []).filter((m) => m.edit);
  const ordered = edit.filter((m) => m.free).concat(edit.filter((m) => !m.free)).slice(0, 40);
  // meta: 모델별 출력 형식(이미지만 내는 모델에 text 를 요청하면 거부될 수 있어서 요청마다 맞춘다)
  return { ids: ordered.map((m) => m.id), free: edit.filter((m) => m.free).map((m) => m.id), meta: Object.fromEntries(ordered.map((m) => [m.id, m.outs])) };
}

// ------------------------------------------------------------ Cloudflare
/** Cloudflare 계정 ID(32자리 16진수). 대시보드 주소·"Account ID: …" 처럼 앞뒤에 글자가 붙은 채 붙여넣어도 32자리를 찾아 돌려준다. 없으면 '' */
export function parseAccountId(v) {
  const m = /(?:^|[^0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])/.exec(String(v || ''));
  return m ? m[1].toLowerCase() : '';
}

export const CF_MODELS = ['@cf/black-forest-labs/flux-2-klein-4b', '@cf/black-forest-labs/flux-2-klein-9b', '@cf/black-forest-labs/flux-2-dev'];
export const CF_MODEL_RE = /^@cf\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

// ------------------------------------------------------------ 문구만으로 그리는 모델(생성 전용) — 사진을 보지 못한다
/** 유튜브에서 가장 많이 소개되는 무료 모델(FLUX.1 schnell, Cloudflare Workers AI). 입력은 문구뿐이라 사진을 보내지 않는다 */
export const CF_GENERATE_MODELS = ['@cf/black-forest-labs/flux-1-schnell'];
export const isCfGenerateModel = (m) => /flux-1-schnell|stable-diffusion-xl|dreamshaper|sdxl-lightning/i.test(String(m || ''));

/** 모델별 동작: edit = 사진을 보고 고침 / generate = 문구만으로 그림(선택 안쪽을 새 그림으로 채움, 사진 미전송) */
export function modelProfile(pid, model) {
  const P = PROVIDERS[pid] || PROVIDERS.openai;
  if (pid === 'cloudflare' && isCfGenerateModel(model)) return { mode: 'generate', usesMask: false, sizes: SIZES_FREE, noPhoto: true };
  return { mode: 'edit', usesMask: P.usesMask, sizes: P.sizes, noPhoto: false };
}

const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
export const hasHangul = (s) => HANGUL.test(String(s || ''));

/**
 * 한국어 문구 → 영어 (Cloudflare m2m100, 무료). FLUX 같은 모델은 영어 문구에서 훨씬 잘 그린다.
 * 실패하면 원문 그대로 진행(best-effort). relay 는 테스트용으로 바꿀 수 있다.
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

// ------------------------------------------------------------ 레지스트리
const hostOf = (u, d) => { try { return new URL(u || d).host; } catch (e) { return d; } };

const COMMON_PRIVACY = () => t('전체 사진은 보내지 않아요.', 'The full photo is not sent.');
const FREE_PRIVACY = () => t('무료/체험 서비스는 제공사 정책에 따라 보낸 내용이 저장·개선에 쓰일 수 있어요. 민감한 사진은 피해 주세요.', 'Free/trial services may store or use submitted content under the provider\'s policy. Avoid sensitive photos.');

export const PROVIDERS = {
  openai: {
    id: 'openai', short: 'OpenAI', free: false, usesMask: true, maxN: 3, hasQuality: true, sizes: SIZES,
    name: () => 'OpenAI (GPT Image)',
    tag: () => t('유료', 'Paid'),
    desc: () => t('마스크로 선택 영역만 정확히 편집하는 가장 정석적인 방식이에요. API 결제가 필요해요.', 'The most precise option: true mask editing of just your selection. Requires paid API billing.'),
    howto: () => t('OpenAI 사이트의 API keys 메뉴에서 키를 발급해요. ChatGPT 구독과는 별개로 API 결제가 필요하고, 모델에 따라 조직 인증이 필요할 수 있어요.', 'Create a key in the API keys menu on the OpenAI site. API billing is separate from a ChatGPT subscription, and some models need organization verification.'),
    host: (info) => hostOf(info && info.base, 'api.openai.com'),
    privacy: (host) => t(`선택한 영역과 그 주변 이미지, 입력한 문구가 ${host} 로 전송돼요. ${COMMON_PRIVACY()} 요금은 내 API 계정에 청구돼요.`, `The selected area with its surroundings and your prompt are sent to ${host}. ${COMMON_PRIVACY()} Usage is billed to your own API account.`),
    defaultBase: DEFAULT_BASE, customBase: true, extra: null, modelPresets: [], fallbackModel: FALLBACK_MODEL, autoModel: null,
    async discover(opts) { const ids = await listModelIds(opts); return { list: listImageModels(ids), best: pickBestImageModel(ids), free: [] }; },
    async test(info, opts) {
      const d = await this.discover(opts);
      return d.list.length
        ? { kind: 'ok', text: t('연결됐어요. 사용 가능한 이미지 모델: ', 'Connected. Image models available: ') + d.list.join(', '), d }
        : { kind: 'warn', text: t('연결은 됐지만 gpt-image 모델이 목록에 없어요. 조직 인증/권한을 확인하거나 모델 이름을 직접 지정해 보세요.', 'Connected, but no gpt-image model is listed. Check organization verification/permissions or set the model name manually.'), d };
    },
    async buildEdit(o, imgs) { return buildEditRequest({ model: o.model, prompt: o.prompt, size: o.size.str, quality: o.quality, n: o.n }, imgs.image, imgs.mask); },
    async edit(req, opts) { return editImages('openai', req, opts); },
    /** 문구만으로 새 이미지 (POST /images/generations) → Blob[] */
    async generate(o, opts) {
      const body = JSON.stringify({ model: o.model, prompt: String(o.prompt || '').slice(0, 4000), size: (o.size && o.size.str) || '1024x1024', quality: o.quality || 'medium', n: 1 });
      return editImages('openai', { method: 'POST', path: '/images/generations', contentType: 'application/json', body: new Blob([body], { type: 'application/json' }) }, opts);
    },
    privacyText: (host) => t(`입력한 문구가 ${host} 로 전송돼요. 사진은 보내지 않아요. 요금은 내 API 계정에 청구돼요.`, `Your prompt is sent to ${host}. No photo is sent. Usage is billed to your own API account.`),
  },

  openrouter: {
    id: 'openrouter', short: 'OpenRouter', free: true, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_FREE,
    name: () => t('OpenRouter (무료 모델)', 'OpenRouter (free models)'),
    tag: () => t('무료 모델', 'Free models'),
    desc: () => t('이미지를 만들어 내는 LLM을 한 키로 골라 써요. ":free" 모델은 카드 없이 쓸 수 있고(일일 한도), 앱이 지금 쓸 수 있는 무료 이미지 편집 모델을 자동으로 찾아요.', 'Pick image-generating LLMs with one key. ":free" models need no card (daily limits) and the app finds a currently available free image-editing model automatically.'),
    howto: () => t('openrouter.ai 에 무료로 가입한 뒤 Keys 메뉴에서 키(sk-or-…)를 만들어 붙여 넣어요. 무료 모델은 모델마다 하루 요청 수 제한이 있고, 목록은 수시로 바뀌어요.', 'Sign up free at openrouter.ai, create a key (sk-or-…) in Keys and paste it. Free models have daily request limits and the list changes often.'),
    host: () => 'openrouter.ai',
    privacy: (host) => t(`선택한 영역과 그 주변 이미지, 입력한 문구가 ${host} 를 거쳐 모델 제공사로 전송돼요. ${COMMON_PRIVACY()} ${FREE_PRIVACY()}`, `The selected area with its surroundings and your prompt are sent via ${host} to the model provider. ${COMMON_PRIVACY()} ${FREE_PRIVACY()}`),
    defaultBase: 'https://openrouter.ai/api/v1', customBase: false, extra: null, modelPresets: [], fallbackModel: '', autoModel: null,
    async discover(opts) {
      const { blob } = await relayRaw('openrouter', { method: 'GET', path: '/models' }, opts);
      let json; try { json = JSON.parse(await blob.text()); } catch (e) { throw new AiError({ code: 'bad_response', status: 200, message: 'models not json' }); }
      const list = parseOpenRouterModels(json), o = orderOpenRouterModels(list);
      return { list: o.ids, best: pickFreeImageModel(list), free: o.free, meta: o.meta };
    },
    async test(info, opts) {
      try { await relayRaw('openrouter', { method: 'GET', path: '/key' }, opts); } catch (e) { if (!(e instanceof AiError) || e.info.status !== 404) throw e; }
      const d = await this.discover(opts);
      if (d.free.length) return { kind: 'ok', text: t('연결됐어요. 지금 쓸 수 있는 무료 이미지 편집 모델: ', 'Connected. Free image-editing models available now: ') + d.free.slice(0, 6).join(', '), d };
      return { kind: 'warn', text: t('연결은 됐지만 지금은 무료 이미지 편집 모델이 목록에 없어요. 유료 모델을 직접 고르거나 Cloudflare 를 써 보세요.', 'Connected, but no free image-editing model is listed right now. Pick a paid model or try Cloudflare.'), d };
    },
    async buildEdit(o, imgs) {
      const content = [{ type: 'text', text: instruct(o.prompt) }, { type: 'image_url', image_url: { url: await dataUrl(imgs.image) } }, { type: 'image_url', image_url: { url: await dataUrl(imgs.marked) } }];
      const modalities = Array.isArray(o.outputs) && o.outputs.length && !o.outputs.includes('text') ? ['image'] : ['image', 'text']; // 이미지만 내는 모델은 ['image']
      const body = JSON.stringify({ model: o.model, messages: [{ role: 'user', content }], modalities, stream: false });
      return { method: 'POST', path: '/chat/completions', contentType: 'application/json', body: new Blob([body], { type: 'application/json' }) };
    },
    async edit(req, opts) {
      const { blob } = await relayRaw('openrouter', req, opts);
      let json;
      try { json = JSON.parse(await blob.text()); } catch (e) { throw new AiError({ code: 'bad_response', status: 200, message: 'not json' }); }
      if (json && json.error) { const c = json.error.code; throw new AiError({ status: Number(c) || 200, code: c != null ? String(c) : 'bad_response', message: String(json.error.message || '') }); }
      const imgs = extractOpenRouterImages(json);
      if (!imgs.length) {
        const m = json && json.choices && json.choices[0] && json.choices[0].message;
        throw new AiError({ code: 'no_image', status: 200, message: typeof (m && m.content) === 'string' ? m.content.slice(0, 120) : '' });
      }
      return imgs;
    },
  },

  cloudflare: {
    id: 'cloudflare', short: 'Cloudflare', free: true, usesMask: false, maxN: 1, hasQuality: false, sizes: SIZES_CF,
    name: () => t('Cloudflare Workers AI (하루 무료)', 'Cloudflare Workers AI (daily free)'),
    tag: () => t('하루 무료', 'Daily free'),
    desc: () => t('FLUX.2 이미지 편집 모델을 무료 계정의 하루 무료 한도 안에서 써요(카드 불필요). 결제 없이 꾸준히 쓸 수 있는 방식이에요.', 'Uses FLUX.2 image-editing models within the free daily allowance of a free account (no card). A steady option without billing.'),
    howto: () => t('dash.cloudflare.com 에 무료로 가입한 뒤, 계정 ID(대시보드 주소의 32자리 값)와 API 토큰(My Profile → API Tokens → Create Token → “Workers AI” 템플릿)을 입력해요.', 'Sign up free at dash.cloudflare.com, then enter your account ID (the 32-character value in the dashboard URL) and an API token (My Profile → API Tokens → Create Token → "Workers AI" template).'),
    host: () => 'api.cloudflare.com',
    privacy: (host) => t(`선택한 영역과 그 주변 이미지, 입력한 문구가 ${host}(Workers AI) 로 전송돼요. ${COMMON_PRIVACY()} 하루 무료 한도를 넘으면 요청이 거부돼요.`, `The selected area with its surroundings and your prompt are sent to ${host} (Workers AI). ${COMMON_PRIVACY()} Requests are refused once the daily free allowance is used up.`),
    defaultBase: 'https://api.cloudflare.com/client/v4', customBase: false,
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
    async edit(req, opts) {
      const { blob, ctype } = await relayRaw('cloudflare', req, opts);
      return parseCloudflareImage(blob, ctype);
    },
    /** 문구만으로 그리기(FLUX.1 schnell 등) → Blob[]. 사진은 보내지 않는다 */
    async generate(o, opts) {
      if (!CF_MODEL_RE.test(o.model)) throw new AiError({ status: 404, code: 'model_not_found', message: 'invalid model name' });
      const body = new Blob([JSON.stringify({ prompt: String(o.prompt || '').slice(0, 2000) })], { type: 'application/json' });
      const { blob, ctype } = await relayRaw('cloudflare', { method: 'POST', path: `/accounts/{account}/ai/run/${o.model}`, contentType: 'application/json', body }, opts);
      return parseCloudflareImage(blob, ctype);
    },
    privacyText: (host) => t(`입력한 문구(한국어는 영어로 번역해 보낼 수 있어요)가 ${host}(Workers AI) 로 전송돼요. 사진은 보내지 않아요. 하루 무료 한도를 넘으면 요청이 거부돼요.`, `Your prompt (Korean can be translated to English first) is sent to ${host} (Workers AI). No photo is sent. Requests are refused once the daily free allowance is used up.`),
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);
export const getProvider = (id) => PROVIDERS[id] || PROVIDERS.openai;
