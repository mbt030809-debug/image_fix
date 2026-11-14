// AI 설정: API 키(기기 Keystore 에 암호화 저장) · 모델 · 서버 주소 · 연결 테스트 · 개인정보 안내
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { openModal, Segmented, Chips, Btn, toast } from '../ui/components.js';
import { bridge } from '../bridge.js';
import { DEFAULT_BASE, MODEL_AUTO, FALLBACK_MODEL, pickBestImageModel, listImageModels, cleanKey, explainError } from '../ai/openai.js';
import { listModelIds } from '../ai/client.js';

const AI_DEFAULTS = { model: MODEL_AUTO, custom: '', resolved: '', models: [], quality: 'medium', n: 1, ctx: 1, feather: 30, tone: true, consent: null };

/** 설정의 AI 항목(같은 객체를 계속 돌려준다 — 여러 곳에서 고쳐도 한 객체에 모이도록). 키 자체는 여기 없다(네이티브 Keystore) */
export function aiConfig(app) {
  const s = app.settings;
  if (!s.ai || typeof s.ai !== 'object') s.ai = {};
  for (const k of Object.keys(AI_DEFAULTS)) if (!(k in s.ai)) s.ai[k] = Array.isArray(AI_DEFAULTS[k]) ? [] : AI_DEFAULTS[k];
  return s.ai;
}

/** 현재 쓸 모델 id: 직접 지정 > 자동(키로 조회해 가장 새로운 gpt-image) > 기본값 */
export async function resolveModel(app) {
  const cfg = aiConfig(app);
  if (cfg.model !== MODEL_AUTO) return (cfg.custom || '').trim() || cfg.model || FALLBACK_MODEL;
  if (cfg.resolved) return cfg.resolved;
  try {
    const ids = await listModelIds();
    cfg.models = listImageModels(ids);
    cfg.resolved = pickBestImageModel(ids) || FALLBACK_MODEL;
    app.saveSettings();
  } catch (e) {
    if (e && e.info && (e.info.status === 401 || e.info.code === 'cancelled')) throw e;
    cfg.resolved = '';
    return FALLBACK_MODEL;
  }
  return cfg.resolved;
}

export function privacyNote(base) {
  let host = base || DEFAULT_BASE;
  try { host = new URL(host).host; } catch (e) { /* 그대로 */ }
  return t(`AI 수정을 쓰면 선택한 영역과 그 주변 이미지, 입력한 문구가 ${host} 로 전송돼요. 전체 사진은 보내지 않아요. 요금은 내 API 계정에 청구돼요. AI 수정을 쓰지 않으면 앱은 인터넷을 쓰지 않아요.`,
    `When you use AI edit, the selected area with its surroundings and your prompt are sent to ${host}. The full photo is not sent. Usage is billed to your own API account. If you don't use AI edit, the app never uses the internet.`);
}

