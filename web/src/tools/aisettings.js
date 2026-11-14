// AI 설정: 제공자 선택(OpenAI / OpenRouter 무료 모델 / Cloudflare 하루 무료) · API 키(기기 Keystore 에 암호화 저장) · 모델 · 연결 테스트 · 개인정보 안내
import { h } from '../ui/dom.js';
import { t } from '../i18n.js';
import { openModal, Segmented, Chips, Btn, toast } from '../ui/components.js';
import { bridge } from '../bridge.js';
import { DEFAULT_BASE, MODEL_AUTO, cleanKey, explainError } from '../ai/openai.js';
import { AiError } from '../ai/client.js';
import { PROVIDERS, PROVIDER_IDS, getProvider } from '../ai/providers.js';

const AI_DEFAULTS = { provider: 'openai', quality: 'medium', n: 1, ctx: 1, feather: 30, tone: true };
const P_DEFAULTS = () => ({ model: MODEL_AUTO, custom: '', resolved: '', models: [], free: [], meta: {} });

/**
 * 설정의 AI 항목(같은 객체를 계속 돌려준다 — 여러 곳에서 고쳐도 한 객체에 모이도록). 키 자체는 여기 없다(네이티브 Keystore).
 * p[제공자] = 모델 선택/자동 선택 결과/조회한 목록, consents[제공자] = 동의한 서버 호스트
 */
export function aiConfig(app) {
  const s = app.settings;
  if (!s.ai || typeof s.ai !== 'object') s.ai = {};
  const c = s.ai;
  if (!c.p || typeof c.p !== 'object') { // 1.1.0(OpenAI 전용) 설정에서 이전
    c.p = { openai: Object.assign(P_DEFAULTS(), { model: c.model || MODEL_AUTO, custom: c.custom || '', resolved: c.resolved || '', models: Array.isArray(c.models) ? c.models : [] }) };
    for (const k of ['model', 'custom', 'resolved', 'models']) delete c[k];
  }
  if (!c.consents || typeof c.consents !== 'object') { c.consents = {}; if (c.consent && c.consent.base) c.consents.openai = c.consent.base; }
  delete c.consent;
  for (const k of Object.keys(AI_DEFAULTS)) if (!(k in c)) c[k] = AI_DEFAULTS[k];
  if (!PROVIDERS[c.provider]) c.provider = 'openai';
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
  const pi = providerInfo(pid), P = getProvider(pid);
  return !!(pi && pi.hasKey && (!P.extra || pi.extra));
}

/** 현재 쓸 모델 id: 직접 지정 > 자동(제공자가 정함: 고정/키로 조회) > 기본값 */
export async function resolveModel(app, pid, opts) {
  const cfg = aiConfig(app), pc = pcfg(cfg, pid), P = getProvider(pid);
  if (pc.model !== MODEL_AUTO) return (pc.custom || '').trim() || pc.model || P.fallbackModel;
  if (P.autoModel) return P.autoModel;
  if (pc.resolved) return pc.resolved;
  try {
    const d = await P.discover(opts);
    pc.models = d.list; pc.free = d.free; pc.meta = d.meta || {}; pc.resolved = d.best || '';
    app.saveSettings();
  } catch (e) {
    if (e && e.info && (e.info.status === 401 || e.info.code === 'cancelled')) throw e;
    if (P.id !== 'openai') throw e; // 목록 없이는 쓸 모델을 알 수 없다(OpenRouter)
    pc.resolved = '';
    return P.fallbackModel;
  }
  if (!pc.resolved) {
    if (P.id === 'openrouter') throw new AiError({ code: 'no_free_model' });
    pc.resolved = P.fallbackModel;
  }
  return pc.resolved;
}

export function privacyNote(pid) {
  const P = getProvider(pid);
  const pi = providerInfo(pid);
  return P.privacy(P.host(pi)) + ' ' + t('AI 수정을 쓰지 않으면 앱은 인터넷을 쓰지 않아요.', 'If you never use AI edit, the app never uses the internet.');
}

