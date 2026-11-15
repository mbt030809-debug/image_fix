// 에디터: 상단 바 / 캔버스 / 도킹 시트 / 도구 스트립 + 렌더 스케줄링 + 레이어 관리 + 내보내기
import { h, icon, clear } from './ui/dom.js';
import { t } from './i18n.js';
import { Store, newDoc, setIn, uid } from './store.js';
import { View } from './view.js';
import { IconBtn, Btn, toast, confirmDialog, openModal, handleBack, Segmented, Slider, Chips } from './ui/components.js';
import { orientedSize } from './engine/geometry.js';
import { makeGeom, composeDoc, drawLayers, drawBackground, applyFrame, frameLayout, fontCss, fontEvents } from './compose.js';
import { bridge } from './bridge.js';
import { TOOLS, GROUPS, TOOL_BY_ID, groupOf } from './tools/index.js';
import * as Drafts from './drafts.js';

const PIX_KEYS = ['geo', 'retouch', 'adj', 'filter', 'fx', 'locals', 'lutRef'];

export function docForRender(doc) {
  return { geo: doc.geo, retouch: doc.retouch, adj: doc.adj, filter: doc.filter, fx: doc.fx, locals: doc.locals, lutRef: doc.lutRef };
}

export function doc0Out(ed) { return ed.store.get().out; }

