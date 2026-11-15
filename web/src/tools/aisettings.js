// AI 설정: 제공자 선택(Cloudflare · ModelScope Qwen-Image-Edit · Gemini · Hugging Face FLUX.1 Fill) · API 키/토큰(기기 Keystore 에 암호화 저장) · 모델 · 연결 테스트 · 개인정보 안내
import { h } from '../ui/dom.js';
import { t } from '../i18n.js';
import { openModal, Segmented, Chips, Btn, toast, confirmDialog } from '../ui/components.js';
import { bridge } from '../bridge.js';
import { MODEL_AUTO, cleanKey, explainError } from '../ai/common.js';
import { PROVIDERS, PROVIDER_IDS, getProvider, isCfGenerateModel } from '../ai/providers.js';

const AI_DEFAULTS = { provider: 'cloudflare', ctx: 1, feather: 30, tone: true, translate: true };
const P_DEFAULTS = () => ({ model: MODEL_AUTO, custom: '', models: [], mode: 'edit' }); // mode: Gemini 의 편집/문구 채우기
const REMOVED = ['openai', 'openrouter', 'pollinations']; // 삭제된 제공자(OpenAI·OpenRouter 1.5.0, Pollinations 1.6.0)

/**
 * 설정의 AI 항목(같은 객체를 계속 돌려준다 — 여러 곳에서 고쳐도 한 객체에 모이도록). 키 자체는 여기 없다(네이티브 Keystore).
 * p[제공자] = 모델 선택/조회한 목록, consents[제공자] = 동의한 서버 호스트. 삭제된 제공자(OpenAI·OpenRouter)의 설정은 지운다.
 */
export function aiConfig(app) {
  const s = app.settings;
  if (!s.ai || typeof s.ai !== 'object') s.ai = {};
  const c = s.ai;
  if (!c.p || typeof c.p !== 'object') c.p = {};
  if (!c.consents || typeof c.consents !== 'object') c.consents = {};
  for (const id of REMOVED) { delete c.p[id]; delete c.consents[id]; delete c.consents[id + ':text']; }
  for (const k of ['consent', 'quality', 'n', 'model', 'custom', 'resolved', 'models']) delete c[k]; // 옛 버전 흔적
  for (const k of Object.keys(AI_DEFAULTS)) if (!(k in c)) c[k] = AI_DEFAULTS[k];
  if (!PROVIDERS[c.provider]) c.provider = AI_DEFAULTS.provider;
  if (c.genProvider && !PROVIDERS[c.genProvider]) delete c.genProvider;
  return c;
}

/** 제공자별 설정(모델 선택 등) */
export function pcfg(cfg, pid) {
  if (!cfg.p[pid]) cfg.p[pid] = P_DEFAULTS();
  const p = cfg.p[pid];
  for (const [k, v] of Object.entries(P_DEFAULTS())) if (!(k in p)) p[k] = v;
  return p;
}

export const providerInfo = (pid) => { const i = bridge.ai.info(); return (i && i.providers && i.providers[pid]) || null; };
/** 이 제공자를 바로 쓸 수 있나(키 + 필요한 부가 값) */
export function providerReady(pid) {
  const P = getProvider(pid);
  if (P.noKey) return true;
  const pi = providerInfo(pid);
  return !!(pi && pi.hasKey && pi.readable !== false && (!P.extra || pi.extra));
}

/** 현재 쓸 모델 id: 직접 지정 > 자동(제공자가 정함) */
export async function resolveModel(app, pid) {
  const cfg = aiConfig(app), pc = pcfg(cfg, pid), P = getProvider(pid);
  if (pc.model !== MODEL_AUTO) return (pc.custom || '').trim() || pc.model || P.fallbackModel;
  return P.autoModel || P.fallbackModel;
}

export function privacyNote(pid) {
  const P = getProvider(pid);
  const pi = providerInfo(pid);
  return P.privacy(P.host(pi)) + ' ' + t('AI 기능을 쓰지 않으면 앱은 인터넷을 쓰지 않아요.', 'If you never use AI features, the app never uses the internet.');
}