/** 설정 모달. opts.onClose(): 닫힐 때 호출 */
export function openAiSettings(app, opts = {}) {
  const cfg = aiConfig(app);
  let info = bridge.ai.info();
  let testMsg = null, testing = false;
  let modal;
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  const keyInput = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'sk-…', 'aria-label': t('API 키', 'API key'), name: 'imagefix-ai-key' });
  const baseInput = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: DEFAULT_BASE, 'aria-label': t('서버 주소', 'Server address'), value: info && info.base && info.base !== DEFAULT_BASE ? info.base : '' });
  const customInput = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'gpt-image-…', 'aria-label': t('모델 이름', 'Model name'), value: cfg.custom || '' });

  const fail = { 'ERR:badbase': t('서버 주소가 올바르지 않아요. https:// 로 시작하는 공개 도메인만 쓸 수 있어요.', 'Invalid server address. Only public https:// domains are allowed.'), 'ERR:badkey': t('키 형식이 올바르지 않아요.', 'The key format is invalid.'), 'ERR:store': t('기기에 안전하게 저장하지 못했어요.', "Couldn't store the key securely on this device.") };
  function saveKey() {
    const raw = keyInput.value;
    const k = raw.trim() ? cleanKey(raw) : '';
    if (raw.trim() && !k) { toast(t('키 형식이 올바르지 않아요.', 'The key format is invalid.')); return; }
    const base = baseInput.value.trim();
    if (!k && !(info && info.hasKey)) { toast(t('API 키를 입력해 주세요.', 'Enter an API key.')); return; }
    const r = bridge.ai.setKey(k, base);
    if (r !== true) { toast(fail[r] || t('저장하지 못했어요.', "Couldn't save.")); return; }
    keyInput.value = '';
    cfg.resolved = ''; cfg.models = []; testMsg = null;
    app.saveSettings();
    info = bridge.ai.info();
    toast(k ? t('키를 안전하게 저장했어요', 'Key saved securely') : t('서버 주소를 바꿨어요', 'Server address updated'));
    render();
  }
  function clearKey() {
    bridge.ai.clearKey();
    cfg.resolved = ''; cfg.models = []; cfg.consent = null; testMsg = null;
    app.saveSettings();
    info = bridge.ai.info();
    toast(t('키를 삭제했어요', 'Key removed'));
    render();
  }
  async function test() {
    if (testing) return;
    testing = true; testMsg = { kind: 'wait', text: t('연결 확인 중…', 'Checking connection…') }; render();
    try {
      const ids = await listModelIds({ timeoutMs: 40000 });
      cfg.models = listImageModels(ids);
      cfg.resolved = pickBestImageModel(ids) || '';
      app.saveSettings();
      testMsg = cfg.models.length
        ? { kind: 'ok', text: t('연결됐어요. 사용 가능한 이미지 모델: ', 'Connected. Image models available: ') + cfg.models.join(', ') }
        : { kind: 'warn', text: t('연결은 됐지만 gpt-image 모델이 목록에 없어요. 조직 인증/권한을 확인하거나 모델 이름을 직접 지정해 보세요.', 'Connected, but no gpt-image model is listed. Check organization verification/permissions or set the model name manually.') };
    } catch (e) {
      testMsg = { kind: 'err', text: explainError(e && e.info ? e.info : { message: String(e && e.message) }).text };
    }
    testing = false; render();
  }

  function render() {
    body.replaceChildren();
    const hasKey = !!(info && info.hasKey);
    body.append(h('p', { class: 'sheet-note' }, privacyNote(info && info.base)));
    body.append(h('div', { class: 'kv' }, h('span', null, t('API 키', 'API key')), h('b', null, hasKey ? (info.hint || t('저장됨', 'Saved')) : t('없음', 'Not set'))));
    body.append(keyInput,
      h('div', { class: 'row wrap' }, Btn(hasKey ? t('키 바꾸기', 'Replace key') : t('키 저장', 'Save key'), 'tonal', saveKey, 'key-round'), hasKey ? Btn(t('키 삭제', 'Remove'), 'outlined', clearKey, 'trash-2') : null),
      h('p', { class: 'sheet-note' }, t('키는 이 기기의 안전한 저장소(Android Keystore)에 암호화돼 보관되고, 화면(웹) 쪽에서는 다시 읽을 수 없어요. OpenAI 사이트의 API keys 메뉴에서 발급할 수 있고, ChatGPT 구독과는 별개로 API 결제가 필요해요.', 'The key is encrypted in the Android Keystore and cannot be read back by the page. Create one in the API keys menu on the OpenAI site; API billing is separate from a ChatGPT subscription.')));

    body.append(h('div', { class: 'sheet-sec' }, t('모델', 'Model')));
    const seg = Segmented({ label: t('모델 선택 방식', 'Model selection'), items: [{ id: MODEL_AUTO, label: t('자동 (권장)', 'Auto (recommended)') }, { id: 'manual', label: t('직접 지정', 'Manual') }], value: cfg.model === MODEL_AUTO ? MODEL_AUTO : 'manual', onChange: (v) => { cfg.model = v === MODEL_AUTO ? MODEL_AUTO : (cfg.custom || cfg.models[0] || FALLBACK_MODEL); if (v !== MODEL_AUTO && !cfg.custom) cfg.custom = cfg.model; app.saveSettings(); render(); } });
    body.append(seg.el);
    if (cfg.model === MODEL_AUTO) {
      body.append(h('p', { class: 'sheet-note' }, t('내 키로 쓸 수 있는 가장 새로운 gpt-image 모델을 알아서 골라요.', 'Automatically picks the newest gpt-image model available to your key.') + (cfg.resolved ? ' ' + t('현재: ', 'Current: ') + cfg.resolved : '')));
    } else {
      if (cfg.models.length) body.append(Chips({ label: t('사용 가능한 모델', 'Available models'), items: cfg.models.map((m) => ({ id: m, label: m })), value: cfg.custom, wrap: true, onSelect: (id) => { cfg.custom = id; cfg.model = id; customInput.value = id; app.saveSettings(); } }).el);
      customInput.value = cfg.custom || '';
      body.append(customInput);
      customInput.onchange = () => { const v = customInput.value.trim().slice(0, 80); cfg.custom = v; cfg.model = v || MODEL_AUTO; app.saveSettings(); };
    }
    body.append(Btn(testing ? t('확인 중…', 'Checking…') : t('연결 테스트', 'Test connection'), 'outlined', test, 'shield-check'));
    if (testMsg) body.append(h('p', { class: 'ai-msg ' + testMsg.kind, role: 'status' }, testMsg.text));

    const det = h('details', { class: 'ai-adv' }, h('summary', null, t('고급: 서버 주소', 'Advanced: server address')),
      h('p', { class: 'sheet-note' }, t('OpenAI 호환 서버를 쓸 때만 바꿔요. 키가 이 서버로 전송돼요. https 공개 도메인만 허용돼요. 바꾼 뒤에는 “키 바꾸기”를 눌러 저장해요.', 'Change only for an OpenAI-compatible server. Your key is sent to it. Only public https domains are allowed. Press "Replace key" to save.')), baseInput);
    if (baseInput.value) det.open = true;
    body.append(det);
  }

  modal = openModal({ title: t('AI 설정', 'AI settings'), onClose: () => { opts.onClose && opts.onClose(); }, build: (b) => { b.append(body); render(); } });
  void icon; void modal;
  return modal;
}