export class Editor {
  constructor(app) {
    this.app = app;
    this.engine = app.engine;
    this.assets = new Map();
    this.store = new Store(newDoc());
    this.tool = null; this.toolId = null;
    this.sel = null;
    this.base = null; this.baseCanvas = document.createElement('canvas');
    this.logical = { pw: 1, ph: 1 };
    this.fileName = 'image';
    this.hist = null;
    this.showOriginal = false;
    this.origCache = null;
    this.busy = false; this.again = false; this.wantQuality = 'full';
    this.lastPix = null;
    this.previewSide = 1600;
    this.cropOverride = null;
    this.build();
    this.store.on((k) => this.onStore(k));
    this.sourceBlob = null;
    fontEvents.onChange = () => this.paint();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flushDraft(); });
  }

  // ------------------------------------------------------------ UI 구성
  build() {
    this.undoBtn = IconBtn('undo-2', t('실행 취소', 'Undo'), () => this.undo());
    this.redoBtn = IconBtn('redo-2', t('다시 실행', 'Redo'), () => this.redo());
    this.cmpBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('원본 보기', 'View original'), 'aria-pressed': 'false', title: t('원본 보기 (누르고 있기)', 'View original (hold)') }, icon('columns-2'));
    this.bindCompare();
    this.saveBtn = h('button', { class: 'btn filled', type: 'button' }, t('저장', 'Save'));
    this.saveBtn.addEventListener('click', () => this.openExport());
    this.closeBtn = IconBtn('x', t('닫기', 'Close'), () => this.requestClose());
    this.topbar = h('div', { class: 'topbar' }, this.closeBtn, this.undoBtn, this.redoBtn, this.cmpBtn, h('div', { class: 'spacer' }), this.saveBtn);

    this.stage = h('div', { class: 'stage' });
    this.view = new View(this.stage);
    this.view.photo.setAttribute('aria-label', t('편집 중인 사진', 'Photo being edited'));
    this.zoomChip = h('button', { class: 'zoomchip num', type: 'button', 'aria-label': t('확대/축소', 'Zoom') }, t('맞춤', 'Fit'));
    this.zoomChip.addEventListener('click', () => { this.view.cycleZoom(); });
    this.badge = h('div', { class: 'badge', hidden: true }, t('원본', 'Original'));
    this.loadingEl = h('div', { class: 'loading', hidden: true }, h('div', { class: 'spinner', role: 'progressbar', 'aria-label': t('불러오는 중…', 'Loading…') }));
    this.stats = h('div', { class: 'statusline num', hidden: true });
    this.live = h('div', { class: 'sr-only', 'aria-live': 'polite' });
    this.stage.append(this.zoomChip, this.badge, this.loadingEl, this.stats, this.live);
    this.view.onView = () => { this.updateZoomChip(); this.drawOverlay(); };
    this.view.onResize = () => this.drawOverlay();

    // 시트 (위쪽 손잡이를 잡고 위아래로 끌면 높이가 바뀐다 — initSheetResize)
    this.sheetTitle = h('h2', { id: 'sheet-title' });
    this.sheetActions = h('div', { class: 'row', style: { gap: '0' } });
    this.grab = h('div', { class: 'sheet-grab', role: 'button', tabIndex: 0, 'aria-label': t('패널 크기 조절: 위아래로 끌기 · 누르면 접기/펼치기', 'Resize panel: drag up/down · tap to collapse/expand') });
    this.sheetHead = h('div', { class: 'sheet-head' }, this.sheetTitle, this.sheetActions);
    this.sheetBody = h('div', { class: 'sheet-body' });
    this.sheetEl = h('div', { class: 'sheet', hidden: true, role: 'tabpanel', 'aria-labelledby': 'sheet-title' }, this.grab, this.sheetHead, this.sheetBody);

    // 도구 줄: 아래 = 상위 목록(분류) / 그 위 = 선택한 분류의 하위 목록(subrow). 분류를 누르면 하위 목록이 뜨고, 하위를 누르면 패널이 열린다.
    this.strip = h('div', { class: 'strip groups', role: 'tablist', 'aria-label': t('도구 분류', 'Tool groups') });
    this.subrow = h('div', { class: 'subrow', role: 'tablist', 'aria-label': t('도구', 'Tools'), hidden: true });
    this.groupBtns = new Map();   // 분류 id → 버튼
    this.toolBtns = new Map();    // 도구 id → 버튼(하위 버튼, 단독 분류는 분류 버튼) — 선택 표시용
    this.subBtns = new Map();     // 하위 항목 id → 버튼(도구 + 동작)
    this.groupId = null;
    for (const g of GROUPS) {
      const b = h('button', { class: 'tool', type: 'button', role: 'tab', 'aria-selected': 'false', 'data-group': g.id }, h('span', { class: 'pill' }, icon(g.icon)), h('span', { class: 'lbl' }, g.label()));
      this.groupBtns.set(g.id, b); this.strip.append(b);
      if (g.direct) { // 하위 없이 바로 도구가 열린다(레이어)
        const id = g.items[0];
        b.dataset.tool = id;
        b.addEventListener('click', () => this.toggleTool(id));
        this.toolBtns.set(id, b);
        continue;
      }
      b.addEventListener('click', () => this.toggleGroup(g.id));
      for (const id of g.items) {
        const def = TOOL_BY_ID[id];
        const sb = h('button', { class: 'subtool', type: 'button', role: 'tab', 'aria-selected': 'false' }, icon(def.icon), h('span', { class: 'lbl' }, def.label()));
        if (def.run) { sb.dataset.action = id; sb.addEventListener('click', () => def.run(this)); } // 창을 여는 동작(AI 이미지 만들기/설정)
        else { sb.dataset.tool = id; sb.addEventListener('click', () => this.toggleTool(id)); this.toolBtns.set(id, sb); }
        this.subBtns.set(id, sb);
      }
    }
    const arrows = (row) => (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const arr = [...row.querySelectorAll('button')], i = arr.indexOf(document.activeElement);
      if (i < 0) return;
      arr[(i + (e.key === 'ArrowRight' ? 1 : arr.length - 1)) % arr.length].focus(); e.preventDefault();
    };
    this.strip.addEventListener('keydown', arrows(this.strip));
    this.subrow.addEventListener('keydown', arrows(this.subrow));

    this.el = h('div', { class: 'editor ed' }, this.topbar, this.stage, this.sheetEl, this.subrow, this.strip);
    this.initSheetResize();
    this.updateButtons();
  }

  // ------------------------------------------------------------ 패널(시트) 높이 조절
  /** 손잡이(—)나 제목 줄을 잡고 위아래로 끌면 패널 높이가 바뀐다. 도구마다 기억(편집기 높이 대비 비율). 누르면 기존처럼 접기/펼치기(기억한 높이는 지움) */
  initSheetResize() {
    const THRESH = 6, STEP = 24;
    const rail = () => window.matchMedia('(orientation: landscape) and (max-height: 500px), (min-width: 840px)').matches; // 가로/태블릿: 옆 패널(크기 고정)
    this._rail = rail;
    let drag = null;
    const onDown = (e) => {
      if (rail() || (e.button != null && e.button > 0)) return;
      if (e.target.closest && e.target.closest('button, input, select, textarea, a, label, [role="slider"]')) return;
      drag = { id: e.pointerId, y0: e.clientY, h0: this.sheetEl.getBoundingClientRect().height, b: null, active: false, el: e.currentTarget };
      this._sheetMoved = false;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* noop */ } // 마우스는 빠르게 움직이면 손잡이 밖으로 나가므로 처음부터 붙잡는다(터치는 자동)
    };
    const onMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dy = drag.y0 - e.clientY;
      if (!drag.active) {
        if (Math.abs(dy) < THRESH) return;
        drag.active = true; this._sheetMoved = true;
        drag.b = this.sheetBounds();
        this.el.classList.add('sizing');
      }
      e.preventDefault();
      this.setSheetHeight(drag.h0 + dy, drag.b);
    };
    const onUp = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const d = drag; drag = null;
      try { d.el.releasePointerCapture(d.id); } catch (err) { /* noop */ }
      this.el.classList.remove('sizing');
      if (!d.active) return;
      const cur = this.sheetEl.getBoundingClientRect().height;
      if (cur < d.b.min + 28) this.setSheetHeight(d.b.min, d.b); // 거의 다 내렸으면 접힘(머리말만)으로
      this.rememberSheet();
      this.afterLayout();
    };
    for (const el of [this.grab, this.sheetHead]) {
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
      el.addEventListener('lostpointercapture', onUp); // 창 밖에서 손을 떼도 끝낸다
    }
    this.grab.addEventListener('click', () => {
      if (this._sheetMoved) { this._sheetMoved = false; return; } // 끌고 난 뒤의 click 은 무시
      this.forgetSheet(); this.togglePeek();
    });
    this.grab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.grab.click(); return; }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (rail()) return;
      this.setSheetHeight(this.sheetEl.getBoundingClientRect().height + (e.key === 'ArrowUp' ? STEP : -STEP));
      this.rememberSheet(); this.afterLayout();
    });
    // 편집기 크기(회전·키보드)가 바뀌면 기억한 비율로 다시 맞춘다
    new ResizeObserver(() => { this.syncSubrowVar(); if (this.sheetEl.classList.contains('sized') && !this.el.classList.contains('sizing')) this.applySheetPref(); }).observe(this.el);
  }

  /** 시트 높이 한계: 접힘(손잡이+제목 줄) ~ 편집기 − 위/아래 막대 − 최소 사진 영역 */
  sheetBounds() {
    const eh = this.el.clientHeight || window.innerHeight;
    const vis = (el) => (el.hidden ? 0 : el.offsetHeight);
    const fixed = this.topbar.offsetHeight + vis(this.subrow) + this.strip.offsetHeight;
    const bs = getComputedStyle(this.sheetBody);
    const min = this.grab.offsetHeight + this.sheetHead.offsetHeight + (parseFloat(bs.paddingTop) || 0) + (parseFloat(bs.paddingBottom) || 0); // 접힘: 손잡이 + 제목 줄(+ 본문 안쪽 여백)
    const stageMin = Math.max(120, Math.round(eh * 0.16));
    return { eh, min, max: Math.max(min + 40, eh - fixed - stageMin), stageMin };
  }

  /** 높이(px)를 적용. 낮으면 간단 모드(peek), 충분히 크면 전체 목록 모드로 도구 내용을 바꾼다(이력 현상 12px) */
  setSheetHeight(px, b = this.sheetBounds()) {
    const hh = Math.round(Math.max(b.min, Math.min(b.max, px)));
    this.sheetEl.style.setProperty('--sheet-h', hh + 'px');
    this.sheetEl.classList.add('sized');
    this.el.style.setProperty('--stage-min', b.stageMin + 'px');
    const fullAt = Math.max(280, b.eh * 0.34);
    const wantPeek = this.peek ? !(hh >= fullAt + 12) : (hh <= fullAt - 12);
    if (wantPeek !== !!this.peek) { this.setPeek(wantPeek); if (this.tool && this.tool.onPeek) this.tool.onPeek(wantPeek); }
    return hh;
  }

  clearSheetHeight() {
    this.sheetEl.classList.remove('sized');
    this.sheetEl.style.removeProperty('--sheet-h');
    this.el.style.removeProperty('--stage-min');
  }

  /** 현재 도구의 높이를 비율로 기억(설정에 저장) */
  rememberSheet() {
    if (!this.toolId || !this.sheetEl.classList.contains('sized')) return;
    const b = this.sheetBounds();
    const m = this.app.settings.sheetH && typeof this.app.settings.sheetH === 'object' ? this.app.settings.sheetH : (this.app.settings.sheetH = {});
    m[this.toolId] = Math.round((this.sheetEl.getBoundingClientRect().height / b.eh) * 1000) / 1000;
    this.app.saveSettings();
  }

  /** 현재 도구의 기억한 높이를 지우고 기본 크기로 */
  forgetSheet() {
    const m = this.app.settings.sheetH;
    if (this.toolId && m && typeof m === 'object' && this.toolId in m) { delete m[this.toolId]; this.app.saveSettings(); }
    this.clearSheetHeight();
  }

  /** 도구를 열 때: 기억한 높이가 있으면 적용(가로/태블릿은 제외) */
  applySheetPref() {
    const m = this.app.settings.sheetH;
    const r = this.toolId && m && typeof m === 'object' ? Number(m[this.toolId]) : 0;
    if (!(r > 0.05 && r < 0.95) || this._rail()) { this.clearSheetHeight(); return; }
    const b = this.sheetBounds();
    this.setSheetHeight(r * b.eh, b);
  }

  // ------------------------------------------------------------ 상위/하위 목록
  /** 상위 목록 누르기: 하위 목록을 펼친다(같은 걸 다시 누르면 접고 열린 도구도 닫는다). 다른 분류의 도구가 열려 있으면 닫는다 */
  toggleGroup(gid) {
    const g = GROUPS.find((x) => x.id === gid);
    if (!g) return;
    if (this.groupId === gid) { this.closeTool(true); this.setGroup(null); return; }
    if (this.tool && groupOf(this.toolId) !== gid) this.closeTool(true);
    this.setGroup(gid);
  }

  /** 펼친 분류 지정(null = 모두 접힘). 단독 분류(레이어)는 하위 목록을 띄우지 않는다 */
  setGroup(gid) {
    const g = GROUPS.find((x) => x.id === gid) || null;
    this.groupId = g ? g.id : null;
    for (const [id, b] of this.groupBtns) b.setAttribute('aria-selected', String(!!g && id === g.id));
    if (g && !g.direct) {
      this.subrow.replaceChildren(...g.items.map((id) => this.subBtns.get(id)));
      this.subrow.classList.toggle('dense', g.items.length >= 5);
      this.subrow.hidden = false;
    } else {
      this.subrow.hidden = true;
    }
    if (this.sheetEl.classList.contains('sized')) this.applySheetPref(); // 막대 높이가 바뀌면 한계도 바뀐다
    this.syncSubrowVar();
    this.afterLayout();
  }

  /** 하위 목록(세로 폰 화면에서 하단 줄 바로 위) 높이를 CSS 변수로 알려, 알림(토스트)이 그 위에 뜨게 한다(하위 버튼을 가리지 않도록) */
  syncSubrowVar() {
    const hh = !this.subrow.hidden && !(this._rail && this._rail()) ? this.subrow.offsetHeight : 0;
    document.documentElement.style.setProperty('--subrow-h', hh + 'px');
  }

  /** 도구/분류를 모두 닫는다(새 사진을 열거나 홈으로 갈 때) */
  closeAll() { this.closeTool(false); this.setGroup(null); }

  bindCompare() {
    let t0 = 0, held = false;
    const on = () => { this.setOriginal(true); };
    const off = () => { this.setOriginal(false); };
    this.cmpBtn.addEventListener('pointerdown', (e) => { t0 = performance.now(); held = false; e.preventDefault(); this.cmpBtn.setPointerCapture(e.pointerId); if (this.cmpBtn.getAttribute('aria-pressed') !== 'true') { on(); } });
    this.cmpBtn.addEventListener('pointerup', () => {
      const dur = performance.now() - t0;
      const pressed = this.cmpBtn.getAttribute('aria-pressed') === 'true';
      if (dur > 350) { held = true; off(); this.cmpBtn.setAttribute('aria-pressed', 'false'); }
      else if (pressed) { off(); this.cmpBtn.setAttribute('aria-pressed', 'false'); }
      else { this.cmpBtn.setAttribute('aria-pressed', 'true'); }
      void held;
    });
    this.cmpBtn.addEventListener('pointercancel', () => { off(); this.cmpBtn.setAttribute('aria-pressed', 'false'); });
    this.cmpBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); const p = this.cmpBtn.getAttribute('aria-pressed') === 'true'; this.cmpBtn.setAttribute('aria-pressed', String(!p)); this.setOriginal(!p); } });
  }

  async setOriginal(on) {
    this.showOriginal = on;
    this.badge.hidden = !on;
    if (on && !this.base) return;
    if (on) {
      const doc = this.store.get();
      const key = JSON.stringify(doc.geo);
      if (!this.origCache || this.origCache.key !== key) {
        const res = await this.engine.render({ geo: doc.geo, retouch: [], adj: {}, filter: { id: 'none' }, fx: [], locals: [] }, { maxSide: this.previewSide, crop: this.cropOverride || undefined });
        const cv = document.createElement('canvas'); cv.width = res.w; cv.height = res.h;
        cv.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
        this.origCache = { key, canvas: cv };
      }
    }
    this.paint();
  }

  // ------------------------------------------------------------ 문서 열기
  async openBitmap(bitmap, name, blob) {
    this.loadingEl.hidden = false;
    this.closeAll();
    this.assets.clear();
    const mem = bridge.info().memMB || 4096;
    const maxSide = this.app.settings.maxSide === 'auto' ? (mem < 3000 ? 3072 : mem < 5000 ? 4096 : 5120) : Number(this.app.settings.maxSide);
    const info = await this.engine.loadBitmap(bitmap, maxSide);
    this.fileName = (name || 'image').replace(/\.[^.]+$/, '');
    this.info = info;
    this.previewSide = this.computePreviewSide();
    this.origCache = null; this.hist = null; this.lastPix = null; this.base = null;
    this.sel = null;
    this.store.reset(newDoc());
    this.setOriginalUI(false);
    this.startDraft(blob);
    this.requestRender('full');
    this.updateButtons();
  }
  async openBuffer(w, h, buffer, name, blob) {
    this.loadingEl.hidden = false;
    this.closeAll();
    this.assets.clear();
    const info = await this.engine.loadBuffer(w, h, buffer);
    this.fileName = name || 'canvas';
    this.info = info;
    this.previewSide = this.computePreviewSide();
    this.origCache = null; this.hist = null; this.lastPix = null; this.base = null; this.sel = null;
    this.store.reset(newDoc());
    this.startDraft(blob);
    this.requestRender('full');
    this.updateButtons();
  }
  setOriginalUI(v) { this.showOriginal = v; this.badge.hidden = !v; this.cmpBtn.setAttribute('aria-pressed', String(v)); }

  // ------------------------------------------------------------ 자동 복구(드래프트)
  startDraft(blob) {
    this.sourceBlob = blob || null;
    this.masks = new Map();
    clearTimeout(this.draftT);
    Drafts.clearAll().then(() => { if (blob) { Drafts.put('src', { blob, name: this.fileName }); this.scheduleDraft(); } });
  }
  scheduleDraft() { clearTimeout(this.draftT); this.draftT = setTimeout(() => this.flushDraft(), 1500); }
  makeThumb() {
    try {
      const src = this.view.photo, k = 120 / Math.max(src.width, src.height);
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.7);
    } catch (e) { return null; }
  }
  async flushDraft() {
    if (!this.sourceBlob || !this.info || !this.base || this.app.screen !== 'editor') return;
    if (!this.store.isDirty() && this.store.revision === 0) return;
    await Drafts.put('doc', { doc: this.store.getBase(), name: this.fileName, ts: Date.now(), thumb: this.makeThumb() });
  }
  /** 저장된 드래프트의 문서/자산을 복원 */
  async restoreDoc(rec, pre) {
    const doc = JSON.parse(JSON.stringify(rec.doc));
    // 사진을 다시 여는 과정이 저장소를 비우므로, 자산은 열기 전에 읽어 둔 것(pre)을 쓰고 다시 저장해 둔다
    const src = pre || await Drafts.readAssets(doc);
    for (const [k, blob] of src.assets) {
      try {
        const bmp = await createImageBitmap(blob);
        this.assets.set(k, { src: bmp, width: bmp.width, height: bmp.height });
        Drafts.put('asset:' + k, blob);
      } catch (e) { /* 건너뜀 */ }
    }
    for (const op of doc.retouch || []) {
      if (op.k === 'cut' || op.k === 'bgblur') {
        const m = src.masks.get(op.mask);
        if (m) { this.masks.set(op.mask, m); Drafts.put('mask:' + op.mask, m); await this.engine.setAsset(op.mask, 'mask', { w: m.w, h: m.h, buffer: m.data.slice().buffer }); }
        else doc.retouch = doc.retouch.filter((o) => o !== op);
      }
    }
    doc.lutRef = null;
    this.store.reset(doc);
    this.store.savedRevision = -1; // 저장되지 않은 상태로 표시
    this.requestRender('full');
    this.scheduleDraft(); // 복원 직후에도 다시 종료되면 이어서 할 수 있게 문서를 바로 다시 저장
  }

  computePreviewSide() {
    const dpr = Math.min(2.75, window.devicePixelRatio || 1);
    const r = this.stage.getBoundingClientRect();
    const mem = bridge.info().memMB || 4096;
    const cap = mem < 3500 ? 1440 : 1920;
    return Math.max(1024, Math.min(cap, Math.round(Math.max(r.width, r.height || 600, 640) * dpr)));
  }

  // ------------------------------------------------------------ 문서 변경 접근자
  doc() { return this.store.get(); }
  preview(fn) { this.store.preview(fn); }
  commit(label) { this.store.commit(label); }
  apply(fn, label) { this.store.apply(fn, label); }
  undo() { if (this.store.undo()) this.afterHistory(); }
  redo() { if (this.store.redo()) this.afterHistory(); }
  afterHistory() {
    if (this.sel && !this.doc().layers.some((l) => l.id === this.sel)) this.sel = null;
    if (this.tool && this.tool.refresh) this.tool.refresh();
    this.announce(t('실행 취소/다시 실행', 'History changed'));
  }
  announce(msg) { this.live.textContent = ''; setTimeout(() => { this.live.textContent = msg; }, 30); }

  onStore(kind) {
    this.updateButtons();
    const doc = this.store.get();
    const last = this.lastPix;
    const changed = !last || PIX_KEYS.some((k) => doc[k] !== last[k]);
    if (changed) this.requestRender(kind === 'preview' ? 'draft' : 'full');
    else this.paint();
    if (kind === 'commit' || kind === 'undo' || kind === 'redo') this.scheduleDraft();
    if (kind === 'preview') {
      clearTimeout(this.idleT);
      this.idleT = setTimeout(() => { if (this.store.get() !== this.store.getBase() || this.base?.draft) this.requestRender('full'); }, 260);
    }
    this.tool && this.tool.onDoc && this.tool.onDoc(kind);
  }

  updateButtons() {
    this.undoBtn.disabled = !this.store.canUndo();
    this.redoBtn.disabled = !this.store.canRedo();
  }

  // ------------------------------------------------------------ 렌더 스케줄
  requestRender(quality = 'full') {
    this.wantQuality = quality; // 가장 최근 요청이 우선 (드래그 중엔 draft, 놓으면 full)
    if (this.busy) { this.again = true; return; }
    this.runRender();
  }

  async runRender() {
    this.busy = true;
    try {
      do {
        this.again = false;
        const q = this.wantQuality;
        const doc = this.store.get();
        this.lastPix = doc;
        const crop = this.cropOverride;
        const side = q === 'draft' ? Math.min(this.previewSide, 960) : this.previewSide;
        const res = await this.engine.render(docForRender(doc), { maxSide: side, crop: crop || undefined, hist: q === 'full' && this.wantHist });
        if (res.hist) { this.hist = res.hist; this.onHist && this.onHist(res.hist); }
        this.setBaseFromResult(res, q, doc);
        if (this.stats && !this.stats.hidden) this.stats.textContent = `${res.w}×${res.h} · ${Math.round(res.ms)}ms · ${q}`;
      } while (this.again);
    } catch (e) {
      console.error(e);
      toast(t('처리 중 오류가 났어요. 다시 시도해 주세요.', 'Something went wrong. Please try again.'));
    } finally {
      this.busy = false;
      this.loadingEl.hidden = true;
    }
  }

  setBaseFromResult(res, quality, doc) {
    const cv = this.baseCanvas;
    if (cv.width !== res.w || cv.height !== res.h) { cv.width = res.w; cv.height = res.h; }
    cv.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    this.base = { w: res.w, h: res.h, draft: quality === 'draft', crop: this.cropOverride || doc.geo.crop };
    if (quality === 'full') this.logical = { pw: res.w, ph: res.h };
    else {
      const p = this.planLogical(doc);
      this.logical = p;
    }
    this.paint();
  }

  /** 풀 퀄리티 미리보기 크기를 메인 스레드에서 계산 (워커 호출 없이) */
  planLogical(doc) {
    const info = this.info;
    const geo = doc.geo, crop = this.cropOverride || geo.crop;
    const [Wo, Ho] = orientedSize(info.w, info.h, geo);
    const fw = crop[2] * Wo, fh = crop[3] * Ho;
    const k = Math.min(1, this.previewSide / Math.max(fw, fh));
    return { pw: Math.max(1, Math.round(fw * k)), ph: Math.max(1, Math.round(fh * k)) };
  }

  // ------------------------------------------------------------ 합성 표시
  displayCrop() { return this.cropOverride || this.store.get().geo.crop; }

  paint() {
    if (!this.base) return;
    const doc = this.store.get();
    const tool = this.tool;
    const src = this.showOriginal && this.origCache ? this.origCache.canvas : this.baseCanvas;
    const crop = this.displayCrop();
    const frameOn = !this.showOriginal && !(tool && tool.hideFrame) && doc.frame && (doc.frame.pad || doc.frame.bottom || doc.frame.aspect || doc.frame.radius);
    const noLayers = this.showOriginal || (tool && tool.hideLayers);
    const out = this.view.photo;
    const ctx = out.getContext('2d');
    let drawn;
    if (!frameOn) {
      if (out.width !== src.width || out.height !== src.height) { out.width = src.width; out.height = src.height; }
      ctx.clearRect(0, 0, out.width, out.height);
      if (!this.showOriginal) drawBackground(ctx, doc.bg, out.width, out.height, this.assets);
      ctx.drawImage(src, 0, 0);
      if (!noLayers && doc.layers.length) {
        const g = makeGeom(out.width, out.height, crop);
        drawLayers(ctx, doc.layers, g, this.assets, { skip: tool && tool.skipLayers });
      }
      drawn = { w: out.width, h: out.height };
    } else {
      const photo = document.createElement('canvas');
      photo.width = src.width; photo.height = src.height;
      const pc = photo.getContext('2d');
      drawBackground(pc, doc.bg, photo.width, photo.height, this.assets);
      pc.drawImage(src, 0, 0);
      if (!noLayers && doc.layers.length) drawLayers(pc, doc.layers, makeGeom(photo.width, photo.height, crop), this.assets, { skip: tool && tool.skipLayers });
      const framed = applyFrame(photo, doc.frame, this.assets);
      if (out.width !== framed.width || out.height !== framed.height) { out.width = framed.width; out.height = framed.height; }
      ctx.clearRect(0, 0, out.width, out.height);
      ctx.drawImage(framed, 0, 0);
      drawn = { w: framed.width, h: framed.height };
    }
    // 논리 크기 = (풀 퀄리티 사진 크기 + 프레임) — 드래프트/풀 렌더에서 화면상 크기를 동일하게 유지
    const lp = this.logical;
    let lw = lp.pw, lh = lp.ph;
    if (frameOn) { const L = frameLayout(lp.pw, lp.ph, doc.frame); lw = L.W; lh = L.H; }
    const alpha = this.info.alpha || (doc.retouch || []).some((o) => o.k === 'cut');
    out.classList.toggle('checker', !!alpha && (!doc.bg || doc.bg.type === 'none') && !frameOn);
    const info = this.info;
    const [Wo] = orientedSize(info.w, info.h, doc.geo);
    this.view.pxScale = (crop[2] * Wo) / lw;
    this.view.setContent(lw, lh);
    this.drawn = drawn;
    this.logicalFull = { w: lw, h: lh };
    this.updateZoomChip();
    this.drawOverlay();
  }

  updateZoomChip() {
    this.zoomChip.textContent = this.view.fitted ? t('맞춤', 'Fit') : this.view.zoomPercent() + '%';
  }

  drawOverlay() {
    const ctx = this.view.overlay();
    if (this.tool && this.tool.drawOverlay) this.tool.drawOverlay(ctx, this.view);
  }
  invalidateOverlay() { this.drawOverlay(); }

  // ------------------------------------------------------------ 좌표 변환 (캔버스 정규화 ↔ 논리 콘텐츠 px)
  frameInfo() {
    const doc = this.store.get();
    const lp = this.logical;
    const f = doc.frame && !(this.tool && this.tool.hideFrame) && (doc.frame.pad || doc.frame.bottom || doc.frame.aspect || doc.frame.radius) ? frameLayout(lp.pw, lp.ph, doc.frame) : { W: lp.pw, H: lp.ph, x: 0, y: 0 };
    return f;
  }
  geom() { // 논리 px 기준 지오메트리
    const lp = this.logical;
    return makeGeom(lp.pw, lp.ph, this.displayCrop());
  }
  canvasToContent(x, y) {
    const g = this.geom(), f = this.frameInfo();
    const [px, py] = g.px(x, y);
    return [px + f.x, py + f.y];
  }
  contentToCanvas(cx, cy) {
    const g = this.geom(), f = this.frameInfo();
    return g.inv(cx - f.x, cy - f.y);
  }
  unit() { return this.geom().unit; }

  // ------------------------------------------------------------ 시트 / 도구
  setTitle(s) { this.sheetTitle.textContent = s; }
  setActions(list) { clear(this.sheetActions); list.filter(Boolean).forEach((b) => this.sheetActions.append(b)); }
  setPeek(on) { this.sheetEl.classList.toggle('peek', !!on); this.peek = !!on; }
  togglePeek() { this.setPeek(!this.peek); if (this.tool && this.tool.onPeek) this.tool.onPeek(this.peek); this.afterLayout(); }

  toggleTool(id) {
    if (this.toolId === id) this.closeTool(true);
    else this.openTool(id);
  }

  openTool(id) {
    if (!this.base && !this.info) return;
    if (this.tool) this.closeTool(true);
    const def = TOOLS.find((x) => x.id === id);
    if (!def) return;
    this.toolId = id;
    this.setGroup(groupOf(id)); // 다른 경로(레이어의 "편집", 리터치의 인물 보정 등)로 열려도 분류/하위 목록을 맞춘다
    for (const [k, b] of this.toolBtns) b.setAttribute('aria-selected', String(k === id));
    clear(this.sheetBody); clear(this.sheetActions);
    this.sheetEl.hidden = false;
    this.clearSheetHeight();
    this.setPeek(false);
    this.setTitle(def.title ? def.title() : def.label());
    this.cropOverride = null;
    this.tool = def.open(this, this.sheetBody) || {};
    this.applySheetPref(); // 이 도구에서 끌어 조절해 둔 높이가 있으면 적용
    this.view.setHandler(this.tool.pointer || null);
    const b = this.toolBtns.get(id);
    b && b.scrollIntoView && b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    this.paint();
    this.afterLayout();
  }

  /** 시트 높이 변화로 스테이지 크기가 바뀌면 맞춤 유지 */
  afterLayout() {
    requestAnimationFrame(() => { this.view.resize(); });
  }

  closeTool(apply = true) {
    if (!this.tool) return;
    const tl = this.tool;
    try { apply ? (tl.apply && tl.apply()) : (tl.cancel && tl.cancel()); } catch (e) { console.error(e); }
    try { tl.close && tl.close(); } catch (e) { console.error(e); }
    this.tool = null; this.toolId = null;
    this.cropOverride = null;
    this.wantHist = false; this.onHist = null;
    this.view.setHandler(null);
    for (const b of this.toolBtns.values()) b.setAttribute('aria-selected', 'false');
    this.sheetEl.hidden = true;
    this.clearSheetHeight();
    clear(this.sheetBody); clear(this.sheetActions);
    const og = GROUPS.find((x) => x.id === this.groupId);
    if (og && og.direct) this.setGroup(null);
    this.requestRender('full');
    this.paint();
    this.afterLayout();
  }

  // ------------------------------------------------------------ 레이어 관리
  layerById(id) { return this.doc().layers.find((l) => l.id === id) || null; }
  addLayer(L, label) {
    const layer = { id: uid(), opacity: 1, rot: 0, x: 0.5, y: 0.5, ...L };
    this.apply((d) => setIn(d, 'layers', [...d.layers, layer]), label || t('레이어 추가', 'Add layer'));
    this.sel = layer.id;
    return layer;
  }
  updateLayer(id, patch, commit = false, label) {
    const fn = (d) => setIn(d, 'layers', d.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    if (commit) this.apply(fn, label); else this.preview(fn);
  }
  removeLayer(id) {
    this.apply((d) => setIn(d, 'layers', d.layers.filter((l) => l.id !== id)), t('레이어 삭제', 'Delete layer'));
    if (this.sel === id) this.sel = null;
  }
  moveLayer(id, dir) {
    this.apply((d) => {
      const arr = d.layers.slice(); const i = arr.findIndex((l) => l.id === id); const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return d;
      [arr[i], arr[j]] = [arr[j], arr[i]]; return setIn(d, 'layers', arr);
    }, t('순서 변경', 'Reorder'));
  }
  duplicateLayer(id) {
    const L = this.layerById(id); if (!L) return;
    const c = { ...JSON.parse(JSON.stringify(L)), id: uid(), x: Math.min(0.95, L.x + 0.04), y: Math.min(0.95, L.y + 0.04) };
    this.apply((d) => setIn(d, 'layers', [...d.layers, c]), t('레이어 복제', 'Duplicate'));
    this.sel = c.id;
  }
  /** 캔버스를 그대로 이미지 레이어 자산으로 등록 (AI 수정 패치 등). 초안 저장은 호출자가 Blob 으로 직접 한다 */
  addCanvasAsset(cv) {
    const key = uid('a');
    this.assets.set(key, { src: cv, width: cv.width, height: cv.height });
    return key;
  }
  dropAsset(key) { this.assets.delete(key); }

  /**
   * 캔버스 정규화 영역(crop=[x,y,w,h])을 보정+레이어+배경까지 합성해 캔버스로 반환(프레임 제외).
   * 해상도는 작업 원본 기준으로 긴 변 maxLong px 이하(업스케일 없음). 파이프라인 캐시를 비우므로 다음 미리보기는 다시 계산된다.
   */
  async renderRegion(crop, maxLong) {
    const doc = this.store.get();
    const info = this.info;
    const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
    const fullW = crop[2] * Wo, fullH = crop[3] * Ho;
    const scale = Math.max(0.02, Math.min(1, maxLong / Math.max(fullW, fullH)));
    const res = await this.engine.render(docForRender(doc), { scale, crop, release: true });
    const base = document.createElement('canvas');
    base.width = res.w; base.height = res.h;
    base.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    await this.ensureFonts(doc);
    return composeDoc(base, doc, this.assets, { crop, noFrame: true });
  }

  async addImageAsset(blobOrBitmap) {
    let bmp = blobOrBitmap;
    if (!(bmp instanceof ImageBitmap)) bmp = await createImageBitmap(blobOrBitmap, { imageOrientation: 'from-image' });
    let src = bmp;
    const maxD = 2048;
    if (Math.max(bmp.width, bmp.height) > maxD) {
      const k = maxD / Math.max(bmp.width, bmp.height);
      const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
      const c = cv.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(bmp, 0, 0, cv.width, cv.height);
      src = cv;
    }
    const key = uid('a');
    this.assets.set(key, { src, width: src.width, height: src.height });
    if (blobOrBitmap instanceof Blob) Drafts.put('asset:' + key, blobOrBitmap);
    return key;
  }

  // ------------------------------------------------------------ 색 추출 (스포이트)
  sampleColor(sx, sy) {
    const cv = this.view.photo;
    const [cx, cy] = this.view.toContent(sx, sy);
    const px = Math.round((cx / this.logicalFull.w) * cv.width), py = Math.round((cy / this.logicalFull.h) * cv.height);
    if (px < 0 || py < 0 || px >= cv.width || py >= cv.height) return null;
    const d = cv.getContext('2d').getImageData(px, py, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /** 사진의 한 점을 눌러 색 선택 (일시적으로 포인터 핸들러를 교체) */
  pickColorFromCanvas(cb) {
    const prev = this.view.handler;
    toast(t('사진에서 색을 눌러 선택하세요', 'Tap the photo to pick a color'));
    const restore = () => this.view.setHandler(prev);
    this.view.setHandler({ down: () => true, move: () => {}, up: (ev) => { const c = this.sampleColor(ev.sx, ev.sy); restore(); cb(c); }, cancel: restore });
  }

  // ------------------------------------------------------------ 닫기 / 뒤로
  async requestClose() {
    if (handleBack()) return;
    if (this.tool) { this.closeTool(true); return; }
    if (this.store.isDirty()) {
      const v = await confirmDialog({ title: t('편집 내용을 버릴까요?', 'Discard edits?'), body: t('저장하지 않으면 변경 사항이 사라져요.', "Your changes will be lost if you don't save."), actions: [{ label: t('계속 편집', 'Keep editing'), value: 'keep' }, { label: t('버리기', 'Discard'), value: 'discard', kind: 'danger' }] });
      if (v !== 'discard') return;
    }
    this.app.goHome();
  }
  onBack() {
    if (handleBack()) return true;
    if (this.tool) {
      if (this.tool.cancel) this.closeTool(false); else this.closeTool(true);
      return true;
    }
    if (this.groupId) { this.setGroup(null); return true; } // 펼친 하위 목록이 있으면 먼저 접는다
    this.requestClose();
    return true;
  }

  // ------------------------------------------------------------ 내보내기
  /** 지정 크기(doc.out)에 맞춰 최종 캔버스를 채우기/여백/늘이기로 만든다 */
  finalizeOut(C, out) {
    const O = document.createElement('canvas');
    O.width = out.w; O.height = out.h;
    const c = O.getContext('2d');
    c.imageSmoothingQuality = 'high';
    if (out.fit === 'stretch') { c.drawImage(C, 0, 0, out.w, out.h); return O; }
    const kc = Math.max(out.w / C.width, out.h / C.height), kf = Math.min(out.w / C.width, out.h / C.height);
    if (out.fit === 'fill') { c.drawImage(C, (out.w - C.width * kc) / 2, (out.h - C.height * kc) / 2, C.width * kc, C.height * kc); return O; }
    if (Math.abs(out.w / out.h - C.width / C.height) > 0.003) {
      if (out.bg === 'color') { c.fillStyle = out.color || '#000000'; c.fillRect(0, 0, out.w, out.h); }
      else { c.save(); c.filter = `blur(${Math.max(6, Math.min(out.w, out.h) * 0.04)}px) brightness(.8)`; c.drawImage(C, (out.w - C.width * kc) / 2, (out.h - C.height * kc) / 2, C.width * kc, C.height * kc); c.restore(); }
    }
    c.drawImage(C, (out.w - C.width * kf) / 2, (out.h - C.height * kf) / 2, C.width * kf, C.height * kf);
    return O;
  }

  async renderExport(spec) {
    const doc = this.store.get();
    const info = this.info;
    const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
    const crop = doc.geo.crop;
    const fullW = crop[2] * Wo, fullH = crop[3] * Ho;
    const frameOn = doc.frame && (doc.frame.pad || doc.frame.bottom || doc.frame.aspect || doc.frame.radius);
    const out = spec.out || null;
    let scale = 1;
    if (out) {
      const lay = frameLayout(Math.max(1, Math.round(fullW)), Math.max(1, Math.round(fullH)), frameOn ? doc.frame : null);
      const sx = out.w / lay.W, sy = out.h / lay.H;
      scale = out.fit === 'fit' ? Math.min(sx, sy) : Math.max(sx, sy);
    } else if (spec.maxSide) scale = spec.maxSide / Math.max(fullW, fullH);
    else if (spec.scale) scale = spec.scale;
    scale = Math.max(0.02, Math.min(scale, 4));
    const res = await this.engine.render(docForRender(doc), { scale, release: true });
    const base = document.createElement('canvas');
    base.width = res.w; base.height = res.h;
    base.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    await this.ensureFonts(doc);
    let cv = composeDoc(base, doc, this.assets, { crop });
    if (out) cv = this.finalizeOut(cv, out);
    if (spec.format === 'image/jpeg') {
      const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
      const x = c.getContext('2d'); x.fillStyle = (doc.bg && doc.bg.type === 'color' && doc.bg.color) || '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(cv, 0, 0);
      cv = c;
    }
    return cv;
  }

  /** 텍스트 레이어에 쓰인 번들 폰트가 모두 로드될 때까지 대기 (저장/공유 직전) */
  async ensureFonts(doc) {
    try {
      const jobs = [];
      for (const L of doc.layers || []) if (L.t === 'text') jobs.push(document.fonts.load(fontCss(L, 40), L.text || 'A'));
      if (jobs.length) await Promise.all(jobs);
    } catch (e) { /* 폰트 없이 진행 */ }
  }

  async exportBlob(spec) {
    const cv = await this.renderExport(spec);
    const blob = await new Promise((res) => cv.toBlob(res, spec.format, spec.quality));
    if (!blob) throw new Error('encode failed');
    return { blob, w: cv.width, h: cv.height };
  }

  openExport() {
    if (!this.base) return;
    if (this.tool) this.closeTool(true);
    const s = this.app.settings;
    const state = { format: s.format || 'image/jpeg', quality: s.quality || 92, size: doc0Out(this) ? 'out' : 'orig' };
    const info = this.info;
    const doc = this.store.get();
    const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
    const crop = doc.geo.crop;
    const fw = Math.round(crop[2] * Wo), fh = Math.round(crop[3] * Ho);
    const outSpec = doc.out || null;
    const sizes = outSpec ? [['out', t('지정 크기', 'Set size'), 0]] : [['orig', t('원본', 'Original'), 0], ['4096', '4096', 4096], ['2048', '2048', 2048], ['1080', '1080', 1080], ['720', '720', 720]].filter((x) => x[2] === 0 || x[2] < Math.max(fw, fh));
    const customEl = h('input', { class: 'field num', type: 'text', inputMode: 'numeric', placeholder: t('긴 변 px 직접 입력', 'Long side in px'), 'aria-label': t('긴 변 px 직접 입력', 'Long side in px'), style: { maxWidth: '200px' } });
    let modal;
    const dimsEl = h('div', { class: 'sheet-note num' });
    const hasAlpha = this.info.alpha || (doc.retouch || []).some((o) => o.k === 'cut');
    const alphaNote = h('p', { class: 'sheet-note' }, t('투명한 영역은 PNG·WebP로 저장해야 유지돼요. JPEG는 흰색으로 채워져요.', 'Transparent areas are kept only in PNG/WebP. JPEG fills them with white.'));
    const upd = () => {
      const sz = sizes.find((x) => x[0] === state.size) || sizes[0];
      const cv = parseInt(customEl.value, 10);
      const side = cv > 0 ? Math.min(8192, cv) : sz[2];
      const k = side ? Math.min(4, side / Math.max(fw, fh)) : 1;
      dimsEl.textContent = outSpec ? `${outSpec.w} × ${outSpec.h} px` : `${Math.round(fw * k)} × ${Math.round(fh * k)} px`;
      qS.el.hidden = state.format === 'image/png';
      alphaNote.hidden = !(hasAlpha && state.format === 'image/jpeg' && !(doc.bg && doc.bg.type !== 'none'));
    };
    const qS = Slider({ label: t('품질', 'Quality'), min: 40, max: 100, value: state.quality, def: 92, unit: '%', onInput: (v) => { state.quality = v; } });
    const fmt = Segmented({ label: t('형식', 'Format'), items: [{ id: 'image/jpeg', label: 'JPEG' }, { id: 'image/png', label: 'PNG' }, { id: 'image/webp', label: 'WebP' }], value: state.format, onChange: (v) => { state.format = v; upd(); } });
    const sizeChips = Chips({ label: t('크기', 'Size'), items: sizes.map((x) => ({ id: x[0], label: x[1] })), value: state.size, wrap: true, onSelect: (id) => { state.size = id; upd(); } });
    const run = async (share) => {
      const saveB = modal.body.querySelector('[data-act=save]'); const shareB = modal.body.querySelector('[data-act=share]');
      saveB.disabled = shareB.disabled = true;
      const lab = saveB.textContent; saveB.textContent = t('저장 중…', 'Saving…');
      try {
        const sz = sizes.find((x) => x[0] === state.size) || sizes[0];
        const cvv = parseInt(customEl.value, 10);
        const { blob } = await this.exportBlob({ format: state.format, quality: state.quality / 100, out: outSpec || undefined, maxSide: outSpec ? 0 : (cvv > 0 ? Math.min(8192, cvv) : (sz[2] || 0)) });
        const ext = state.format === 'image/png' ? 'png' : state.format === 'image/webp' ? 'webp' : 'jpg';
        const stamp = new Date(); const pad = (n) => String(n).padStart(2, '0');
        const name = `ImageFix_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${ext}`;
        const res = await bridge.saveBlob(blob, name);
        this.store.markSaved();
        s.format = state.format; s.quality = state.quality; this.app.saveSettings();
        modal.close();
        if (share) { const ok = await bridge.share(res, blob); if (!ok) toast(t('공유할 수 없어요.', "Can't share.")); }
        else toast(t('갤러리에 저장했어요', 'Saved to gallery'), { action: res.uri ? { label: t('보기', 'View'), onClick: () => bridge.view(res) } : null });
      } catch (e) {
        console.error(e);
        const m = String(e && e.message || e);
        toast(m.includes('permission') ? t('저장 권한을 허용한 뒤 다시 저장해 주세요.', 'Allow storage permission, then save again.') : t('저장하지 못했어요. 다시 시도해 주세요.', "Couldn't save. Please try again."));
        saveB.disabled = shareB.disabled = false; saveB.textContent = lab;
      }
    };
    modal = openModal({
      title: t('저장', 'Save'),
      build: (body) => {
        body.append(h('div', { class: 'sheet-sec' }, t('형식', 'Format')), fmt.el, qS.el, h('div', { class: 'sheet-sec' }, t('크기', 'Size')), outSpec ? h('p', { class: 'sheet-note' }, t('크기 도구에서 지정한 크기로 저장해요.', 'Saved at the size set in the Size tool.')) : sizeChips.el, outSpec ? null : customEl, dimsEl, alphaNote);
        customEl.addEventListener('input', () => { upd(); });
        body.append(h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn outlined grow', type: 'button', 'data-act': 'share', onClick: () => run(true) }, icon('share-2'), t('공유', 'Share')),
          h('button', { class: 'btn filled grow', type: 'button', 'data-act': 'save', onClick: () => run(false) }, icon('download'), t('저장', 'Save'))));
        upd();
      },
    });
  }
}
