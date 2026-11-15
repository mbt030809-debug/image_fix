// AI 영역 수정: 올가미/브러시/사각형/원형으로 영역을 고르고, 그 영역(+주변)만 AI 에 요청한다.
//  - Cloudflare · Gemini: 사진을 보고 고친다(편집) 또는 문구만으로 채운다  - ModelScope(Qwen-Image-Edit): 표시한 사진 1장으로 편집  - Hugging Face(FLUX.1 Fill): 진짜 마스크로 인페인팅
// 결과는 "선택 안쪽만 보이는" 이미지 레이어로 합성돼 비파괴(숨기기·삭제·실행 취소)로 남는다.
import { h, icon, rafThrottle } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn, uid } from '../store.js';
import { Segmented, Chips, Slider, Btn, IconBtn, toast } from '../ui/components.js';
import { bridge } from '../bridge.js';
import * as Drafts from '../drafts.js';
import { newMask, rasterPolygon, rectPts, ellipsePts, combine, strokeOp, invertMask, bboxOf, growMask, contourSegments } from '../ai/selection.js';
import { explainError, MODEL_AUTO } from '../ai/common.js';
import { AiError } from '../ai/client.js';
import { PROVIDERS, getProvider, modelProfile, translateToEnglish } from '../ai/providers.js';
import { prepareRequest, makePatch, sentPreview } from '../ai/job.js';
import { aiConfig, pcfg, resolveModel, openAiSettings, providerReady, ensureConsent } from './aisettings.js';

const PRESETS = [
  { id: 'erase', ko: '물체 지우기', en: 'Remove object', pko: '선택한 부분의 물체를 지우고 주변 배경과 자연스럽게 이어 주세요.', pen: 'Remove the object in the selected area and fill it naturally to match the surrounding background.' },
  { id: 'sky', ko: '하늘 바꾸기', en: 'Change sky', pko: '하늘을 맑고 푸른 하늘과 은은한 구름으로 바꿔 주세요.', pen: 'Replace the sky with a clear blue sky and soft clouds.' },
  { id: 'color', ko: '색 바꾸기', en: 'Recolor', pko: '이 부분의 색을 파란색으로 바꿔 주세요. 질감과 그림자는 그대로 유지해 주세요.', pen: 'Change the color of this area to blue, keeping its texture and shadows.' },
  { id: 'bg', ko: '배경 바꾸기', en: 'New background', pko: '배경을 해변 풍경으로 바꿔 주세요.', pen: 'Change the background to a beach scene.' },
  { id: 'clean', ko: '깔끔하게', en: 'Clean up', pko: '이 부분을 깨끗하고 선명하게 정리해 주세요. 잡티와 얼룩을 없애 주세요.', pen: 'Clean up this area: remove blemishes and stains and make it sharp and tidy.' },
  { id: 'add', ko: '물체 추가', en: 'Add object', pko: '이 부분에 작은 화분을 하나 추가해 주세요.', pen: 'Add a small potted plant here.' },
];

// 문구만으로 그리는 모델(사진을 보지 못함)용: 선택 안쪽에 들어갈 "내용"을 설명한다 (영어로 번역돼 전달됨)
const GEN_PRESETS = [
  { id: 'sky', ko: '맑은 하늘', en: 'Clear sky', pko: '구름이 몽글몽글한 맑고 파란 하늘', pen: 'A clear blue sky with soft fluffy clouds' },
  { id: 'sunset', ko: '노을 하늘', en: 'Sunset', pko: '붉고 주황빛으로 물든 극적인 노을 하늘', pen: 'A dramatic orange and pink sunset sky' },
  { id: 'grass', ko: '잔디밭', en: 'Grass', pko: '푸르고 촘촘한 잔디밭', pen: 'A lush green lawn' },
  { id: 'water', ko: '바다 물결', en: 'Sea waves', pko: '잔잔한 푸른 바다 물결', pen: 'Calm blue sea water with gentle waves' },
  { id: 'wall', ko: '벽돌 벽', en: 'Brick wall', pko: '오래된 붉은 벽돌 벽', pen: 'An old red brick wall' },
  { id: 'flowers', ko: '꽃밭', en: 'Flowers', pko: '활짝 핀 알록달록한 꽃밭', pen: 'A field of blooming colorful flowers' },
];

const G = 1024; // 선택 마스크 격자의 긴 변

