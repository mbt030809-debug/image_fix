// 콜라주: 여러 장 → 레이아웃 템플릿 + 비율/간격/모서리/배경, 칸별 이동·확대, 편집기로 보내기 / 바로 저장
import { h, icon, clear } from './ui/dom.js';
import { t } from './i18n.js';
import { IconBtn, Btn, Chips, Segmented, Slider, toast, confirmDialog, handleBack } from './ui/components.js';
import { bridge } from './bridge.js';
import { ColorField } from './tools/colorfield.js';

const RATIOS = [['1:1', 1, 1], ['4:5', 4, 5], ['3:4', 3, 4], ['9:16', 9, 16], ['16:9', 16, 9], ['3:2', 3, 2]];

function rowsSplit(counts) { // 행마다 개수가 다른 레이아웃
  const rects = [], R = counts.length;
  counts.forEach((c, r) => { for (let i = 0; i < c; i++) rects.push([i / c, r / R, 1 / c, 1 / R]); });
  return rects;
}
function colsSplit(counts) {
  const rects = [], C = counts.length;
  counts.forEach((c, k) => { for (let i = 0; i < c; i++) rects.push([k / C, i / c, 1 / C, 1 / c]); });
  return rects;
}
function bigSmall(n, side) { // 큰 칸 1 + 작은 칸 n-1
  const rects = [];
  if (side === 'left') { rects.push([0, 0, 0.62, 1]); for (let i = 0; i < n - 1; i++) rects.push([0.62, i / (n - 1), 0.38, 1 / (n - 1)]); }
  else { rects.push([0, 0, 1, 0.62]); for (let i = 0; i < n - 1; i++) rects.push([i / (n - 1), 0.62, 1 / (n - 1), 0.38]); }
  return rects;
}
export function layoutsFor(n) {
  const L = [];
  const add = (id, rects) => L.push({ id, rects });
  if (n === 1) add('1', [[0, 0, 1, 1]]);
  else if (n === 2) { add('2h', rowsSplit([2])); add('2v', colsSplit([2])); add('2a', [[0, 0, 0.62, 1], [0.62, 0, 0.38, 1]]); add('2b', [[0, 0, 1, 0.62], [0, 0.62, 1, 0.38]]); }
  else if (n === 3) { add('3a', rowsSplit([1, 2])); add('3b', rowsSplit([2, 1])); add('3c', colsSplit([1, 2])); add('3d', colsSplit([2, 1])); add('3e', rowsSplit([3])); add('3f', colsSplit([3])); }
  else if (n === 4) { add('4a', rowsSplit([2, 2])); add('4b', rowsSplit([1, 3])); add('4c', rowsSplit([3, 1])); add('4d', colsSplit([1, 3])); add('4e', colsSplit([3, 1])); add('4f', bigSmall(4, 'left')); add('4g', rowsSplit([4])); }
  else if (n === 5) { add('5a', rowsSplit([2, 3])); add('5b', rowsSplit([3, 2])); add('5c', colsSplit([2, 3])); add('5d', colsSplit([3, 2])); add('5e', bigSmall(5, 'left')); add('5f', bigSmall(5, 'top')); }
  else if (n === 6) { add('6a', rowsSplit([3, 3])); add('6b', rowsSplit([2, 2, 2])); add('6c', colsSplit([2, 2, 2])); add('6d', rowsSplit([2, 4])); add('6e', bigSmall(6, 'left')); }
  else if (n === 7) { add('7a', rowsSplit([3, 4])); add('7b', rowsSplit([2, 3, 2])); add('7c', colsSplit([3, 4])); }
  else if (n === 8) { add('8a', rowsSplit([4, 4])); add('8b', rowsSplit([3, 2, 3])); add('8c', rowsSplit([2, 2, 2, 2])); }
  else { add('9a', rowsSplit([3, 3, 3])); add('9b', rowsSplit([4, 5])); }
  return L;
}

