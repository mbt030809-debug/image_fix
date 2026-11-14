// 에디터: 상단 바 / 캔버스 / 도킹 시트 / 도구 스트립 + 렌더 스케줄링 + 레이어 관리 + 내보내기
import { h, icon, clear } from './ui/dom.js';
import { t } from './i18n.js';
import { Store, newDoc, setIn, uid } from './store.js';
import { View } from './view.js';
import { IconBtn, Btn, toast, confirmDialog, openModal, handleBack, Segmented, Slider, Chips } from './ui/components.js';
import { orientedSize } from './engine/geometry.js';
import { makeGeom, composeDoc, drawLayers, drawBackground, applyFrame, frameLayout } from './compose.js';
import { bridge } from './bridge.js';
import { TOOLS } from './tools/index.js';

const PIX_KEYS = ['geo', 'retouch', 'adj', 'filter', 'fx', 'locals', 'lutRef'];

export function docForRender(doc) {
  return { geo: doc.geo, retouch: doc.retouch, adj: doc.adj, filter: doc.filter, fx: doc.fx, locals: doc.locals, lutRef: doc.lutRef };
}

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

    // 시트
    this.sheetTitle = h('h2', { id: 'sheet-title' });
    this.sheetActions = h('div', { class: 'row', style: { gap: '0' } });
    this.grab = h('div', { class: 'sheet-grab', role: 'button', tabIndex: 0, 'aria-label': t('패널 펼치기/접기', 'Expand or collapse panel') });
    this.grab.addEventListener('click', () => this.togglePeek());
    this.sheetBody = h('div', { class: 'sheet-body' });
    this.sheetEl = h('div', { class: 'sheet', hidden: true, role: 'tabpanel', 'aria-labelledby': 'sheet-title' }, this.grab, h('div', { class: 'sheet-head' }, this.sheetTitle, this.sheetActions), this.sheetBody);

    // 도구 스트립
    this.strip = h('div', { class: 'strip', role: 'tablist', 'aria-label': t('도구', 'Tools') });
    this.toolBtns = new Map();
    for (const tl of TOOLS) {
      const b = h('button', { class: 'tool', type: 'button', role: 'tab', 'aria-selected': 'false', 'data-tool': tl.id }, h('span', { class: 'pill' }, icon(tl.icon)), h('span', { class: 'lbl' }, tl.label()));
      b.addEventListener('click', () => this.toggleTool(tl.id));
      this.toolBtns.set(tl.id, b); this.strip.append(b);
    }
    this.strip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const arr = [...this.toolBtns.values()], i = arr.indexOf(document.activeElement);
      if (i < 0) return;
      const n = arr[(i + (e.key === 'ArrowRight' ? 1 : arr.length - 1)) % arr.length]; n.focus(); e.preventDefault();
    });

    this.el = h('div', { class: 'editor' }, this.topbar, this.stage, this.sheetEl, this.strip);
    this.updateButtons();
  }

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
  async openBitmap(bitmap, name) {
    this.loadingEl.hidden = false;
    this.closeTool(false);
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
    this.requestRender('full');
    this.updateButtons();
  }
  async openBuffer(w, h, buffer, name) {
    this.loadingEl.hidden = false;
    this.closeTool(false);
    this.assets.clear();
    const info = await this.engine.loadBuffer(w, h, buffer);
    this.fileName = name || 'canvas';
    this.info = info;
    this.previewSide = this.computePreviewSide();
    this.origCache = null; this.hist = null; this.lastPix = null; this.base = null; this.sel = null;
    this.store.reset(newDoc());
    this.requestRender('full');
    this.updateButtons();
  }
  setOriginalUI(v) { this.showOriginal = v; this.badge.hidden = !v; this.cmpBtn.setAttribute('aria-pressed', String(v)); }

  computePreviewSide() {
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    const r = this.stage.getBoundingClientRect();
    const mem = bridge.info().memMB || 4096;
    const cap = mem < 3500 ? 1600 : 2304;
    return Math.max(1024, Math.min(cap, Math.round(Math.max(r.width, r.height || 600, 640) * dpr * 1.2)));
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
    if (quality === 'draft' && this.wantQuality === 'full' && this.busy && this.again) { /* 이미 대기 중인 full 유지 */ }
    else this.wantQuality = quality === 'full' || !this.busy ? quality : (this.wantQuality === 'full' ? 'full' : 'draft');
    if (quality === 'full') this.wantQuality = 'full';
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
        if (q === 'full' && !this.again) this.wantQuality = 'full';
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
    for (const [k, b] of this.toolBtns) b.setAttribute('aria-selected', String(k === id));
    clear(this.sheetBody); clear(this.sheetActions);
    this.sheetEl.hidden = false;
    this.setPeek(false);
    this.setTitle(def.label());
    this.cropOverride = null;
    this.tool = def.open(this, this.sheetBody) || {};
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
    clear(this.sheetBody); clear(this.sheetActions);
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
    this.requestClose();
    return true;
  }

  // ------------------------------------------------------------ 내보내기
  async renderExport(spec) {
    const doc = this.store.get();
    const info = this.info;
    const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
    const crop = doc.geo.crop;
    const fullW = crop[2] * Wo, fullH = crop[3] * Ho;
    let scale = 1;
    if (spec.maxSide) scale = spec.maxSide / Math.max(fullW, fullH);
    else if (spec.scale) scale = spec.scale;
    scale = Math.min(scale, 4);
    const res = await this.engine.render(docForRender(doc), { scale, release: true });
    const base = document.createElement('canvas');
    base.width = res.w; base.height = res.h;
    base.getContext('2d').putImageData(new ImageData(res.data, res.w, res.h), 0, 0);
    let out = composeDoc(base, doc, this.assets, { crop });
    const opaque = spec.format === 'image/jpeg';
    if (opaque) {
      const c = document.createElement('canvas'); c.width = out.width; c.height = out.height;
      const x = c.getContext('2d'); x.fillStyle = (doc.bg && doc.bg.type === 'color' && doc.bg.color) || '#ffffff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(out, 0, 0);
      out = c;
    }
    return out;
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
    const state = { format: s.format || 'image/jpeg', quality: s.quality || 92, size: 'orig' };
    const info = this.info;
    const doc = this.store.get();
    const [Wo, Ho] = orientedSize(info.w, info.h, doc.geo);
    const crop = doc.geo.crop;
    const fw = Math.round(crop[2] * Wo), fh = Math.round(crop[3] * Ho);
    const sizes = [['orig', t('원본', 'Original'), 0], ['4096', '4096', 4096], ['2048', '2048', 2048], ['1080', '1080', 1080], ['720', '720', 720]].filter((x) => x[2] === 0 || x[2] < Math.max(fw, fh));
    let modal;
    const dimsEl = h('div', { class: 'sheet-note num' });
    const upd = () => {
      const sz = sizes.find((x) => x[0] === state.size) || sizes[0];
      const k = sz[2] ? Math.min(1, sz[2] / Math.max(fw, fh)) : 1;
      dimsEl.textContent = `${Math.round(fw * k)} × ${Math.round(fh * k)} px`;
      qS.el.hidden = state.format === 'image/png';
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
        const { blob } = await this.exportBlob({ format: state.format, quality: state.quality / 100, maxSide: sz[2] || 0 });
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
        body.append(h('div', { class: 'sheet-sec' }, t('형식', 'Format')), fmt.el, qS.el, h('div', { class: 'sheet-sec' }, t('크기', 'Size')), sizeChips.el, dimsEl);
        body.append(h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn outlined grow', type: 'button', 'data-act': 'share', onClick: () => run(true) }, icon('share-2'), t('공유', 'Share')),
          h('button', { class: 'btn filled grow', type: 'button', 'data-act': 'save', onClick: () => run(false) }, icon('download'), t('저장', 'Save'))));
        upd();
      },
    });
  }
}
