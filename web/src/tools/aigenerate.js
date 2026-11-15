// AI로 이미지 만들기: 문구만으로 새 이미지를 만든다. 사진은 보내지 않는다.
//  - Cloudflare Workers AI · FLUX.1 schnell : 하루 무료 한도 (유튜브에서 가장 많이 소개되는 무료 이미지 생성 모델)
//  - Google Gemini : gemini-2.5-flash-image("나노 바나나") — 내 API 키
// 한국어 문구는 영어로 번역해서(Cloudflare 만, best-effort) 보내면 결과가 훨씬 좋다. 결과는 바로 편집기로 열 수 있다.
import { h } from '../ui/dom.js';
import { t } from '../i18n.js';
import { openModal, Chips, Segmented, Switch, Btn, toast } from '../ui/components.js';
import { bridge } from '../bridge.js';
import { explainError } from '../ai/common.js';
import { AiError } from '../ai/client.js';
import { PROVIDERS, getProvider, translateToEnglish } from '../ai/providers.js';
import { aiConfig, resolveModel, openAiSettings, providerReady, ensureConsent } from './aisettings.js';

const GEN_PROVIDERS = ['cloudflare', 'gemini']; // 문구만으로 새 이미지를 만들 수 있는 제공자(ModelScope 는 편집 전용, Hugging Face 는 인페인팅 전용)
const EXAMPLES = [
  { ko: '노을 지는 바다 위의 작은 돛단배, 수채화', en: 'A small sailboat on a sunset sea, watercolor' },
  { ko: '벚꽃이 흩날리는 한국 전통 마을', en: 'A traditional Korean village with falling cherry blossoms' },
  { ko: '네온 불빛이 가득한 비 오는 미래 도시의 밤', en: 'A rainy futuristic city at night full of neon lights' },
  { ko: '구름 위에 떠 있는 작은 섬과 폭포, 판타지 일러스트', en: 'A small floating island with a waterfall above the clouds, fantasy illustration' },
  { ko: '창가에서 낮잠 자는 귀여운 고양이', en: 'A cute cat napping by the window' },
];
/** 모양 → 제공자 크기 목록(P.sizes)의 순서: 0 정사각 · 1 가로 · 2 세로 */
const SHAPES = [{ id: '0', ko: '정사각', en: 'Square' }, { id: '1', ko: '가로', en: 'Landscape' }, { id: '2', ko: '세로', en: 'Portrait' }];

/** 처음 보여줄 제공자: 마지막에 쓴 것 → 설정이 끝난 것(Cloudflare, Gemini 순) → Cloudflare */
function firstProvider(cfg) {
  if (GEN_PROVIDERS.includes(cfg.genProvider)) return cfg.genProvider;
  return GEN_PROVIDERS.find((p) => providerReady(p)) || 'cloudflare';
}