function layoutThumb(rects) {
  const cv = h('canvas', { width: 64, height: 64, 'aria-hidden': 'true' });
  const c = cv.getContext('2d');
  c.fillStyle = '#8a94a6';
  for (const [x, y, w, hh] of rects) { c.beginPath(); c.roundRect ? c.roundRect(4 + x * 56 + 1.5, 4 + y * 56 + 1.5, w * 56 - 3, hh * 56 - 3, 3) : c.rect(4 + x * 56 + 1.5, 4 + y * 56 + 1.5, w * 56 - 3, hh * 56 - 3); c.fill(); }
  return cv;
}

export class Collage {
  constructor(app) {
    this.app = app;
    this.photos = []; // {bmp,w,h,name}
    this.cells = [];  // {p, zoom, ox, oy}
    this.layoutId = null; this.ratio = '1:1'; this.gap = 2; this.margin = 2; this.radius = 3; this.bg = '#ffffff';
    this.sel = 0; this.swapMode = false; this.tab = 'layout';
    this.build();
  }

  build() {
    this.saveBtn = Btn(t('저장', 'Save'), 'filled', () => this.save());
    this.editBtn = Btn(t('편집', 'Edit'), 'tonal', () => this.toEditor(), 'sliders-horizontal');
    this.closeBtn = IconBtn('x', t('닫기', 'Close'), () => this.close());
    this.topbar = h('div', { class: 'topbar' }, this.closeBtn, h('h2', { style: { font: 'inherit', fontWeight: 500, marginLeft: '8px' } }, t('콜라주', 'Collage')), h('div', { class: 'spacer' }), this.editBtn, this.saveBtn);
    this.cv = h('canvas', { role: 'img', 'aria-label': t('콜라주 미리보기', 'Collage preview'), style: { touchAction: 'none', boxShadow: 'var(--shadow-2)' } });
    this.stage = h('div', { class: 'stage', style: { display: 'grid', placeItems: 'center', minHeight: '35dvh' } }, this.cv);
    this.body = h('div', { class: 'sheet-body' });
    this.tabs = Segmented({ label: t('설정', 'Settings'), items: [{ id: 'layout', label: t('레이아웃', 'Layout') }, { id: 'style', label: t('스타일', 'Style') }, { id: 'photo', label: t('사진', 'Photos') }], value: 'layout', onChange: (v) => { this.tab = v; this.renderPanel(); } });
    this.sheet = h('div', { class: 'sheet', style: { gridRow: '3' } }, h('div', { class: 'sheet-grab', 'aria-hidden': 'true' }), h('div', { class: 'sheet-head' }, this.tabs.el), this.body);
    this.el = h('div', { class: 'screen editor', style: { gridTemplateRows: 'auto minmax(0,1fr) auto' }, hidden: true }, this.topbar, this.stage, this.sheet);
    this.bindCanvas();
    new ResizeObserver(() => this.layoutCanvas()).observe(this.stage);
  }

