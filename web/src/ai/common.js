// AI 공통 도우미 — 순수 함수: multipart 본문, 오류 → 사용자 메시지, 붙여넣은 키 정리
import { t } from '../i18n.js';

/** 모델 선택이 "자동"임을 나타내는 값 (설정에 저장) */
export const MODEL_AUTO = 'auto';

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

/**
 * 네이티브/JS 오류 → 사용자 메시지. e: {status, code, type, message}
 * 반환 {key, text, settings?: true(설정을 열어 해결 가능)}
 */
export function explainError(e) {
  const status = Number(e && e.status) || 0;
  const code = String((e && e.code) || '');
  const msg = String((e && e.message) || '');
  const both = code + ' ' + msg;
  const raw = msg ? msg.slice(0, 160) : '';
  const hasCode = (n) => new RegExp('(?:^|\\D)' + n + '(?:\\D|$)').test(both); // cf_3036 처럼 숫자 앞이 밑줄이어도 찾는다
  if (code === 'cancelled') return { key: 'cancelled', text: t('취소했어요.', 'Cancelled.') };
  if (code === 'timeout') return { key: 'timeout', text: t('응답이 너무 오래 걸려서 중단했어요. 잠시 뒤에 다시 시도해 보세요.', 'The request took too long and was stopped. Try again in a moment.') };
  if (code === 'tls') return { key: 'tls', text: t('보안 연결(TLS)에 실패했어요. 기기 시간·네트워크를 확인해 주세요.', 'Secure connection (TLS) failed. Check the device clock and network.') };
  if (code === 'offline' || code === 'network' || (status === 0 && !code)) return { key: 'offline', text: t('인터넷에 연결할 수 없어요. 연결을 확인한 뒤 다시 시도해 주세요.', "Can't reach the internet. Check your connection and try again.") };
  if (code === 'no_account') return { key: 'account', settings: true, text: t('Cloudflare 계정 ID가 필요해요. 설정에서 계정 ID를 입력해 주세요.', 'A Cloudflare account ID is required. Enter it in settings.') };
  if (code === 'no_key') return { key: 'key', settings: true, text: t('API 키를 먼저 설정해 주세요.', 'Set an API key first.') };
  if (code === 'key_unreadable') return { key: 'keyread', settings: true, text: t('저장된 키를 읽지 못했어요(기기 보안 저장소 문제). 설정에서 키를 다시 저장해 주세요.', "Couldn't read the stored key (device secure storage problem). Save the key again in settings.") };
  if (code === 'task_failed') return { key: 'taskfail', text: t('ModelScope 가 이미지를 만들지 못했어요. 다른 문구나 다른 모델로 다시 시도해 보세요.', 'ModelScope could not create the image. Try different wording or another model.') + (raw ? ` (${raw})` : '') };
  if (code === 'no_task') return { key: 'notask', text: t('ModelScope 가 작업 번호를 돌려주지 않았어요. 토큰과 모델 이름을 확인한 뒤 다시 시도해 주세요.', 'ModelScope returned no task id. Check the token and model name and try again.') };
  if (code === 'no_image') return { key: 'noimage', text: t('이미지를 받지 못했어요. 다른 문구로 다시 시도하거나 설정에서 다른 모델·제공자를 골라 보세요.', 'No image came back. Try different wording or pick another model/provider in settings.') + (raw ? ` (${raw})` : '') };
  if (/gated|access to model .{0,80}restricted|accept.{0,30}(terms|license|conditions)/i.test(both)) return { key: 'gated', settings: true, text: t('이 모델은 이용 약관 동의가 필요해요. Hugging Face 의 FLUX.1-Fill-dev 모델 페이지에서 “Access repository” 로 동의한 뒤 다시 시도해 주세요.', 'This model needs you to accept its terms. Accept them with "Access repository" on the FLUX.1-Fill-dev model page on Hugging Face, then try again.') };
  if (/moderation|content_policy|safety|flagged/i.test(both)) return { key: 'policy', text: t('AI가 안전 정책 때문에 요청을 거부했어요. 문구나 선택 영역을 바꿔 보세요.', 'The AI declined this request under its safety policy. Change the wording or the area.') };
  if (/daily free allocation|free-models-per-day/i.test(both) || hasCode(3036) || (status === 429 && /free/i.test(both))) return { key: 'freequota', text: t('오늘의 무료 사용량을 모두 썼어요. 내일 다시 시도하거나(Cloudflare는 UTC 자정에 초기화) 다른 제공자를 써 보세요.', "You've used today's free allowance. Try again tomorrow (Cloudflare resets at 00:00 UTC) or use another provider.") };
  if ((hasCode(5035) || /workers paid|requires? a paid|upgrade to/i.test(both)) && status !== 429) return { key: 'paidplan', settings: true, text: t('이 모델은 유료 플랜(Cloudflare Workers Paid)이 필요해요. 설정에서 다른 모델(예: flux-2-klein-4b)을 고르거나 다른 제공자를 써 보세요.', 'This model needs a paid plan (Cloudflare Workers Paid). Pick another model (e.g. flux-2-klein-4b) in settings or use another provider.') };
  if (hasCode(3040) || /out of capacity/i.test(both)) return { key: 'capacity', text: t('지금 서버 처리 용량이 부족해요. 잠시 뒤에 다시 시도해 주세요.', 'The service is out of capacity right now. Try again shortly.') };
  if (status === 401) return { key: 'key', settings: true, text: t('API 키(토큰)가 올바르지 않아요. 설정에서 다시 입력해 주세요.', 'The API key (token) is invalid. Re-enter it in settings.') };
  if (status === 402) return { key: 'quota', settings: true, text: t('크레딧/결제가 필요한 모델이에요. 무료 모델이나 다른 제공자로 바꿔 보세요.', 'This model needs credits/billing. Switch to a free model or another provider.') };
  if (status === 403) return { key: 'forbidden', settings: true, text: t('이 키로는 이 기능을 쓸 수 없어요(권한/지역 제한). 키·토큰 권한(Workers AI 등)이나 계정 연동 상태를 확인해 주세요.', "This key can't use this feature (permission or region). Check the key/token permissions (e.g. Workers AI) or account linking.") };
  if (status === 404 || /not a valid model|no endpoints found|model.{0,20}not (found|supported)|unknown model/i.test(both)) return { key: 'model', settings: true, text: t('모델을 찾을 수 없어요. 설정에서 모델을 “자동”으로 두거나 다른 모델을 골라 주세요.', 'Model not found. Set the model to Auto or choose another in settings.') };
  if (status === 429 && /quota|billing|credit/i.test(both)) return { key: 'quota', text: t('사용 한도가 부족해요. 잠시 뒤에 다시 시도하거나 다른 제공자를 써 보세요.', 'Usage limit reached. Try again later or use another provider.') };
  if (status === 429) return { key: 'rate', text: t('요청이 너무 많아요. 잠시 뒤에 다시 시도해 주세요.', 'Too many requests. Try again shortly.') };
  if (status >= 500) return { key: 'server', text: t('AI 서버에 일시적인 문제가 있어요. 잠시 뒤에 다시 시도해 주세요.', 'The AI server had a temporary problem. Try again shortly.') };
  if (code === 'bad_response') return { key: 'bad', text: t('AI 응답을 읽지 못했어요. 다시 시도해 주세요.', "Couldn't read the AI response. Please try again.") };
  return { key: 'other', text: t('AI 요청에 실패했어요', 'AI request failed') + (raw ? ` (${status || code}: ${raw})` : status ? ` (${status})` : '') };
}

/**
 * 붙여넣은 키 정리: "Bearer xxx"/"Authorization: Bearer xxx" 통째로, 공백·줄바꿈·보이지 않는 문자, 앞뒤 따옴표·쉼표를 걷어 낸다.
 * 형식을 강제하지는 않는다 — 보이는 ASCII 8~400자만 확인. 아니면 ''
 */
export function cleanKey(s) {
  let k = String(s || '').replace(/^\s*(?:authorization\s*:\s*)?bearer\s+/i, '');
  k = k.replace(/[\s\u200b-\u200f\u2028\u2029\u2060\ufeff]+/g, '');
  k = k.replace(/^["'`“”‘’]+|["'`“”‘’,;]+$/g, '');
  return k.length >= 8 && k.length <= 400 && /^[\x21-\x7e]+$/.test(k) ? k : '';
}
