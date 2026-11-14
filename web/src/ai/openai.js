// OpenAI 이미지 편집 API(gpt-image 계열) 요청/응답 도우미 — 순수 함수
// 엔드포인트: POST {base}/images/edits (multipart: model, prompt, image, mask, size, quality, n) → data[].b64_json
//            GET  {base}/models (키 확인 + 사용 가능한 이미지 모델 조회)
import { t } from '../i18n.js';

export const DEFAULT_BASE = 'https://api.openai.com/v1';
export const MODEL_AUTO = 'auto';
export const FALLBACK_MODEL = 'gpt-image-1';

/** 키로 조회한 모델 목록에서 가장 새로운 gpt-image 모델을 고른다 (mini·날짜 스냅샷보다 본 모델 우선) */
export function pickBestImageModel(ids) {
  const cands = [];
  for (const id of ids || []) {
    const m = /^gpt-image-(\d+(?:\.\d+)*)(-mini)?(-\d{4}-\d{2}-\d{2})?$/.exec(String(id));
    if (!m) continue;
    cands.push({ id, ver: m[1].split('.').map(Number), mini: !!m[2], snap: !!m[3] });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const n = Math.max(a.ver.length, b.ver.length);
    for (let i = 0; i < n; i++) { const d = (b.ver[i] || 0) - (a.ver[i] || 0); if (d) return d; }
    if (a.mini !== b.mini) return a.mini ? 1 : -1;
    if (a.snap !== b.snap) return a.snap ? 1 : -1;
    return a.id.length - b.id.length;
  });
  return cands[0].id;
}

/** 목록에서 gpt-image 계열만, 새것 → 오래된 것 순 */
export function listImageModels(ids) {
  const out = [];
  for (const id of ids || []) if (/^gpt-image-/.test(String(id))) out.push(String(id));
  const rest = out.slice();
  const order = [];
  while (rest.length) { const b = pickBestImageModel(rest); if (!b) break; order.push(b); rest.splice(rest.indexOf(b), 1); }
  return order.concat(rest);
}

/** 사용자가 쓴 문구를 감싸서 "선택(마스크) 바깥은 그대로" 를 분명히 한다 */
export function wrapPrompt(user) {
  const u = String(user || '').trim().slice(0, 1500);
  return `${u}\n\nEdit only the masked (transparent) region of the image as described above. Keep everything outside the mask exactly unchanged. Match the surrounding lighting, perspective, color grading and texture so the result blends in seamlessly.`;
}

/** multipart/form-data 본문 (Blob). 값은 UTF-8, 파일은 Blob 그대로 */
export function buildMultipart(fields, files) {
  const boundary = '----ImageFix' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  for (const f of files) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`, f.blob, '\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

/** 편집 요청: opts {model, prompt, size, quality, n}, imageBlob/maskBlob = PNG */
export function buildEditRequest(opts, imageBlob, maskBlob) {
  const fields = { model: opts.model, prompt: wrapPrompt(opts.prompt), size: opts.size, quality: opts.quality, n: String(opts.n || 1) };
  const mp = buildMultipart(fields, [
    { name: 'image', filename: 'image.png', type: 'image/png', blob: imageBlob },
    { name: 'mask', filename: 'mask.png', type: 'image/png', blob: maskBlob },
  ]);
  return { method: 'POST', path: '/images/edits', contentType: mp.contentType, body: mp.body, fields };
}

export const QUALITIES = ['low', 'medium', 'high'];

/**
 * 네이티브/JS 오류 → 사용자 메시지. e: {status, code, type, message}
 * 반환 {key, text, settings?: true(설정을 열어 해결 가능)}
 */
export function explainError(e) {
  const status = Number(e && e.status) || 0;
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || '');
  const raw = msg ? msg.slice(0, 160) : '';
  if (code === 'cancelled') return { key: 'cancelled', text: t('취소했어요.', 'Cancelled.') };
  if (code === 'timeout') return { key: 'timeout', text: t('응답이 너무 오래 걸려서 중단했어요. 품질을 낮추거나 영역을 줄여 다시 시도해 보세요.', 'The request took too long and was stopped. Try a lower quality or a smaller area.') };
  if (code === 'tls') return { key: 'tls', text: t('보안 연결(TLS)에 실패했어요. 기기 시간·네트워크를 확인해 주세요.', 'Secure connection (TLS) failed. Check the device clock and network.') };
  if (code === 'offline' || code === 'network' || (status === 0 && !code)) return { key: 'offline', text: t('인터넷에 연결할 수 없어요. 연결을 확인한 뒤 다시 시도해 주세요.', "Can't reach the internet. Check your connection and try again.") };
  if (status === 401) return { key: 'key', settings: true, text: t('API 키가 올바르지 않아요. 설정에서 키를 다시 입력해 주세요.', 'The API key is invalid. Re-enter it in settings.') };
  if (status === 403 && /verif/i.test(msg)) return { key: 'verify', settings: true, text: t('이 모델은 OpenAI 조직 인증이 필요해요. OpenAI 설정에서 조직 인증(Verify Organization)을 마치거나, 설정에서 다른 모델을 골라 주세요.', 'This model requires OpenAI organization verification. Complete verification, or pick another model in settings.') };
  if (status === 403) return { key: 'forbidden', settings: true, text: t('이 키로는 이미지 편집을 쓸 수 없어요(권한/지역 제한). 키·프로젝트 권한을 확인해 주세요.', "This key can't use image editing (permission or region). Check the key and project access.") };
  if (status === 404) return { key: 'model', settings: true, text: t('모델을 찾을 수 없어요. 설정에서 모델을 “자동”으로 두거나 다른 모델을 골라 주세요.', 'Model not found. Set the model to Auto or choose another in settings.') };
  if (status === 429 && /quota|billing|credit/i.test(code + ' ' + msg)) return { key: 'quota', text: t('API 잔액/한도가 부족해요. OpenAI 결제(Billing) 상태를 확인해 주세요.', 'API credit/limit exhausted. Check your OpenAI billing.') };
  if (status === 429) return { key: 'rate', text: t('요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.', 'Too many requests. Try again shortly.') };
  if (/moderation|content_policy|safety/i.test(code + ' ' + msg)) return { key: 'policy', text: t('AI가 안전 정책 때문에 요청을 거부했어요. 문구나 선택 영역을 바꿔 보세요.', 'The AI declined this request under its safety policy. Change the wording or the area.') };
  if (status >= 500) return { key: 'server', text: t('AI 서버에 일시적인 문제가 있어요. 잠시 뒤에 다시 시도해 주세요.', 'The AI server had a temporary problem. Try again shortly.') };
  if (code === 'bad_response') return { key: 'bad', text: t('AI 응답을 읽지 못했어요. 다시 시도해 주세요.', "Couldn't read the AI response. Please try again.") };
  return { key: 'other', text: t('AI 요청에 실패했어요', 'AI request failed') + (raw ? ` (${status || code}: ${raw})` : status ? ` (${status})` : '') };
}

/** 키 문자열 가벼운 검증 (공백 제거). 형식을 강제하지는 않는다(호환 서버 키 허용) */
export function cleanKey(s) {
  const k = String(s || '').replace(/\s+/g, '');
  return k.length >= 8 && k.length <= 400 && /^[\x21-\x7e]+$/.test(k) ? k : '';
}