/**
 * 첫 전송 전 동의(제공자·종류별). textOnly = 사진 없이 문구만 보내는 경우(생성). 동의했으면(이미 했으면) true
 */
export async function ensureConsent(app, P, textOnly) {
  const cfg = aiConfig(app);
  const host = P.host(providerInfo(P.id));
  const key = textOnly ? P.id + ':text' : P.id;
  if (cfg.consents[key] === host) return true;
  const body = textOnly && P.privacyText ? P.privacyText(host) + ' ' + t('AI 기능을 쓰지 않으면 앱은 인터넷을 쓰지 않아요.', 'If you never use AI features, the app never uses the internet.') : privacyNote(P.id);
  const v = await confirmDialog({
    title: textOnly ? t('AI 서버로 문구를 보내요', 'Send your prompt to an AI server') : t('AI 서버로 사진 일부를 보내요', 'Send part of your photo to an AI server'),
    body, actions: [{ label: t('취소', 'Cancel'), value: 'no' }, { label: t('동의하고 계속', 'Agree & continue'), value: 'yes', kind: 'filled' }],
  });
  if (v !== 'yes') return false;
  cfg.consents[key] = host; app.saveSettings();
  return true;
}

/** 설정 모달. opts: {provider: 처음 보여줄 제공자, onClose()} */
export function openAiSettings(app, opts = {}) {
  const cfg = aiConfig(app);
  let pid = opts.provider && PROVIDERS[opts.provider] ? opts.provider : cfg.provider;
  let info = bridge.ai.info();
  let testMsg = null, testing = false;
  const pinfo = () => (info && info.providers && info.providers[pid]) || { hasKey: false, hint: '', extra: '' };
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  const keyInput = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'sk-…', 'aria-label': t('API 키', 'API key'), name: 'imagefix-ai-key' });
  const extraInput = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('계정 ID', 'Account ID'), name: 'imagefix-ai-account' });
  const customInput = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('모델 이름', 'Model name') });

  const fail = {
    'ERR:badkey': t('키 형식이 올바르지 않아요.', 'The key format is invalid.'),
    'ERR:badextra': t('계정 ID 형식이 올바르지 않아요(32자리 영문·숫자).', 'Invalid account ID (32 letters/digits).'),
    'ERR:nokey': t('이 제공자는 키가 필요 없어요.', 'This provider needs no key.'),
  };
  /** 네이티브 저장 실패 → 안내문. "ERR:store:<원인>" 의 원인(예외 이름)은 문제 해결에 쓰이도록 함께 보여 준다 */
  function failText(r) {
    const s = String(r || '');
    if (s.startsWith('ERR:store')) {
      const why = s.split(':').slice(2).join(':').slice(0, 120);
      return t('기기에 안전하게 저장하지 못했어요.', "Couldn't store the key securely on this device.") + (why ? ` (${why})` : '') + ' ' + t('아래 “문제 해결”에서 점검해 보세요.', 'See "Troubleshooting" below.');
    }
    return fail[s] || t('저장하지 못했어요.', "Couldn't save.");
  }
  // 안내는 입력 바로 아래에 계속 보여 준다(토스트는 몇 초 뒤 사라진다 — 예전에는 모달 시트에 가려 아예 보이지 않았다)
  let keyMsg = null, storageMsg = null;
  function say(kind, text) {
    keyMsg = text ? { kind, text } : null;
    if (text) toast(text, { duration: kind === 'err' ? 6000 : 3000 });
    render();
    const el = body.querySelector('.ai-keymsg');
    if (el && el.scrollIntoView) requestAnimationFrame(() => el.scrollIntoView({ block: 'nearest' }));
  }

  function saveKey() {
    const P = getProvider(pid), pc = pcfg(cfg, pid), pi = pinfo();
    const raw = keyInput.value;
    const k = raw.trim() ? cleanKey(raw) : '';
    if (raw.trim() && !k) { say('err', t('키 형식이 올바르지 않아요. 키 전체를 복사했는지, 한글·특수문자가 섞이지 않았는지 확인해 주세요.', 'The key format is invalid. Make sure you copied the whole key with no extra characters.')); return; }
    const extraRaw = P.extra ? extraInput.value.trim() : '';
    const extra = extraRaw ? (P.extra.parse ? P.extra.parse(extraRaw) : extraRaw) : ''; // 주소·라벨째 붙여넣어도 32자리를 찾아 쓴다
    if (extraRaw && !extra) { say('err', /^[0-9a-f]{32}$/i.test(k) ? t('계정 ID 칸과 API 토큰 칸이 바뀐 것 같아요. 32자리 값은 “계정 ID” 칸에 넣어 주세요.', 'The account ID and token fields look swapped. Put the 32-character value in the "Account ID" field.') : fail['ERR:badextra']); return; }
    if (!k && !pi.hasKey) { say('err', P.extra && !extra && !pi.extra ? t('계정 ID와 API 토큰을 모두 입력해 주세요.', 'Enter both the account ID and the API token.') : t('API 키를 입력해 주세요.', 'Enter an API key.')); return; }
    if (P.extra && !extra && !pi.extra) { say('err', t('계정 ID를 입력해 주세요(위쪽 “계정 ID” 칸).', 'Enter the account ID (the "Account ID" field above).')); return; }
    const r = bridge.ai.setKey(pid, k, extra);
    if (r !== true) { say('err', failText(r)); return; } // 입력한 키는 그대로 둔다
    keyInput.value = '';
    pc.models = []; testMsg = null;
    cfg.provider = pid; // 키를 저장한 제공자를 바로 쓰도록
    app.saveSettings();
    info = bridge.ai.info();
    const now = pinfo();
    if (k && (!now.hasKey || now.readable === false)) { say('err', t('저장했지만 다시 읽지 못했어요. 아래 “문제 해결”에서 점검해 보세요.', "Saved, but it couldn't be read back. See \"Troubleshooting\" below.")); return; }
    say('ok', k ? t('키를 안전하게 저장했어요. “연결 테스트”로 확인해 보세요.', 'Key saved. Use "Test connection" to check it.') : t('설정을 바꿨어요.', 'Settings updated.'));
  }
  function checkStorage() {
    const r = bridge.ai.selfTest();
    if (!r) { storageMsg = { kind: 'err', text: t('이 앱에서는 점검 기능을 쓸 수 없어요.', 'The storage check is unavailable.') }; render(); return; }
    const m = {};
    for (const kv of r.split(/\s+/)) { const i = kv.indexOf('='); if (i > 0) m[kv.slice(0, i)] = kv.slice(i + 1); }
    const lab = (v) => (v === 'ok' ? t('정상', 'OK') : t('오류', 'Error') + (v ? ` (${v})` : ''));
    const good = m.hw === 'ok' || m.hw2 === 'ok' || m.sw === 'ok';
    const ks = lab(m.hw) + (m.hw2 ? ` (${t('보조 키', 'spare key')}: ${lab(m.hw2)})` : '');
    storageMsg = { kind: good ? 'ok' : 'err', text: t(`기기 보안 저장소(Keystore): ${ks} · 앱 전용 저장소: ${lab(m.sw)}`, `Device Keystore: ${ks} · App storage: ${lab(m.sw)}`) + (good ? '' : ' ' + t('이 결과를 알려 주세요.', 'Please report this result.')) };
    render();
  }
  function clearKey() {
    const pc = pcfg(cfg, pid);
    keyMsg = null;
    bridge.ai.clearKey(pid);
    pc.models = []; delete cfg.consents[pid]; delete cfg.consents[pid + ':text']; testMsg = null;
    app.saveSettings();
    info = bridge.ai.info();
    toast(t('키를 삭제했어요', 'Key removed'));
    render();
  }
  async function test() {
    if (testing) return;
    const P = getProvider(pid), pc = pcfg(cfg, pid);
    testing = true; testMsg = { kind: 'wait', text: t('연결 확인 중…', 'Checking connection…') }; render();
    try {
      const r = await P.test(pinfo(), { timeoutMs: 40000 });
      pc.models = r.d.list || [];
      app.saveSettings();
      testMsg = { kind: r.kind, text: r.text };
    } catch (e) {
      testMsg = { kind: 'err', text: explainError(e && e.info ? e.info : { message: String(e && e.message) }).text };
    }
    testing = false; render();
  }

  function render() {
    body.replaceChildren();
    const P = getProvider(pid), pc = pcfg(cfg, pid), pi = pinfo();
    const hasKey = !!pi.hasKey;
    body.append(Chips({ label: t('AI 제공자', 'AI provider'), wrap: true, value: pid, items: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].short, valueText: PROVIDERS[id].tag() })), onSelect: (id) => { pid = id; cfg.provider = id; app.saveSettings(); testMsg = null; keyMsg = null; storageMsg = null; keyInput.value = ''; render(); } }).el);
    body.append(h('p', { class: 'sheet-note' }, P.desc()));
    if (P.noKey) { // (키가 필요 없는 제공자 — 지금은 없다)
      body.append(h('div', { class: 'kv' }, h('span', null, t('API 키', 'API key')), h('b', null, t('필요 없음', 'Not needed'))));
      body.append(h('p', { class: 'sheet-note' }, P.howto()));
    } else {
      body.append(h('div', { class: 'kv' }, h('span', null, t('API 키', 'API key')), h('b', null, hasKey ? (pi.readable === false ? t('읽을 수 없음', 'Unreadable') : (pi.hint || t('저장됨', 'Saved'))) : t('없음', 'Not set'))));
      if (hasKey && pi.readable === false) body.append(h('p', { class: 'ai-keymsg err', role: 'alert' }, t('저장된 키를 읽을 수 없어요(기기 보안 저장소가 초기화됐거나 문제가 있어요). 키를 다시 입력해 저장해 주세요.', "The stored key can't be read (the device's secure storage was reset or has a problem). Enter the key again and save.")));
      if (P.extra) {
        extraInput.placeholder = P.extra.placeholder();
        extraInput.value = pi.extra || extraInput.value;
        body.append(h('div', { class: 'sheet-sec' }, P.extra.label()), extraInput);
      }
      keyInput.placeholder = { modelscope: t('ModelScope 액세스 토큰', 'ModelScope access token'), gemini: t('Gemini API 키 (AIza…)', 'Gemini API key (AIza…)'), huggingface: t('Hugging Face 토큰 (hf_…)', 'Hugging Face token (hf_…)') }[pid] || t('API 토큰', 'API token');
      body.append(keyInput,
        h('div', { class: 'row wrap' }, Btn(hasKey ? t('저장 / 바꾸기', 'Save / replace') : t('키 저장', 'Save key'), 'tonal', saveKey, 'key-round'), hasKey ? Btn(t('키 삭제', 'Remove'), 'outlined', clearKey, 'trash-2') : null));
      if (keyMsg) body.append(h('p', { class: 'ai-keymsg ' + keyMsg.kind, role: keyMsg.kind === 'err' ? 'alert' : 'status' }, keyMsg.text));
      if (hasKey && pi.prot === 'sw') body.append(h('p', { class: 'sheet-note' }, t('이 기기는 보안 칩 저장소(Keystore)를 쓸 수 없어, 키를 앱 전용 저장소에 암호화해 보관하고 있어요(보호 수준이 조금 낮아요).', "This device can't use the Keystore, so the key is stored encrypted in the app's private storage (slightly lower protection).")));
      body.append(h('p', { class: 'sheet-note' }, P.howto() + ' ' + t('키는 이 기기의 안전한 저장소(Android Keystore)에 암호화돼 보관되고, 화면(웹) 쪽에서는 다시 읽을 수 없어요.', 'The key is encrypted in the Android Keystore and cannot be read back by the page.')));
    }

    if (P.modelPresets.length) { // 모델을 고를 수 있는 제공자(Cloudflare · ModelScope)
      body.append(h('div', { class: 'sheet-sec' }, t('모델', 'Model')));
      const manual = pc.model !== MODEL_AUTO;
      body.append(Segmented({ label: t('모델 선택 방식', 'Model selection'), items: [{ id: MODEL_AUTO, label: t('자동 (권장)', 'Auto (recommended)') }, { id: 'manual', label: t('직접 지정', 'Manual') }], value: manual ? 'manual' : MODEL_AUTO,
        onChange: (v) => { if (v === MODEL_AUTO) pc.model = MODEL_AUTO; else { pc.custom = pc.custom || P.modelPresets[0] || pc.models[0] || P.fallbackModel || ''; pc.model = pc.custom || 'manual'; } app.saveSettings(); render(); } }).el);
      if (!manual) {
        const auto = { cloudflare: t('FLUX.2 klein 4B(가볍고 빠름, 무료 한도를 아껴 써요)를 써요.', 'Uses FLUX.2 klein 4B (light and fast; stretches the free allowance).'),
          modelscope: t('Qwen-Image-Edit 를 써요(사진 편집 모델).', 'Uses Qwen-Image-Edit (a photo-editing model).'),
          gemini: t('gemini-2.5-flash-image(“나노 바나나”)를 써요.', 'Uses gemini-2.5-flash-image ("Nano Banana").') }[pid];
        body.append(h('p', { class: 'sheet-note' }, auto + ' ' + t('현재: ', 'Current: ') + P.autoModel));
      } else {
        const ids = Array.from(new Set([...(P.modelPresets || []), ...(pc.models || [])]));
        body.append(Chips({ label: t('사용 가능한 모델', 'Available models'), wrap: true, value: pc.custom, items: ids.map((m) => ({ id: m, label: m, valueText: isCfGenerateModel(m) ? t('생성 전용', 'text-only') : undefined })), onSelect: (id) => { pc.custom = id; pc.model = id; customInput.value = id; app.saveSettings(); } }).el);
        customInput.placeholder = { modelscope: 'Qwen/Qwen-Image-Edit', gemini: 'gemini-2.5-flash-image' }[pid] || '@cf/black-forest-labs/flux-2-klein-4b';
        customInput.value = pc.custom || '';
        customInput.onchange = () => { const v = customInput.value.trim().slice(0, 100); pc.custom = v; pc.model = v || MODEL_AUTO; app.saveSettings(); };
        body.append(customInput);
      }
    }
    if (P.test) {
      body.append(Btn(testing ? t('확인 중…', 'Checking…') : t('연결 테스트', 'Test connection'), 'outlined', test, 'shield-check'));
      if (testMsg) body.append(h('p', { class: 'ai-msg ' + testMsg.kind, role: 'status' }, testMsg.text));
    }

    if (!P.noKey) {
      const ts = h('details', { class: 'ai-adv' }, h('summary', null, t('문제 해결', 'Troubleshooting')),
        h('p', { class: 'sheet-note' }, t('키가 저장되지 않거나 사라질 때 눌러 보세요. 이 기기의 키 보관(암호화) 기능이 정상인지 확인해요. 키 값은 쓰지 않아요.', "Tap this if the key won't save or disappears. It checks that this device's key storage works. Your key isn't used.")),
        Btn(t('보관 기능 점검', 'Check key storage'), 'outlined', checkStorage, 'shield-check'));
      if (storageMsg) { ts.append(h('p', { class: 'ai-keymsg ' + storageMsg.kind, role: 'status' }, storageMsg.text)); ts.open = true; }
      body.append(ts);
    }
    body.append(h('p', { class: 'sheet-note' }, privacyNote(pid)));
  }

  const modal = openModal({ title: t('AI 설정', 'AI settings'), onClose: () => { opts.onClose && opts.onClose(); }, build: (b) => { b.append(body); render(); } });
  return modal;
}