  // ------------------------------------------------------------ 데이터
  async open(files) {
    const list = [];
    for (const f of files.slice(0, 9)) {
      try { const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); list.push({ bmp, w: bmp.width, h: bmp.height, name: f.name }); } catch (e) { /* 건너뜀 */ }
    }
    if (!list.length) { toast(t('사진을 열 수 없어요.', "Can't open these photos.")); return false; }
    this.photos = list;
    this.rebuildCells(true);
    this.sel = 0; this.swapMode = false;
    this.app.showCollage();
    this.renderPanel(); this.layoutCanvas();
    return true;
  }
  async addPhotos(files) {
    for (const f of files) {
      if (this.photos.length >= 9) { toast(t('최대 9장까지 넣을 수 있어요', 'Up to 9 photos')); break; }
      try { const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' }); this.photos.push({ bmp, w: bmp.width, h: bmp.height, name: f.name }); } catch (e) { /* 건너뜀 */ }
    }
    this.rebuildCells(true); this.renderPanel(); this.draw();
  }
  rebuildCells(resetLayout) {
    const n = this.photos.length;
    const ls = layoutsFor(n);
    if (resetLayout || !ls.some((l) => l.id === this.layoutId)) this.layoutId = ls[0].id;
    this.cells = Array.from({ length: n }, (_, i) => ({ p: i, zoom: 1, ox: 0, oy: 0 }));
    this.sel = Math.min(this.sel, n - 1);
  }
  rects() { const l = layoutsFor(this.photos.length).find((x) => x.id === this.layoutId); return l ? l.rects : [[0, 0, 1, 1]]; }
  dims(longSide) {
    const [, rw, rh] = RATIOS.find((r) => r[0] === this.ratio);
    const k = longSide / Math.max(rw, rh);
    return [Math.round(rw * k), Math.round(rh * k)];
  }

  // ------------------------------------------------------------ 그리기
  layoutCanvas() {
    if (!this.photos.length) return;
    const r = this.stage.getBoundingClientRect();
    const [rw, rh] = this.dims(1000);
    const k = Math.min((r.width - 24) / rw, (r.height - 24) / rh);
    const cssW = Math.max(40, Math.floor(rw * k)), cssH = Math.max(40, Math.floor(rh * k));
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.cv.style.width = cssW + 'px'; this.cv.style.height = cssH + 'px';
    this.cv.width = Math.round(cssW * dpr); this.cv.height = Math.round(cssH * dpr);
    this.draw();
  }

  cellRects(W, H) {
    const mn = Math.min(W, H);
    const m = (this.margin / 100) * mn, g = (this.gap / 100) * mn;
    const iw = W - m * 2, ih = H - m * 2;
    return this.rects().map(([x, y, w, hh]) => {
      const x0 = m + x * iw, y0 = m + y * ih, x1 = m + (x + w) * iw, y1 = m + (y + hh) * ih;
      // 이웃과의 간격(안쪽 변만 g/2 만큼 축소)
      const l = x > 1e-6 ? g / 2 : 0, tp = y > 1e-6 ? g / 2 : 0, rr = x + w < 1 - 1e-6 ? g / 2 : 0, bb = y + hh < 1 - 1e-6 ? g / 2 : 0;
      return [x0 + l, y0 + tp, x1 - x0 - l - rr, y1 - y0 - tp - bb];
    });
  }

  drawTo(ctx, W, H, selIdx) {
    ctx.fillStyle = this.bg; ctx.fillRect(0, 0, W, H);
    const rr = this.cellRects(W, H), mn = Math.min(W, H), rad = (this.radius / 100) * mn;
    this.cells.forEach((cell, i) => {
      const [x, y, w, hh] = rr[i] || [0, 0, 0, 0];
      const ph = this.photos[cell.p];
      if (!ph || w <= 0 || hh <= 0) return;
      ctx.save();
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, y, w, hh, Math.min(rad, w / 2, hh / 2)); else ctx.rect(x, y, w, hh);
      ctx.clip();
      const s = Math.max(w / ph.w, hh / ph.h) * cell.zoom;
      const dw = ph.w * s, dh = ph.h * s;
      const dx = x + (w - dw) / 2 + cell.ox * Math.max(0, dw - w) / 2, dy = y + (hh - dh) / 2 + cell.oy * Math.max(0, dh - hh) / 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(ph.bmp, dx, dy, dw, dh);
      ctx.restore();
    });
    if (selIdx != null && rr[selIdx]) {
      const [x, y, w, hh] = rr[selIdx];
      ctx.save(); ctx.lineWidth = Math.max(2, W * 0.004); ctx.strokeStyle = this.swapMode ? '#ffcc00' : '#8ab4f8'; ctx.setLineDash(this.swapMode ? [10, 8] : []);
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, hh - ctx.lineWidth); ctx.restore();
    }
  }
  draw() {
    if (!this.photos.length || !this.cv.width) return;
    this.drawTo(this.cv.getContext('2d'), this.cv.width, this.cv.height, this.sel);
  }

  // ------------------------------------------------------------ 상호작용
  bindCanvas() {
    let drag = null;
    const pick = (e) => {
      const r = this.cv.getBoundingClientRect(), sx = this.cv.width / r.width;
      const x = (e.clientX - r.left) * sx, y = (e.clientY - r.top) * sx;
      const rr = this.cellRects(this.cv.width, this.cv.height);
      for (let i = rr.length - 1; i >= 0; i--) { const [cx, cy, w, hh] = rr[i]; if (x >= cx && x <= cx + w && y >= cy && y <= cy + hh) return { i, sx, rect: rr[i] }; }
      return null;
    };
    this.cv.addEventListener('pointerdown', (e) => {
      this.cv.setPointerCapture(e.pointerId);
      const hit = pick(e); if (!hit) return;
      if (this.swapMode && hit.i !== this.sel) {
        const a = this.cells[this.sel], b = this.cells[hit.i];
        [a.p, b.p] = [b.p, a.p]; [a.zoom, b.zoom] = [b.zoom, a.zoom]; [a.ox, b.ox] = [b.ox, a.ox]; [a.oy, b.oy] = [b.oy, a.oy];
        this.sel = hit.i; this.swapMode = false; this.draw(); this.renderPanel(); return;
      }
      this.sel = hit.i; this.swapMode = false;
      drag = { x: e.clientX, y: e.clientY, ox: this.cells[hit.i].ox, oy: this.cells[hit.i].oy, hit };
      this.draw(); this.renderPanel();
    });
    this.cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const cell = this.cells[this.sel], ph = this.photos[cell.p];
      const [, , w, hh] = drag.hit.rect;
      const s = Math.max(w / ph.w, hh / ph.h) * cell.zoom, ovx = Math.max(1, ph.w * s - w), ovy = Math.max(1, ph.h * s - hh);
      cell.ox = Math.max(-1, Math.min(1, drag.ox + ((e.clientX - drag.x) * drag.hit.sx * 2) / ovx));
      cell.oy = Math.max(-1, Math.min(1, drag.oy + ((e.clientY - drag.y) * drag.hit.sx * 2) / ovy));
      this.draw();
    });
    const end = () => { drag = null; };
    this.cv.addEventListener('pointerup', end); this.cv.addEventListener('pointercancel', end);
    this.cv.addEventListener('wheel', (e) => { e.preventDefault(); const c = this.cells[this.sel]; if (c) { c.zoom = Math.max(1, Math.min(4, c.zoom * Math.exp(-e.deltaY * 0.0015))); this.draw(); } }, { passive: false });
  }

  // ------------------------------------------------------------ 패널
  renderPanel() {
    clear(this.body);
    this.tabs.set(this.tab);
    const n = this.photos.length;
    if (this.tab === 'layout') {
      const row = h('div', { class: 'thumbs', role: 'radiogroup', 'aria-label': t('레이아웃', 'Layout') });
      for (const l of layoutsFor(n)) {
        const b = h('button', { class: 'thumb', type: 'button', role: 'radio', 'aria-checked': String(l.id === this.layoutId), 'data-id': l.id, 'aria-label': t('레이아웃', 'Layout') + ' ' + l.id }, layoutThumb(l.rects), h('span', { class: 'tchk' }, icon('check')));
        b.addEventListener('click', () => { this.layoutId = l.id; for (const x of row.querySelectorAll('.thumb')) x.setAttribute('aria-checked', String(x.dataset.id === l.id)); this.draw(); });
        row.append(b);
      }
      const ratio = Chips({ label: t('비율', 'Aspect'), items: RATIOS.map(([id]) => ({ id, label: id })), value: this.ratio, onSelect: (id) => { this.ratio = id; this.layoutCanvas(); } });
      this.body.append(row, h('div', { class: 'sheet-sec' }, t('캔버스 비율', 'Canvas ratio')), ratio.el);
    } else if (this.tab === 'style') {
      const S = (label, key, max) => Slider({ label, min: 0, max, value: this[key], def: key === 'margin' || key === 'gap' ? 2 : 3, unit: '%', bipolar: false, onInput: (v) => { this[key] = v; this.draw(); } }).el;
      this.body.append(S(t('간격', 'Gap'), 'gap', 12), S(t('바깥 여백', 'Margin'), 'margin', 12), S(t('모서리', 'Corner radius'), 'radius', 30),
        ColorField({ app: this.app, pickColorFromCanvas: () => {}, doc: () => ({}) }, { label: t('배경색', 'Background'), value: this.bg, eyedropper: false, colors: ['#ffffff', '#000000', '#f5e6c8', '#ffd1dc', '#b8e0ff', '#1f2937', '#ff3b30', '#34c759', '#ffcc00'], onChange: (c) => { this.bg = c; this.draw(); } }).el);
    } else {
      const cell = this.cells[this.sel];
      const info = h('p', { class: 'sheet-note' }, this.swapMode ? t('위치를 바꿀 칸을 눌러 주세요.', 'Tap the cell to swap with.') : t('칸을 눌러 선택하고, 끌어서 사진 위치를 맞춰요.', 'Tap a cell to select it, drag to reposition the photo.'));
      this.body.append(info);
      if (cell) {
        this.body.append(Slider({ label: t('확대', 'Zoom'), min: 100, max: 400, value: Math.round(cell.zoom * 100), def: 100, unit: '%', bipolar: false, onInput: (v) => { cell.zoom = v / 100; this.draw(); } }).el,
          h('div', { class: 'row wrap' },
            Btn(t('위치 바꾸기', 'Swap'), 'outlined', () => { if (n < 2) return; this.swapMode = true; this.draw(); this.renderPanel(); }, 'repeat'),
            Btn(t('사진 교체', 'Replace'), 'outlined', async () => { const f = await bridge.pickFile('image/*'); if (!f.length) return; try { const bmp = await createImageBitmap(f[0], { imageOrientation: 'from-image' }); this.photos[cell.p] = { bmp, w: bmp.width, h: bmp.height, name: f[0].name }; cell.zoom = 1; cell.ox = cell.oy = 0; this.draw(); } catch (e) { toast(t('사진을 열 수 없어요.', "Can't open the photo.")); } }, 'image'),
            Btn(t('삭제', 'Remove'), 'outlined', () => { if (n <= 1) return; this.photos.splice(cell.p, 1); this.rebuildCells(true); this.renderPanel(); this.draw(); }, 'trash-2')));
      }
      this.body.append(Btn(t('사진 추가', 'Add photos'), 'tonal', async () => { const f = await bridge.pickFile('image/*', true); if (f.length) this.addPhotos(f); }, 'image-plus'));
    }
  }

  // ------------------------------------------------------------ 출력
  renderCanvas(longSide) {
    const [W, H] = this.dims(longSide);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    this.drawTo(cv.getContext('2d'), W, H, null);
    return cv;
  }
  async save() {
    this.saveBtn.disabled = true;
    try {
      const cv = this.renderCanvas(2400);
      const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.92));
      const p = (n) => String(n).padStart(2, '0'), d = new Date();
      const name = `ImageFix_collage_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
      const res = await bridge.saveBlob(blob, name);
      toast(t('갤러리에 저장했어요', 'Saved to gallery'), { action: res.uri ? { label: t('보기', 'View'), onClick: () => bridge.view(res) } : null });
    } catch (e) { console.error(e); toast(t('저장하지 못했어요. 다시 시도해 주세요.', "Couldn't save. Please try again.")); }
    this.saveBtn.disabled = false;
  }
  async toEditor() {
    const cv = this.renderCanvas(2400);
    const id = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.95));
    await this.app.editor.openBuffer(cv.width, cv.height, id.data.buffer, 'collage', blob);
    this.app.showEditor();
  }
  async close() {
    if (handleBack()) return;
    const v = await confirmDialog({ title: t('콜라주를 닫을까요?', 'Close the collage?'), body: t('저장하지 않으면 만든 내용이 사라져요.', 'Unsaved work will be lost.'), actions: [{ label: t('계속 편집', 'Keep editing'), value: 'keep' }, { label: t('닫기', 'Close'), value: 'close', kind: 'danger' }] });
    if (v === 'close') this.app.goHome();
  }
}
