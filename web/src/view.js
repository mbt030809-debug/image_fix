// 캔버스 뷰포트: 줌/팬/핀치 + 도구 포인터 라우팅 + 화면 좌표 오버레이
import { h } from './ui/dom.js';
import { reducedMotion } from './ui/dom.js';

export class View {
  constructor(stage) {
    this.stage = stage;
    this.photo = h('canvas', { class: 'photo', role: 'img' });
    this.ui = h('canvas', { class: 'uicv', 'aria-hidden': 'true' });
    stage.append(this.photo, this.ui);
    this.cw = 0; this.ch = 0;          // 콘텐츠 논리 크기(px)
    this.s = 1; this.tx = 0; this.ty = 0;
    this.fitS = 1; this.fitted = true;
    this.pad = 12;
    this.ptrs = new Map();
    this.mode = null;
    this.handler = null;
    this.onView = null;
    this.pxScale = 1;                   // 원본 px / 논리 px (줌 % 표시용)
    this.lastTap = null;
    this.sw = 0; this.sh = 0;
    this._bind();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(stage);
  }

  setHandler(hd) { this.handler = hd || null; }
  get dpr() { return Math.min(3, window.devicePixelRatio || 1); }

  /** 논리 콘텐츠 크기 지정. 크기/비율이 바뀌면 맞춤 */
  setContent(cw, ch, forceFit) {
    const changed = Math.abs(cw - this.cw) > 0.5 || Math.abs(ch - this.ch) > 0.5;
    const ratioChanged = this.ch === 0 || Math.abs(cw / ch - this.cw / this.ch) > 0.002;
    this.cw = cw; this.ch = ch;
    this.photo.style.width = cw + 'px'; this.photo.style.height = ch + 'px';
    if (forceFit || ratioChanged) { this.fit(false); }
    else if (changed) { this.computeFit(); this.apply(); }
  }

  resize() {
    const r = this.stage.getBoundingClientRect();
    this.sw = r.width; this.sh = r.height;
    const dpr = this.dpr;
    this.ui.width = Math.max(1, Math.round(r.width * dpr)); this.ui.height = Math.max(1, Math.round(r.height * dpr));
    this.ui.style.width = r.width + 'px'; this.ui.style.height = r.height + 'px';
    const was = this.fitted;
    this.computeFit();
    if (was || this.s < this.fitS) this.fit(false); else { this.clampPan(); this.apply(); }
    this.onResize && this.onResize();
  }

  computeFit() {
    if (!this.cw || !this.ch || !this.sw || !this.sh) { this.fitS = 1; return; }
    this.fitS = Math.min((this.sw - this.pad * 2) / this.cw, (this.sh - this.pad * 2) / this.ch);
    if (!(this.fitS > 0)) this.fitS = 1;
  }

  fit(animate) {
    this.computeFit();
    this.s = this.fitS;
    this.tx = (this.sw - this.cw * this.s) / 2;
    this.ty = (this.sh - this.ch * this.s) / 2;
    this.fitted = true;
    this.apply(animate);
  }

  get maxS() { return Math.max(this.fitS * 8, 6 / this.dpr); }

  clampPan() {
    const cw = this.cw * this.s, ch = this.ch * this.s, m = 48;
    if (cw <= this.sw) this.tx = (this.sw - cw) / 2; else this.tx = Math.min(m, Math.max(this.sw - cw - m, this.tx));
    if (ch <= this.sh) this.ty = (this.sh - ch) / 2; else this.ty = Math.min(m, Math.max(this.sh - ch - m, this.ty));
  }

  apply(animate) {
    this.clampPan();
    const el = this.photo;
    if (animate && !reducedMotion()) {
      el.style.transition = 'transform 260ms cubic-bezier(.2,0,0,1)';
      clearTimeout(this._tt); this._tt = setTimeout(() => { el.style.transition = ''; }, 300);
    }
    el.style.transform = `translate(${this.tx}px,${this.ty}px) scale(${this.s})`;
    this.fitted = Math.abs(this.s - this.fitS) < 1e-3;
    this.onView && this.onView();
  }

  zoomAt(sx, sy, factor, animate) {
    const ns = Math.min(this.maxS, Math.max(this.fitS, this.s * factor));
    const k = ns / this.s;
    this.tx = sx - (sx - this.tx) * k; this.ty = sy - (sy - this.ty) * k;
    this.s = ns;
    this.apply(animate);
  }
  setZoomTo(s, animate) { this.zoomAt(this.sw / 2, this.sh / 2, s / this.s, animate); }
  zoomPercent() { return Math.round(this.s * this.pxScale * 100); }
  cycleZoom() {
    if (this.fitted) this.setZoomTo(Math.min(this.maxS, 1 / this.pxScale), true);
    else if (this.s * this.pxScale < 1.9 && 2 / this.pxScale <= this.maxS) this.setZoomTo(2 / this.pxScale, true);
    else this.fit(true);
  }