/** 설정 모달. opts: {provider: 처음 보여줄 제공자, onClose()} */
export function openAiSettings(app, opts = {}) {
  const cfg = aiConfig(app);
  let pid = opts.provider && PROVIDERS[opts.provider] ? opts.provider : cfg.provider;
  let info = bridge.ai.info();
  let testMsg = null, testing = false;
  const pinfo = () => (info && info.providers && info.providers[pid]) || { hasKey: false, hint: '', base: '', extra: '' };
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });

  const keyInput = h('input', { class: 'field', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'sk-…', 'aria-label': t('API 키', 'API key'), name: 'imagefix-ai-key' });
  const extraInput = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('계정 ID', 'Account ID'), name: 'imagefix-ai-account' });
  const baseInput = h('input', { class: 'field', type: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: DEFAULT_BASE, 'aria-label': t('서버 주소', 'Server address') });
  const customInput = h('input', { class: 'field', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': t('모델 이름', 'Model name') });

  const fail = {
    'ERR:badbase': t('서버 주소가 올바르지 않아요. https:// 로 시작하는 공개 도메인만 쓸 수 있어요.', 'Invalid server address. Only public https:// domains are allowed.'),
    'ERR:badkey': t('키 형식이 올바르지 않아요.', 'The key format is invalid.'),
    'ERR:badextra': t('계정 ID 형식이 올바르지 않아요(32자리 영문·숫자).', 'Invalid account ID (32 letters/digits).'),
    'ERR:store': t('기기에 안전하게 저장하지 못했어요.', "Couldn't store the key securely on this device."),
  };

  function saveKey() {
    const P = getProvider(pid), pc = pcfg(cfg, pid), pi = pinfo();
    const raw = keyInput.value;
    const k = raw.trim() ? cleanKey(raw) : '';
    if (raw.trim() && !k) { toast(t('키 형식이 올바르지 않아요.', 'The key format is invalid.')); return; }
    const extra = P.extra ? extraInput.value.trim() : '';
    if (P.extra && extra && !P.extra.check(extra)) { toast(fail['ERR:badextra']); return; }
    if (!k && !pi.hasKey) { toast(t('API 키를 입력해 주세요.', 'Enter an API key.')); return; }
    if (P.extra && !extra && !pi.extra) { toast(t('계정 ID를 입력해 주세요.', 'Enter the account ID.')); return; }
    const base = P.customBase ? baseInput.value.trim() : '';
    const r = bridge.ai.setKey(pid, k, base, extra);
    if (r !== true) { toast(fail[r] || t('저장하지 못했어요.', "Couldn't save.")); return; }
    keyInput.value = '';
    pc.resolved = ''; pc.models = []; pc.free = []; pc.meta = {}; testMsg = null;
    cfg.provider = pid; // 키를 저장한 제공자를 바로 쓰도록
    app.saveSettings();
    info = bridge.ai.info();
    toast(k ? t('키를 안전하게 저장했어요', 'Key saved securely') : t('설정을 바꿨어요', 'Settings updated'));
    render();
  }
  function clearKey() {
    const pc = pcfg(cfg, pid);
    bridge.ai.clearKey(pid);
    pc.resolved = ''; pc.models = []; pc.free = []; pc.meta = {}; delete cfg.consents[pid]; testMsg = null;
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
      pc.models = r.d.list; pc.free = r.d.free; pc.meta = r.d.meta || {};
      pc.resolved = r.d.best || ''; // 목록에서 못 찾으면 비워 두어, 다음 요청이 "쓸 모델 없음"을 정확히 알리게 한다
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
    body.append(Chips({ label: t('AI 제공자', 'AI provider'), wrap: true, value: pid, items: PROVIDER_IDS.map((id) => ({ id, label: PROVIDERS[id].short, valueText: PROVIDERS[id].tag() })), onSelect: (id) => { pid = id; cfg.provider = id; app.saveSettings(); testMsg = null; keyInput.value = ''; render(); } }).el);
    body.append(h('p', { class: 'sheet-note' }, P.desc()));
    body.append(h('div', { class: 'kv' }, h('span', null, t('API 키', 'API key')), h('b', null, hasKey ? (pi.hint || t('저장됨', 'Saved')) : t('없음', 'Not set'))));
    if (P.extra) {
      extraInput.placeholder = P.extra.placeholder();
      extraInput.value = pi.extra || extraInput.value;
      body.append(h('div', { class: 'sheet-sec' }, P.extra.label()), extraInput);
    }
    keyInput.placeholder = pid === 'openrouter' ? 'sk-or-v1-…' : pid === 'cloudflare' ? t('API 토큰', 'API token') : 'sk-…';
    body.append(keyInput,
      h('div', { class: 'row wrap' }, Btn(hasKey ? t('저장 / 바꾸기', 'Save / replace') : t('키 저장', 'Save key'), 'tonal', saveKey, 'key-round'), hasKey ? Btn(t('키 삭제', 'Remove'), 'outlined', clearKey, 'trash-2') : null),
      h('p', { class: 'sheet-note' }, P.howto() + ' ' + t('키는 이 기기의 안전한 저장소(Android Keystore)에 암호화돼 보관되고, 화면(웹) 쪽에서는 다시 읽을 수 없어요.', 'The key is encrypted in the Android Keystore and cannot be read back by the page.')));

    body.append(h('div', { class: 'sheet-sec' }, t('모델', 'Model')));
    const manual = pc.model !== MODEL_AUTO;
    body.append(Segmented({ label: t('모델 선택 방식', 'Model selection'), items: [{ id: MODEL_AUTO, label: t('자동 (권장)', 'Auto (recommended)') }, { id: 'manual', label: t('직접 지정', 'Manual') }], value: manual ? 'manual' : MODEL_AUTO,
      onChange: (v) => { if (v === MODEL_AUTO) pc.model = MODEL_AUTO; else { pc.custom = pc.custom || P.modelPresets[0] || pc.models[0] || P.fallbackModel || ''; pc.model = pc.custom || 'manual'; } app.saveSettings(); render(); } }).el);
    if (!manual) {
      const cur = P.autoModel || pc.resolved;
      const auto = { openai: t('내 키로 쓸 수 있는 가장 새로운 gpt-image 모델을 알아서 골라요.', 'Automatically picks the newest gpt-image model available to your key.'),
        openrouter: t('지금 쓸 수 있는 가장 새로운 “무료 + 이미지 편집” 모델을 알아서 골라요(첫 요청 때 목록을 조회).', 'Automatically picks the newest free image-editing model (looked up on the first request).'),
        cloudflare: t('FLUX.2 klein 4B(가볍고 빠름, 무료 한도를 아껴 써요)를 써요.', 'Uses FLUX.2 klein 4B (light and fast; stretches the free allowance).') }[pid];
      body.append(h('p', { class: 'sheet-note' }, auto + (cur ? ' ' + t('현재: ', 'Current: ') + cur : '')));
    } else {
      const ids = Array.from(new Set([...(P.modelPresets || []), ...(pc.models || [])]));
      if (ids.length) body.append(Chips({ label: t('사용 가능한 모델', 'Available models'), wrap: true, value: pc.custom, items: ids.map((m) => ({ id: m, label: m, valueText: (pc.free || []).includes(m) ? t('무료', 'free') : undefined })), onSelect: (id) => { pc.custom = id; pc.model = id; customInput.value = id; app.saveSettings(); } }).el);
      customInput.placeholder = pid === 'openrouter' ? 'vendor/model:free' : pid === 'cloudflare' ? '@cf/black-forest-labs/flux-2-klein-4b' : 'gpt-image-…';
      customInput.value = pc.custom || '';
      customInput.onchange = () => { const v = customInput.value.trim().slice(0, 100); pc.custom = v; pc.model = v || MODEL_AUTO; app.saveSettings(); };
      body.append(customInput);
    }
    body.append(Btn(testing ? t('확인 중…', 'Checking…') : t('연결 테스트', 'Test connection'), 'outlined', test, 'shield-check'));
    if (testMsg) body.append(h('p', { class: 'ai-msg ' + testMsg.kind, role: 'status' }, testMsg.text));

    if (P.customBase) {
      baseInput.value = pi.base && pi.base !== DEFAULT_BASE ? pi.base : baseInput.value;
      const det = h('details', { class: 'ai-adv' }, h('summary', null, t('고급: 서버 주소', 'Advanced: server address')),
        h('p', { class: 'sheet-note' }, t('OpenAI 호환 서버를 쓸 때만 바꿔요. 키가 이 서버로 전송돼요. https 공개 도메인만 허용돼요. 바꾼 뒤에는 “저장 / 바꾸기”를 눌러요.', 'Change only for an OpenAI-compatible server. Your key is sent to it. Only public https domains are allowed. Press "Save / replace" afterwards.')), baseInput);
      if (baseInput.value) det.open = true;
      body.append(det);
    }
    body.append(h('p', { class: 'sheet-note' }, privacyNote(pid)));
  }

  const modal = openModal({ title: t('AI 설정', 'AI settings'), onClose: () => { opts.onClose && opts.onClose(); }, build: (b) => { b.append(body); render(); } });
  return modal;
}