/** 홈 화면의 "AI로 이미지 만들기" 시트 */
export function openGenerate(app) {
  const cfg = aiConfig(app);
  let pid = firstProvider(cfg);
  const st = { phase: 'form', prompt: '', shape: '0', blob: null, url: '', used: '', translated: false, err: null, t0: 0, step: 'wait' };
  let ctl = null, timer = 0, promptEl = null, phaseEl = null, modal = null, closeFn = null;
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  const save = () => app.saveSettings();
  const revoke = () => { if (st.url) { try { URL.revokeObjectURL(st.url); } catch (e) { /* noop */ } st.url = ''; } };
  const STEP = () => ({ translate: t('영어로 번역 중…', 'Translating to English…'), upload: t('서버로 보내는 중…', 'Uploading…'), wait: t('AI가 그리는 중…', 'AI is drawing…'), download: t('결과 이미지를 받는 중…', 'Downloading the result…') });
  function tick() { if (phaseEl) phaseEl.textContent = (STEP()[st.step] || STEP().wait) + ' ' + Math.round((performance.now() - st.t0) / 1000) + t('초', 's'); }

  async function run() {
    const text = st.prompt.trim();
    if (!text) { toast(t('만들고 싶은 그림을 적어 주세요', 'Describe the image first')); if (promptEl) promptEl.focus(); return; }
    if (!bridge.ai.available()) { toast(t('AI 이미지 만들기는 앱(APK)에서만 쓸 수 있어요', 'AI image creation works only in the app (APK)')); return; }
    const P = getProvider(pid);
    if (!providerReady(pid)) { openAiSettings(app, { provider: pid, onClose: render }); return; }
    if (!(await ensureConsent(app, P, true))) return;
    ctl = new AbortController();
    revoke(); st.blob = null; st.err = null; st.phase = 'busy'; st.t0 = performance.now(); st.step = 'wait';
    render(); timer = setInterval(tick, 400);
    bridge.keepScreenOn(true);
    try {
      const model = pid === 'cloudflare' ? P.generateModel : await resolveModel(app, pid);
      let prompt = text; st.translated = false;
      if (pid === 'cloudflare' && cfg.translate !== false) { // 번역은 Cloudflare 만(문구를 다른 곳으로 더 보내지 않는다)
        st.step = 'translate';
        const tr = await translateToEnglish(text, { signal: ctl.signal });
        prompt = tr.text; st.translated = tr.translated;
      }
      st.step = 'wait';
      const size = P.sizes[Number(st.shape)] || P.sizes[0];
      const blobs = await P.generate({ model, prompt, size }, { signal: ctl.signal, onPhase: (p) => { st.step = p; } });
      if (!blobs.length) throw new AiError({ code: 'no_image', status: 200 });
      st.blob = blobs[0]; st.url = URL.createObjectURL(st.blob); st.used = prompt; st.phase = 'done';
    } catch (e) {
      st.phase = 'form';
      const info = e instanceof AiError ? e.info : { code: 'other', message: String((e && e.message) || e) };
      if (!(e instanceof AiError)) console.error(e);
      if (info.code !== 'cancelled') st.err = explainError(info);
    } finally {
      clearInterval(timer); timer = 0; ctl = null; bridge.keepScreenOn(false);
      if (modal) render();
    }
  }
  function cancel() { if (ctl) ctl.abort(); }
  async function edit() {
    if (!st.blob) return;
    const blob = st.blob;
    if (closeFn) closeFn();
    await app.openGenerated(blob);
  }

  /** 제공자 소개(한 줄) */
  const about = () => ({
    cloudflare: t('FLUX.1 schnell — 유튜브에서 가장 많이 소개되는 무료 이미지 생성 모델이에요. 하루 무료 한도 안에서 쓸 수 있고, 사진은 보내지 않아요.', 'FLUX.1 schnell — the free image model most YouTube tutorials use. Works within the daily free allowance; no photo is sent.'),
    gemini: t('Gemini 이미지 모델(나노 바나나)로 만들어요. 내 Gemini API 키가 필요하고, 무료 키는 이미지 모델 한도가 0 일 수 있어요. 사진은 보내지 않아요.', 'Creates images with the Gemini image model ("Nano Banana"). Needs your Gemini API key; a free key may have a zero quota for image models. No photo is sent.'),
  })[pid];
  const setupText = () => ({
    cloudflare: t('Cloudflare 계정 ID와 API 토큰을 넣으면 바로 쓸 수 있어요(무료 가입).', 'Enter your Cloudflare account ID and API token to start (free signup).'),
    gemini: t('Gemini API 키를 넣으면 쓸 수 있어요(aistudio.google.com).', 'Enter your Gemini API key to use it (aistudio.google.com).'),
  })[pid];

  function render() {
    body.replaceChildren(); promptEl = null; phaseEl = null;
    const P = getProvider(pid);
    if (st.phase === 'busy') {
      phaseEl = h('div', { class: 'ai-phase num', 'aria-live': 'polite' });
      body.append(h('div', { class: 'ai-busy' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('AI 작업 중', 'AI working') }), phaseEl),
        h('p', { class: 'sheet-note' }, pid === 'cloudflare' ? t('보통 5~30초 걸려요. 이 화면을 벗어나지 말고 기다려 주세요. 문구만 전송했어요.', 'Usually 5–30 seconds. Please stay on this screen. Only your prompt was sent.') : t('보통 10~60초 걸려요. 이 화면을 벗어나지 말고 기다려 주세요. 문구만 전송했어요.', 'Usually 10–60 seconds. Please stay on this screen. Only your prompt was sent.')),
        h('div', { class: 'row' }, Btn(t('취소', 'Cancel'), 'outlined', cancel, 'x')));
      tick();
      return;
    }
    if (st.phase === 'done') {
      const img = h('img', { class: 'ai-gen-result', src: st.url, alt: t('AI가 만든 이미지', 'AI-generated image') });
      body.append(...[img,
        h('p', { class: 'sheet-note' }, t('사용한 문구: ', 'Prompt used: ') + st.used + (st.translated ? t(' (영어로 번역됨)', ' (translated)') : '')),
        h('div', { class: 'row wrap' }, Btn(t('편집하기', 'Edit'), 'filled', edit, 'wand-sparkles'), Btn(t('다시 만들기', 'Create again'), 'outlined', run, 'refresh-cw'), Btn(t('문구 고치기', 'Change prompt'), 'text', () => { st.phase = 'form'; render(); }))].filter(Boolean));
      return;
    }
    body.append(Chips({ label: t('AI 제공자', 'AI provider'), wrap: true, value: pid, items: GEN_PROVIDERS.map((id) => ({ id, label: PROVIDERS[id].short, valueText: PROVIDERS[id].tag() })), onSelect: (id) => { pid = id; cfg.genProvider = id; save(); st.err = null; render(); } }).el);
    body.append(h('p', { class: 'sheet-note' }, about()));
    if (!providerReady(pid)) {
      body.append(h('div', { class: 'ai-setup' }, h('p', { class: 'sheet-note' }, setupText()),
        Btn(t('키 설정', 'Set up key'), 'tonal', () => openAiSettings(app, { provider: pid, onClose: render }), 'key-round')));
    }
    promptEl = h('textarea', { class: 'field ai-prompt', rows: 3, maxlength: 500, placeholder: t('예: 노을 지는 바다 위의 작은 돛단배', 'e.g. A small sailboat on a sunset sea'), 'aria-label': t('만들고 싶은 그림', 'Image to create') });
    promptEl.value = st.prompt;
    promptEl.addEventListener('input', () => { st.prompt = promptEl.value; });
    body.append(promptEl, Chips({ label: t('예시 문구', 'Examples'), items: EXAMPLES.map((x, i) => ({ id: String(i), label: t(x.ko, x.en) })), onSelect: (id) => { const x = EXAMPLES[+id]; st.prompt = t(x.ko, x.en); promptEl.value = st.prompt; promptEl.focus(); } }).el);
    if (pid === 'cloudflare') body.append(Switch({ label: t('영어로 번역해서 보내기 (한국어는 영어일 때 결과가 훨씬 좋아요)', 'Translate to English first (results are much better in English)'), value: cfg.translate !== false, onChange: (v) => { cfg.translate = v; save(); } }).el);
    if (pid !== 'cloudflare') body.append(Segmented({ label: t('모양', 'Shape'), items: SHAPES.map((a) => ({ id: a.id, label: t(a.ko, a.en) })), value: st.shape, onChange: (v) => { st.shape = v; } }).el);
    if (st.err) body.append(...[h('p', { class: 'ai-msg err', role: 'alert' }, st.err.text), st.err.settings ? Btn(t('AI 설정 열기', 'Open AI settings'), 'tonal', () => openAiSettings(app, { provider: pid, onClose: render }), 'key-round') : null].filter(Boolean));
    body.append(h('div', { class: 'row' }, Btn(t('만들기', 'Create'), 'filled', run, 'wand-sparkles'), Btn(t('AI 설정', 'AI settings'), 'text', () => openAiSettings(app, { provider: pid, onClose: render }), 'key-round')));
  }

  modal = openModal({ title: t('AI로 이미지 만들기', 'Create an image with AI'), onClose: () => { cancel(); clearInterval(timer); revoke(); modal = null; }, build: (b, close) => { closeFn = close; b.append(body); render(); } });
  return modal;
}