  // 좌표 변환 ---------------------------------------------------------
  toContent(sx, sy) { return [(sx - this.tx) / this.s, (sy - this.ty) / this.s]; }
  toScreen(x, y) { return [x * this.s + this.tx, y * this.s + this.ty]; }
  rel(e) { const r = this.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  ev(e) {
    const [sx, sy] = this.rel(e);
    const [x, y] = this.toContent(sx, sy);
    return { x, y, sx, sy, e, id: e.pointerId, type: e.pointerType, pressure: e.pressure, view: this };
  }

  // 오버레이 --------------------------------------------------------
  overlay() {
    const c = this.ui.getContext('2d');
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.sw, this.sh);
    return c;
  }

  // 포인터 ----------------------------------------------------------
  _bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this._down(e));
    st.addEventListener('pointermove', (e) => this._move(e));
    st.addEventListener('pointerup', (e) => this._up(e));
    st.addEventListener('pointercancel', (e) => this._up(e, true));
    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this.rel(e);
      this.zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
    }, { passive: false });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _down(e) {
    if (e.target.closest && e.target.closest('button')) return;
    try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    const [sx, sy] = this.rel(e);
    this.ptrs.set(e.pointerId, { sx, sy, x0: sx, y0: sy, t0: performance.now() });
    if (this.ptrs.size === 1) {
      const consumed = this.handler && this.handler.down && this.handler.down(this.ev(e));
      this.mode = consumed ? 'tool' : 'pan';
      this.pan0 = { tx: this.tx, ty: this.ty, sx, sy };
      this.moved = false;
    } else if (this.ptrs.size === 2) {
      if (this.mode === 'tool') this.handler && this.handler.cancel && this.handler.cancel();
      this.mode = 'pinch';
      const [a, b] = [...this.ptrs.values()];
      this.pinch0 = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2, s: this.s, tx: this.tx, ty: this.ty };
    }
  }

  _move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    const [sx, sy] = this.rel(e);
    p.sx = sx; p.sy = sy;
    if (this.mode === 'tool') { this.handler.move && this.handler.move(this.ev(e)); return; }
    if (this.mode === 'pinch' && this.ptrs.size >= 2) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx = (a.sx + b.sx) / 2, cy = (a.sy + b.sy) / 2;
      const p0 = this.pinch0;
      const ns = Math.min(this.maxS, Math.max(this.fitS * 0.6, p0.s * (d / p0.d)));
      this.s = ns;
      this.tx = cx - (p0.cx - p0.tx) * (ns / p0.s); this.ty = cy - (p0.cy - p0.ty) * (ns / p0.s);
      this.moved = true;
      this.apply();
      return;
    }
    if (this.mode === 'pan') {
      if (Math.hypot(sx - p.x0, sy - p.y0) > 6) this.moved = true;
      if (this.s > this.fitS * 1.001 || !this.fitted) {
        this.tx = this.pan0.tx + (sx - this.pan0.sx); this.ty = this.pan0.ty + (sy - this.pan0.sy);
        this.apply();
      }
    }
  }

  _up(e, cancelled) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    this.ptrs.delete(e.pointerId);
    try { this.stage.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
    if (this.mode === 'tool') {
      if (cancelled) this.handler.cancel && this.handler.cancel();
      else this.handler.up && this.handler.up(this.ev(e));
      this.mode = null;
      return;
    }
    if (this.mode === 'pinch') {
      if (this.s < this.fitS) this.fit(true);
      if (this.ptrs.size === 1) {
        const q = [...this.ptrs.values()][0];
        this.mode = 'pan'; this.pan0 = { tx: this.tx, ty: this.ty, sx: q.sx, sy: q.sy }; this.moved = true;
      } else if (this.ptrs.size === 0) this.mode = null;
      return;
    }
    if (this.mode === 'pan' && !cancelled) {
      // 탭 / 더블탭
      const now = performance.now();
      if (!this.moved && now - p.t0 < 300) {
        if (this.lastTap && now - this.lastTap.t < 320 && Math.hypot(this.lastTap.x - p.sx, this.lastTap.y - p.sy) < 40) {
          this.lastTap = null;
          if (this.fitted) this.zoomAt(p.sx, p.sy, Math.min(this.maxS / this.s, Math.max(2.5, 1 / (this.pxScale * this.s))), true);
          else this.fit(true);
        } else {
          this.lastTap = { t: now, x: p.sx, y: p.sy };
          this.handler && this.handler.tap && this.handler.tap(this.ev(e));
        }
      }
    }
    if (this.ptrs.size === 0) this.mode = null;
  }
}