export function open(ed, body) {
  const cfg = aiConfig(ed.app);
  const lp0 = ed.logical;
  const wide = lp0.pw >= lp0.ph;
  const mw = wide ? G : Math.max(16, Math.round((G * lp0.pw) / lp0.ph));
  const mh = wide ? Math.max(16, Math.round((G * lp0.ph) / lp0.pw)) : G;
  const S = { tab: 'select', shape: 'lasso', mode: 'add', brush: 14, grow: 0, prompt: '', phase: 'select', msg: null, variant: 0 };

  let closed = false;
  let mask = newMask(mw, mh), eff = mask, undo = [];
  let cur = null, cursor = null, work = null, selInfo = null;
  let tintCv = null, tintData = null, tintAll = true, dirty = null;
  let contour = null, contourDirty = true;
  let job = null, review = null, timer = 0;
  let undoBtn = null, invBtn = null, clrBtn = null;
  let promptEl = null;

  const prov = () => getProvider(cfg.provider);
  /** 지금 선택된 모델(자동이면 정해진 값 또는 마지막으로 확인한 값) — 요청 전에 동작 방식(편집/생성)을 알기 위해 */
  const currentModel = (P) => { const pc = pcfg(cfg, P.id); return pc.model !== MODEL_AUTO ? ((pc.custom || '').trim() || pc.model) : (P.autoModel || ''); };
  const note = (s) => h('p', { class: 'sheet-note' }, s);
  const sec = (s) => h('div', { class: 'sheet-sec' }, s);
  const save = () => ed.app.saveSettings();

  // ------------------------------------------------------------ 선택 마스크
  function recompute() { eff = S.grow ? growMask(mask, mw, mh, S.grow) : mask; tintAll = true; contourDirty = true; selInfo = null; }
  function selBox() { if (!selInfo) selInfo = { box: bboxOf(eff, mw, mh) }; return selInfo.box; }
  const redraw = rafThrottle(() => { if (!closed) ed.invalidateOverlay(); });
  function afterChange() { recompute(); syncButtons(); redraw(); }
  function pushUndo(m) { undo.push(m); if (undo.length > 20) undo.shift(); }
  function doUndo() { if (!undo.length) return; mask = undo.pop(); afterChange(); }
  function doInvert() { pushUndo(mask); mask = invertMask(mask.slice()); afterChange(); }
  function doClear() { if (!selBox() && !undo.length) return; pushUndo(mask); mask = newMask(mw, mh); afterChange(); }
  function resetSelection() { mask = newMask(mw, mh); undo = []; S.grow = 0; afterChange(); }
  function syncButtons() {
    if (undoBtn) undoBtn.disabled = !undo.length;
    if (invBtn) invBtn.disabled = false;
    if (clrBtn) clrBtn.disabled = !selBox();
  }
  const growRaf = rafThrottle(() => { if (!closed) afterChange(); });

  function markDirty(x0, y0, x1, y1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(mw, Math.ceil(x1)); y1 = Math.min(mh, Math.ceil(y1));
    if (x1 <= x0 || y1 <= y0) return;
    dirty = dirty ? { x0: Math.min(dirty.x0, x0), y0: Math.min(dirty.y0, y0), x1: Math.max(dirty.x1, x1), y1: Math.max(dirty.y1, y1) } : { x0, y0, x1, y1 };
  }
  function flushTint(src) {
    if (!tintCv) { tintCv = document.createElement('canvas'); tintCv.width = mw; tintCv.height = mh; tintData = tintCv.getContext('2d').createImageData(mw, mh); tintAll = true; }
    let x0 = 0, y0 = 0, x1 = mw, y1 = mh;
    if (!tintAll) { if (!dirty) return; ({ x0, y0, x1, y1 } = dirty); }
    const d = tintData.data;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * mw + x0; x < x1; x++, i++) { const j = i * 4; d[j] = 79; d[j + 1] = 140; d[j + 2] = 255; d[j + 3] = (src[i] * 0.42) | 0; }
    }
    tintCv.getContext('2d').putImageData(tintData, 0, 0, x0, y0, x1 - x0, y1 - y0);
    tintAll = false; dirty = null;
  }
  function buildContour() {
    const segs = contourSegments(eff, mw, mh);
    const p = new Path2D();
    for (let i = 0; i < segs.length; i += 4) { p.moveTo(segs[i], segs[i + 1]); p.lineTo(segs[i + 2], segs[i + 3]); }
    contour = p; contourDirty = false;
  }

  // ------------------------------------------------------------ 포인터
  const toMask = (ev) => { const lp = ed.logical; return [(ev.x / lp.pw) * mw, (ev.y / lp.ph) * mh]; };
  const brushR = () => (S.brush / 300) * Math.min(mw, mh);
  function brushTo(a, b) {
    const r = brushR();
    strokeOp(work, mw, mh, a[0], a[1], b[0], b[1], r, 0.7, S.mode);
    const pad = Math.ceil(r) + 1;
    markDirty(Math.min(a[0], b[0]) - pad, Math.min(a[1], b[1]) - pad, Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad);
  }
  const pointer = {
    down(ev) {
      if (S.phase !== 'select' || S.tab !== 'select') return false;
      const p = toMask(ev);
      cursor = [ev.sx, ev.sy];
      if (S.shape === 'brush') { work = mask.slice(); cur = { kind: 'brush', last: p }; brushTo(p, p); redraw(); return true; }
      cur = { kind: S.shape, pts: [p[0], p[1]], p0: p, p1: p };
      return true;
    },
    move(ev) {
      if (!cur) return;
      const p = toMask(ev);
      cursor = [ev.sx, ev.sy];
      if (cur.kind === 'brush') { brushTo(cur.last, p); cur.last = p; }
      else if (cur.kind === 'lasso') {
        const lp = ed.logical, sc = (ed.view.s * lp.pw) / mw, n = cur.pts.length;
        if (Math.hypot(p[0] - cur.pts[n - 2], p[1] - cur.pts[n - 1]) >= Math.max(0.6, 2 / sc)) cur.pts.push(p[0], p[1]);
      } else cur.p1 = p;
      redraw();
    },
    up() {
      if (!cur) return;
      const c = cur; cur = null; cursor = null;
      if (c.kind === 'brush') { pushUndo(mask); mask = work; work = null; afterChange(); return; }
      let cov = null;
      if (c.kind === 'lasso') { if (c.pts.length >= 6) cov = rasterPolygon(c.pts, mw, mh); }
      else {
        const [x0, y0] = c.p0, [x1, y1] = c.p1;
        if (Math.abs(x1 - x0) >= 3 && Math.abs(y1 - y0) >= 3) {
          cov = c.kind === 'rect' ? rasterPolygon(rectPts(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)), mw, mh)
            : rasterPolygon(ellipsePts((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2), mw, mh);
        }
      }
      if (cov) { pushUndo(mask); const m = mask.slice(); combine(m, cov, S.mode); mask = m; }
      afterChange();
    },
    cancel() { cur = null; cursor = null; work = null; tintAll = true; redraw(); },
  };

  // ------------------------------------------------------------ 오버레이
  function outline(ctx, path, dashed) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 4; path(); ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; if (dashed) ctx.setLineDash([7, 5]); path(); ctx.stroke();
    ctx.restore();
  }
  function drawOverlay(ctx, view) {
    const lp = ed.logical, sc = (view.s * lp.pw) / mw;
    const [ox, oy] = view.toScreen(0, 0);
    const src = work || eff;
    const reviewing = S.phase === 'review';
    if (!reviewing) {
      flushTint(src);
      ctx.save(); ctx.imageSmoothingEnabled = true; ctx.drawImage(tintCv, ox, oy, mw * sc, mh * sc); ctx.restore();
    }
    if (!work) {
      if (contourDirty) buildContour();
      if (contour) {
        ctx.save(); ctx.translate(ox, oy); ctx.scale(sc, sc);
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = (reviewing ? 3 : 4) / sc; ctx.stroke(contour);
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = (reviewing ? 1.5 : 2) / sc; ctx.setLineDash([7 / sc, 5 / sc]); ctx.stroke(contour);
        ctx.restore();
      }
    }
    if (!cur) return;
    const P = (x, y) => [ox + x * sc, oy + y * sc];
    if (cur.kind === 'lasso') {
      const pts = cur.pts;
      const path = () => { ctx.beginPath(); for (let i = 0; i < pts.length; i += 2) { const [x, y] = P(pts[i], pts[i + 1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); } };
      outline(ctx, path, false);
      if (pts.length >= 4) { const [a, b] = P(pts[0], pts[1]), [c, d] = P(pts[pts.length - 2], pts[pts.length - 1]); outline(ctx, () => { ctx.beginPath(); ctx.moveTo(c, d); ctx.lineTo(a, b); }, true); }
    } else if (cur.kind === 'rect' || cur.kind === 'ellipse') {
      const [ax, ay] = P(cur.p0[0], cur.p0[1]), [bx, by] = P(cur.p1[0], cur.p1[1]);
      outline(ctx, () => { ctx.beginPath(); if (cur.kind === 'rect') ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)); else ctx.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2); }, true);
    } else if (cur.kind === 'brush' && cursor) {
      outline(ctx, () => { ctx.beginPath(); ctx.arc(cursor[0], cursor[1], Math.max(2, brushR() * sc), 0, Math.PI * 2); }, false);
    }
  }

  // ------------------------------------------------------------ UI
  function setHeader() {
    if (S.phase === 'busy') ed.setActions([Btn(t('취소', 'Cancel'), 'text', cancelJob)]);
    else if (S.phase === 'review') ed.setActions([IconBtn('x', t('버리기', 'Discard'), () => discardReview(true)), Btn(t('적용', 'Apply'), 'filled', applyReview, 'check')]);
    else ed.setActions([Btn(t('AI로 수정', 'Run AI'), 'filled', () => onGenerate(false), 'sparkle'), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  }
  function renderAll() { if (closed) return; setHeader(); renderBody(); redraw(); }

  function renderBody() {
    if (closed) return;
    body.replaceChildren();
    undoBtn = invBtn = clrBtn = promptEl = null;
    if (S.phase === 'busy') { renderBusy(); return; }
    if (S.phase === 'review') { renderReview(); return; }
    ed.setPeek(S.tab === 'select');
    const tabs = Segmented({ label: t('단계', 'Step'), items: [{ id: 'select', label: t('영역 선택', 'Select area') }, { id: 'ask', label: t('AI 요청', 'Ask AI') }], value: S.tab, onChange: (v) => { S.tab = v; renderBody(); } });
    body.append(tabs.el);
    if (!bridge.ai.available()) body.append(note(t('AI 요청은 앱(APK)에서만 쓸 수 있어요. 영역 선택은 미리 해 볼 수 있어요.', 'AI requests work only in the app (APK). You can still try the selection tools.')));
    if (S.tab === 'select') renderSelect(); else renderAsk();
    syncButtons();
  }

  function renderSelect() {
    const shapeSeg = Segmented({ label: t('선택 방식', 'Selection tool'), items: [{ id: 'lasso', label: t('올가미', 'Lasso') }, { id: 'brush', label: t('브러시', 'Brush') }, { id: 'rect', label: t('사각형', 'Rect') }, { id: 'ellipse', label: t('원형', 'Ellipse') }], value: S.shape, onChange: (v) => { S.shape = v; renderBody(); } });
    const modeSeg = Segmented({ label: t('모드', 'Mode'), items: [{ id: 'add', label: t('추가', 'Add') }, { id: 'sub', label: t('빼기', 'Subtract') }], value: S.mode, onChange: (v) => { S.mode = v; } });
    undoBtn = IconBtn('undo-2', t('선택 되돌리기', 'Undo selection'), doUndo);
    invBtn = IconBtn('eclipse', t('선택 반전', 'Invert selection'), doInvert);
    clrBtn = IconBtn('trash-2', t('선택 해제', 'Clear selection'), doClear);
    body.append(shapeSeg.el, h('div', { class: 'row' }, modeSeg.el, h('div', { class: 'grow' }), undoBtn, invBtn, clrBtn));
    if (S.shape === 'brush') body.append(Slider({ label: t('브러시 크기', 'Brush size'), min: 2, max: 60, value: S.brush, def: 14, bipolar: false, onInput: (v) => { S.brush = v; } }).el);
    const help = { lasso: t('수정할 부분을 손가락으로 빙 둘러 그리세요. 손을 떼면 자동으로 닫혀요. 두 손가락으로 확대·이동할 수 있어요.', 'Draw around the part to edit. It closes when you lift your finger. Pinch to zoom and pan.'),
      brush: t('수정할 부분을 칠하세요. 잘못 칠했다면 ‘빼기’로 지울 수 있어요.', 'Paint the part to edit. Use Subtract to erase mistakes.'),
      rect: t('끌어서 사각형 영역을 만들어요.', 'Drag to make a rectangle.'), ellipse: t('끌어서 원형 영역을 만들어요.', 'Drag to make an ellipse.') };
    body.append(note(help[S.shape]),
      Slider({ label: t('영역 넓히기/좁히기', 'Grow / shrink'), min: -30, max: 30, value: S.grow, def: 0, onInput: (v) => { S.grow = v; growRaf(); } }).el,
      Slider({ label: t('경계 부드럽게', 'Edge softness'), min: 0, max: 100, value: cfg.feather, def: 30, bipolar: false, onInput: (v) => { cfg.feather = v; }, onChange: save }).el,
      Btn(t('다음: AI 요청', 'Next: ask AI'), 'tonal', () => { S.tab = 'ask'; renderBody(); }, 'chevron-right'));
  }

  function renderAsk() {
    promptEl = h('textarea', { class: 'field ai-prompt', rows: 3, maxlength: 1000, placeholder: t('예: 셔츠를 파란색으로 바꿔 주세요 / 이 물체를 지워 주세요', 'e.g. Make the shirt blue / Remove this object'), 'aria-label': t('AI에게 요청할 내용', 'What should the AI do?') });
    promptEl.value = S.prompt;
    promptEl.addEventListener('input', () => { S.prompt = promptEl.value; });
    const P = prov();
    const M = modelProfile(P.id, currentModel(P), pcfg(cfg, P.id));
    const list = (M.mode === 'generate' || P.id === 'huggingface') ? GEN_PRESETS : PRESETS; // FLUX Fill 은 "채울 내용"을 설명한다
    const presets = Chips({ label: t('예시 문구', 'Examples'), items: list.map((p) => ({ id: p.id, label: t(p.ko, p.en) })), onSelect: (id) => { const p = list.find((x) => x.id === id); S.prompt = t(p.pko, p.pen); promptEl.value = S.prompt; promptEl.focus(); } });
    const ctx = Segmented({ label: t('주변 포함', 'Context'), items: [{ id: '0', label: t('좁게', 'Tight') }, { id: '1', label: t('보통', 'Normal') }, { id: '2', label: t('넓게', 'Wide') }], value: String(cfg.ctx), onChange: (v) => { cfg.ctx = +v; save(); } });
    const openSet = (pid) => openAiSettings(ed.app, { provider: pid, onClose: renderBody });
    if (S.msg) body.append(...[h('p', { class: 'ai-msg err', role: 'alert' }, S.msg.text), S.msg.settings ? Btn(t('AI 설정 열기', 'Open AI settings'), 'tonal', () => openSet(P.id), 'key-round') : null].filter(Boolean)); // (null 을 그대로 append 하면 글자 "null" 이 붙는다)
    if (bridge.ai.available() && !providerReady(P.id)) {
      body.append(h('div', { class: 'ai-setup' }, note(t(`${P.short} 키를 설정하면 바로 쓸 수 있어요.`, `Set up your ${P.short} key to use it.`)),
        h('div', { class: 'row wrap' }, Btn(t('키 설정', 'Set up key'), 'tonal', () => openSet(P.id), 'key-round'))));
    }
    body.append(h('div', { class: 'row wrap', style: { justifyContent: 'space-between' } }, h('span', { class: 'sheet-note' }, t('제공자: ', 'Provider: ') + P.short + ' · ' + P.tag()), Btn(t('바꾸기', 'Change'), 'text', () => openSet(P.id))));
    if (P.canFill) { // Cloudflare(모델로) · Gemini(설정 mode 로): 사진 보고 편집 / 문구로 채우기
      body.append(Segmented({ label: t('방식', 'Mode'), items: [{ id: 'edit', label: t('사진 보고 편집', 'Edit with photo') }, { id: 'generate', label: t('문구로 채우기', 'Fill from prompt') }], value: M.mode,
        onChange: (v) => { const pc = pcfg(cfg, P.id); if (P.id === 'cloudflare') { if (v === 'generate') { pc.model = P.generateModel; pc.custom = P.generateModel; } else { pc.model = MODEL_AUTO; } } else pc.mode = v; save(); renderBody(); } }).el);
      if (M.mode === 'generate') body.append(note(t(`이 방식은 사진을 보지 않고 문구만으로 그려요. 선택 안쪽에 들어갈 내용을 설명해 주세요(예: 맑은 하늘, 잔디밭). ${P.id === 'cloudflare' ? '한국어는 영어로 번역해서 보내요. ' : ''}사진은 전송되지 않아요.`, `This mode never sees your photo: it paints from the prompt alone. Describe what should appear inside the selection (e.g. clear sky, grass). ${P.id === 'cloudflare' ? 'Korean is translated to English first. ' : ''}No photo is sent.`)));
    }
    if (P.id === 'huggingface') body.append(note(t('FLUX.1 Fill 은 선택(마스크) 안쪽만 새로 그리는 모델이에요. “무엇으로 채울지”를 영어로 적어 주세요(예: a clear blue sky). “셔츠를 파랗게” 같은 고치기 지시는 잘 안 맞아요. 비상업 라이선스 모델이에요.', 'FLUX.1 Fill repaints only inside the selection (mask). Say what should fill it, in English (e.g. a clear blue sky). Edit instructions like "make the shirt blue" fit it poorly. Non-commercial license.')));
    if (P.id === 'modelscope') body.append(note(t('편집할 곳을 마젠타로 표시한 사진 1장과 문구를 보내요(Qwen-Image-Edit). 요청 형식은 공개 예제 기준이라 서버가 거부하면 그 사유가 그대로 보여요.', 'Sends one photo with the edit area marked in magenta plus your prompt (Qwen-Image-Edit). The format follows public examples; if the server refuses it, its reason is shown as-is.')));
    body.append(promptEl, presets.el);
    body.append(sec(t('주변 포함 (넓을수록 어울리게 만들지만 결과가 덜 선명할 수 있어요)', 'Context (wider blends better but may look softer)')), ctx.el,
      note(M.mode === 'generate' ? t('결과는 선택 안쪽에만 합쳐져요. 사진과 무관하게 그려서 밝기·색이 어긋날 수 있어요. 마음에 안 들면 “다시 생성”을 눌러 보세요.', 'The result is blended only inside your selection. It is painted without seeing the photo, so lighting may not match; try "Regenerate".')
        : t('선택 영역과 주변(편집할 곳을 마젠타로 표시한 사본 포함)만 전송하고, 결과는 선택 안쪽에만 합쳐져요. 무료 모델은 결과가 들쭉날쭉할 수 있어요. 마음에 안 들면 “다시 생성”을 눌러 보세요.', 'Only the selected area and its surroundings (plus a copy with the edit area marked in magenta) are sent, and the result is blended only inside your selection. Free models can be hit-or-miss; try "Regenerate".')),
      Btn(t('AI 설정', 'AI settings'), 'text', () => openSet(P.id), 'key-round'));
  }

  // ------------------------------------------------------------ 진행 중 / 결과
  const PHASE = () => ({ translate: t('영어로 번역 중…', 'Translating to English…'), prepare: t('이미지 준비 중…', 'Preparing image…'), upload: t('서버로 보내는 중…', 'Uploading…'), wait: t('AI가 작업 중…', 'AI is working…'), download: t('결과 이미지를 받는 중…', 'Downloading the result…'), finish: t('결과를 합치는 중…', 'Blending the result…') });
  let phaseEl = null;
  function updatePhase() {
    if (!phaseEl || !job) return;
    const secs = Math.round((performance.now() - job.t0) / 1000);
    phaseEl.textContent = (PHASE()[job.phase] || '') + ' ' + secs + t('초', 's');
  }
  function renderBusy() {
    ed.setPeek(false);
    phaseEl = h('div', { class: 'ai-phase num', 'aria-live': 'polite' });
    const box = h('div', { class: 'ai-busy' }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('AI 작업 중', 'AI working') }), phaseEl);
    body.append(box);
    if (job && job.prep && !job.prep.noPhoto) body.append(sentBox(job.prep));
    body.append(note(job && job.prep && job.prep.noPhoto ? t('보통 5~30초 걸려요. 이 화면을 벗어나지 말고 기다려 주세요. 사진은 보내지 않고 문구만 전송했어요.', 'Usually 5–30 seconds. Please stay on this screen. No photo was sent, only your prompt.') : t('보통 10~60초 걸려요. 이 화면을 벗어나지 말고 기다려 주세요. 선택한 영역과 주변만 전송했어요.', 'Usually 10–60 seconds. Please stay on this screen. Only the selected area and its surroundings were sent.')));
    updatePhase();
  }
  function sentBox(prep) {
    const cv = sentPreview(prep, 200);
    cv.className = 'ai-sent';
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', t('AI에 보낸 이미지 미리보기 (파란색이 수정 영역)', 'Preview of what was sent to the AI (blue = edit area)'));
    return h('div', { class: 'ai-sentbox' }, cv, h('span', { class: 'sheet-note' }, t('보낸 이미지 (파란색 = 수정 영역)', 'Sent image (blue = edit area)')));
  }
  function startTimer() { stopTimer(); timer = setInterval(updatePhase, 400); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = 0; } }
  function cancelJob() { if (job) { job.ctl.abort(); } }

  function variantThumb(v) {
    const { prep } = review;
    const c = document.createElement('canvas');
    const k = Math.min(1, 128 / Math.max(prep.fit.w, prep.fit.h));
    c.width = Math.max(1, Math.round(prep.fit.w * k)); c.height = Math.max(1, Math.round(prep.fit.h * k));
    const x = c.getContext('2d');
    x.drawImage(prep.preview, prep.fit.x, prep.fit.y, prep.fit.w, prep.fit.h, 0, 0, c.width, c.height);
    x.drawImage(v.cv, 0, 0, c.width, c.height);
    return c;
  }
  function renderReview() {
    ed.setPeek(false);
    const vs = review.variants;
    body.append(note(t('결과를 확인하세요. 위쪽 ‘원본 보기’ 버튼을 누르고 있으면 비교할 수 있어요.', 'Check the result. Hold the “View original” button above to compare.')));
    if (vs.length > 1) {
      const row = h('div', { class: 'thumbs', role: 'radiogroup', 'aria-label': t('생성된 결과', 'Generated results') });
      vs.forEach((v, i) => {
        const b = h('button', { class: 'thumb', type: 'button', role: 'radio', 'aria-checked': String(i === S.variant), 'aria-label': t('결과 ', 'Result ') + (i + 1) }, variantThumb(v), h('span', { class: 'tl' }, String(i + 1)), h('span', { class: 'tchk' }, icon('check')));
        b.addEventListener('click', () => { S.variant = i; previewVariant(); renderBody(); });
        row.append(b);
      });
      body.append(row);
    }
    body.append(Slider({ label: t('적용 강도', 'Strength'), min: 0, max: 100, value: Math.round(review.opacity * 100), def: 100, unit: '%', bipolar: false, onInput: (v) => { review.opacity = v / 100; previewVariant(); } }).el,
      h('div', { class: 'row wrap' }, Btn(t('다시 생성', 'Regenerate'), 'outlined', regenerate, 'refresh-cw'), Btn(t('영역·문구 고치기', 'Edit area / prompt'), 'outlined', () => discardReview(true), 'lasso-select')));
  }
  function previewVariant() {
    if (!review || closed) return;
    const v = review.variants[S.variant];
    const p = review.prep.place;
    const layer = { id: review.layerId, t: 'image', asset: v.key, x: p.x, y: p.y, w: p.w, rot: 0, opacity: review.opacity, lock: true, ai: { prompt: S.prompt.slice(0, 200), model: review.model, provider: review.provider, mode: review.mode, ts: Date.now() } };
    ed.preview((d) => setIn(d, 'layers', [...d.layers, layer]));
  }
  function dropVariants() { if (review) { review.variants.forEach((v) => ed.dropAsset(v.key)); } }
  function applyReview() {
    if (!review) return;
    const v = review.variants[S.variant];
    previewVariant();
    ed.commit(t('AI 수정', 'AI edit'));
    try { v.cv.toBlob((b) => { if (b) Drafts.put('asset:' + v.key, b); }, 'image/png'); } catch (e) { /* 자동 복구만 못 함 */ }
    review.variants.forEach((x, i) => { if (i !== S.variant) ed.dropAsset(x.key); });
    review = null; ed.sel = null;
    resetSelection();
    S.phase = 'select'; S.tab = 'select'; S.msg = null;
    renderAll();
    toast(t('AI 수정을 적용했어요. 레이어 목록에서 끄거나 지울 수 있어요.', 'AI edit applied. You can hide or delete it from Layers.'));
  }
  function discardReview(toSelect) {
    if (!review) return;
    ed.store.revert();
    dropVariants();
    review = null;
    S.phase = 'select'; S.tab = toSelect ? 'select' : 'ask';
    renderAll();
  }
  function regenerate() { if (review) { ed.store.revert(); dropVariants(); review = null; } S.phase = 'select'; onGenerate(true); }

  async function onGenerate(skipChecks) {
    S.msg = null;
    if (S.phase !== 'select') return;
    if (!selBox()) { toast(t('먼저 수정할 영역을 선택해 주세요', 'Select an area first')); S.tab = 'select'; renderBody(); return; }
    if (!S.prompt.trim()) { toast(t('어떻게 바꿀지 적어 주세요', 'Describe the change first')); S.tab = 'ask'; renderBody(); if (promptEl) promptEl.focus(); return; }
    if (!bridge.ai.available()) { toast(t('AI 요청은 앱(APK)에서만 쓸 수 있어요', 'AI requests work only in the app (APK)')); return; }
    const P = prov();
    if (!providerReady(P.id)) { S.tab = 'ask'; renderBody(); openAiSettings(ed.app, { provider: P.id, onClose: renderBody }); return; }
    void skipChecks;
    if (!(await ensureConsent(ed.app, P, modelProfile(P.id, currentModel(P), pcfg(cfg, P.id)).noPhoto))) return;
    if (closed) return;
    runJob();
  }

  async function runJob() {
    ed.store.revert(); // 이전 미리보기(결과 레이어)가 요청 이미지에 섞이지 않게
    const P = prov();
    const ctl = new AbortController();
    job = { ctl, t0: performance.now(), phase: 'prepare', prep: null };
    S.phase = 'busy'; renderAll(); startTimer();
    bridge.keepScreenOn(true); // 기다리는 동안 화면이 꺼져 앱이 멈추지 않게
    bridge.ai.keepAlive(true, t('AI 수정 결과를 기다리는 중이에요. 앱을 나가도 계속돼요.', 'Waiting for the AI edit. It keeps going if you leave the app.')); // 앱을 백그라운드로 보내도 이어지게(진행 중 알림)
    let finished = '';
    let variants = [];
    try {
      const model = await resolveModel(ed.app, P.id);
      const M = modelProfile(P.id, model, pcfg(cfg, P.id)); // edit: 사진을 보고 고침 / generate: 문구만으로 그림(사진 미전송)
      const gen = M.mode === 'generate';
      if (ctl.signal.aborted) throw new AiError({ code: 'cancelled' });
      const prep = await prepareRequest(ed, { mask: eff, w: mw, h: mh }, { ctx: gen ? 0 : cfg.ctx, feather: cfg.feather, provider: M });
      if (ctl.signal.aborted || closed) throw new AiError({ code: 'cancelled' });
      job.prep = prep; renderBody();
      const onPhase = (p) => { if (job) job.phase = p; };
      let blobs;
      if (gen) {
        let text = S.prompt;
        if (P.id === 'cloudflare' && cfg.translate !== false) { job.phase = 'translate'; text = (await translateToEnglish(S.prompt, { signal: ctl.signal })).text; } // 번역은 Cloudflare 만(문구를 다른 곳으로 더 보내지 않는다)
        blobs = await P.generate({ model, prompt: text, size: prep.size }, { signal: ctl.signal, onPhase });
      } else {
        const req = await P.buildEdit({ model, prompt: S.prompt, size: prep.size }, { image: prep.imageBlob, marked: prep.markedBlob, mask: prep.maskBlob });
        blobs = await P.edit(req, { signal: ctl.signal, onPhase });
      }
      if (job) job.phase = 'finish';
      updatePhase();
      for (const b of blobs) { const cv = await makePatch(b, prep, { feather: cfg.feather, tone: gen ? false : cfg.tone, cover: gen }); variants.push({ cv, key: ed.addCanvasAsset(cv) }); }
      if (ctl.signal.aborted || closed) throw new AiError({ code: 'cancelled' });
      review = { prep, variants, model, provider: P.id, mode: M.mode, layerId: uid(), opacity: 1 };
      variants = [];
      S.variant = 0; S.phase = 'review'; job = null; stopTimer();
      previewVariant(); renderAll();
      finished = 'ok';
    } catch (e) {
      variants.forEach((v) => ed.dropAsset(v.key));
      job = null; stopTimer();
      if (closed) return;
      S.phase = 'select'; S.tab = 'ask';
      const info = e instanceof AiError ? e.info : { code: 'other', message: String((e && e.message) || e) };
      if (!(e instanceof AiError)) console.error(e);
      if (info.code === 'cancelled') S.msg = null;
      else { S.msg = explainError(info); finished = 'fail'; }
      renderAll();
      if (S.msg) toast(S.msg.text);
    } finally {
      bridge.keepScreenOn(false);
      bridge.ai.keepAlive(false);
      if (finished === 'ok') bridge.ai.notify('ImageFix', t('AI 수정 결과가 준비됐어요. 눌러서 확인하고 적용하세요.', 'Your AI edit is ready. Tap to review and apply it.'));
      else if (finished === 'fail') bridge.ai.notify('ImageFix', t('AI 수정에 실패했어요. 눌러서 확인하세요.', 'The AI edit failed. Tap to see why.'));
    }
  }

  ed.setPeek(true);
  setHeader();
  renderBody();
  return {
    pointer, drawOverlay, hideFrame: true,
    /** 테스트/디버그용: 현재 유효 선택 마스크 */
    selection() { return { w: mw, h: mh, mask: eff, phase: S.phase, tab: S.tab, msg: S.msg ? S.msg.key : null }; },
    refresh() { if (closed) return; if (S.phase === 'review') { dropVariants(); review = null; S.phase = 'select'; S.tab = 'select'; } renderAll(); },
    apply() { if (S.phase === 'review') applyReview(); else if (S.phase === 'busy') cancelJob(); },
    cancel() { if (S.phase === 'review') discardReview(false); else if (S.phase === 'busy') cancelJob(); },
    close() { closed = true; stopTimer(); cancelJob(); if (review) { ed.store.revert(); dropVariants(); review = null; } },
  };
}
