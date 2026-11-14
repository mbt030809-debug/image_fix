// 배경 제거: 자동(단색 배경) / 마술봉 / 지우기·복원 브러시 + 경계 다듬기 + 배경 교체
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { Segmented, Chips, Slider, Btn, IconBtn, toast } from '../ui/components.js';
import { ColorField } from './colorfield.js';
import { contentToSource } from './retouch.js';
import { bridge } from '../bridge.js';

let keySeq = 1;

export function open(ed, body) {
  ed.masks = ed.masks || new Map();
  const info = ed.info;
  const k0 = Math.min(1, 1024 / Math.max(info.w, info.h));
  let mw = Math.round(info.w * k0), mh = Math.round(info.h * k0);
  const cutOp = () => ed.doc().retouch.find((o) => o.k === 'cut') || null;
  const st = { mode: 'wand', size: 14, tol: 28, contig: true, feather: 0, grow: 0 };
  let mask = null, cur = null, last = 0, cursor = null, busy = false;

  function loadMask() {
    const op = cutOp();
    const m = op && ed.masks.get(op.mask);
    if (m) { mw = m.w; mh = m.h; mask = Uint8Array.from(m.data); st.feather = op.feather || 0; st.grow = op.grow || 0; }
    else { mask = new Uint8Array(mw * mh).fill(255); }
  }
  loadMask();

  async function push(commit, label) {
    const key = commit ? 'cut' + keySeq++ : 'cut-live';
    const copy = mask.slice();
    ed.masks.set(key, { w: mw, h: mh, data: commit ? copy.slice() : copy });
    await ed.engine.setAsset(key, 'mask', { w: mw, h: mh, buffer: copy.buffer });
    const op = { k: 'cut', mask: key, feather: st.feather, grow: st.grow };
    const apply = (d) => setIn(d, 'retouch', [...d.retouch.filter((o) => o.k !== 'cut'), op]);
    if (commit) ed.apply(apply, label || t('배경 제거', 'Remove background')); else ed.preview(apply);
  }
  const isFullKeep = () => { for (let i = 0; i < mask.length; i++) if (mask[i] !== 255) return false; return true; };

  async function runWand(o, apply) {
    if (busy) return;
    busy = true;
    try { const r = await ed.engine.wand(o); mw = r.w; mh = r.h; if (mask.length !== mw * mh) mask = new Uint8Array(mw * mh).fill(255); apply(r.data); await push(true); }
    catch (e) { console.error(e); toast(t('처리하지 못했어요.', "Couldn't process.")); }
    finally { busy = false; }
  }

  const seg = Segmented({ label: t('도구', 'Tool'), items: [{ id: 'wand', label: t('마술봉', 'Wand') }, { id: 'erase', label: t('지우기', 'Erase') }, { id: 'restore', label: t('복원', 'Restore') }], value: st.mode, onChange: (v) => { st.mode = v; renderCtl(); } });
  const ctl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const bgBox = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  function renderCtl() {
    ctl.replaceChildren();
    const auto = Btn(t('자동 (단색 배경)', 'Auto (plain background)'), 'tonal', () => runWand({ auto: true, tol: st.tol }, (bg) => { for (let i = 0; i < mask.length; i++) mask[i] = bg[i] ? 0 : 255; }), 'wand-sparkles');
    ctl.append(auto);
    if (st.mode === 'wand') {
      ctl.append(h('p', { class: 'sheet-note' }, t('지울 배경을 눌러 선택해요. 허용 범위를 키우면 비슷한 색이 함께 선택돼요.', 'Tap the background to remove it. A larger tolerance selects similar colors too.')),
        Slider({ label: t('허용 범위', 'Tolerance'), min: 3, max: 90, value: st.tol, def: 28, bipolar: false, onInput: (v) => { st.tol = v; } }).el,
        h('div', { class: 'row' }, Btn(st.contig ? t('연결된 영역만', 'Connected only') : t('모든 비슷한 색', 'All similar colors'), 'outlined', () => { st.contig = !st.contig; renderCtl(); })));
    } else {
      ctl.append(h('p', { class: 'sheet-note' }, st.mode === 'erase' ? t('남기지 않을 부분을 문질러 지워요.', 'Brush over parts to remove.') : t('잘못 지워진 부분을 문질러 되살려요.', 'Brush over parts to bring them back.')),
        Slider({ label: t('브러시 크기', 'Brush size'), min: 2, max: 60, value: st.size, def: 14, bipolar: false, onInput: (v) => { st.size = v; } }).el);
    }
    ctl.append(Slider({ label: t('경계 부드럽게', 'Edge softness'), min: 0, max: 100, value: st.feather, def: 0, bipolar: false, onInput: (v) => { st.feather = v; if (cutOp()) push(false); }, onChange: () => { if (cutOp()) push(true, t('경계', 'Edge')); } }).el,
      Slider({ label: t('경계 넓히기/좁히기', 'Grow / shrink edge'), min: -100, max: 100, value: st.grow, def: 0, onInput: (v) => { st.grow = v; if (cutOp()) push(false); }, onChange: () => { if (cutOp()) push(true, t('경계', 'Edge')); } }).el,
      h('div', { class: 'row wrap' },
        Btn(t('선택 반전', 'Invert'), 'outlined', () => { for (let i = 0; i < mask.length; i++) mask[i] = 255 - mask[i]; push(true); }, 'eclipse'),
        Btn(t('되돌리기', 'Reset'), 'outlined', () => { ed.apply((d) => setIn(d, 'retouch', d.retouch.filter((o) => o.k !== 'cut')), t('배경 복원', 'Restore')); loadMask(); mask.fill(255); }, 'refresh-cw')));
  }

  function renderBg() {
    bgBox.replaceChildren();
    const bg = ed.doc().bg || { type: 'none' };
    const chips = Chips({ label: t('배경', 'Background'), items: [{ id: 'none', label: t('투명', 'Transparent') }, { id: 'color', label: t('단색', 'Solid') }, { id: 'gradient', label: t('그라데이션', 'Gradient') }, { id: 'image', label: t('사진', 'Photo') }], value: bg.type, onSelect: async (id) => {
      if (id === 'image') {
        const files = await bridge.pickFile('image/*');
        if (!files.length) { chips.set(bg.type); return; }
        const key = await ed.addImageAsset(files[0]);
        ed.apply((d) => setIn(d, 'bg', { type: 'image', asset: key }), t('배경 교체', 'Replace background'));
      } else ed.apply((d) => setIn(d, 'bg', id === 'none' ? { type: 'none' } : id === 'color' ? { type: 'color', color: (d.bg && d.bg.color) || '#ffffff' } : { type: 'gradient', color: '#ff9a9e', color2: '#fad0c4', angle: 135 }), t('배경 교체', 'Replace background'));
      renderBg();
    } });
    bgBox.append(h('div', { class: 'sheet-sec' }, t('배경 바꾸기', 'Replace background')), chips.el);
    if (bg.type === 'color') bgBox.append(ColorField(ed, { label: t('배경 색', 'Background color'), value: bg.color, onChange: (c, commit) => { ed.preview((d) => setIn(d, 'bg', { ...d.bg, color: c })); if (commit) ed.commit(t('배경 색', 'Background color')); } }).el);
    if (bg.type === 'gradient') bgBox.append(ColorField(ed, { label: t('시작 색', 'Start'), value: bg.color, onChange: (c, commit) => { ed.preview((d) => setIn(d, 'bg', { ...d.bg, color: c })); if (commit) ed.commit(t('배경', 'Background')); } }).el,
      ColorField(ed, { label: t('끝 색', 'End'), value: bg.color2, onChange: (c, commit) => { ed.preview((d) => setIn(d, 'bg', { ...d.bg, color2: c })); if (commit) ed.commit(t('배경', 'Background')); } }).el);
  }

  // 마스크 편집 -----------------------------------------------------
  function stamp(sx, sy, restore) {
    const cx = sx * mw, cy = sy * mh, r = (st.size / 300) * Math.min(mw, mh), hard = r * 0.35;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(mw - 1, Math.ceil(cx + r)), y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(mh - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > r) continue;
      const f = d <= hard ? 1 : 1 - (d - hard) / (r - hard);
      const i = y * mw + x;
      if (restore) mask[i] = Math.max(mask[i], 255 * f); else mask[i] = Math.min(mask[i], 255 * (1 - f));
    }
  }
  function strokeTo(a, b, restore) {
    const len = Math.hypot((b[0] - a[0]) * mw, (b[1] - a[1]) * mh), n = Math.max(1, Math.ceil(len / Math.max(1, ((st.size / 300) * Math.min(mw, mh)) * 0.3)));
    for (let i = 0; i <= n; i++) stamp(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, restore);
  }

  const pointer = {
    down(ev) {
      cursor = [ev.sx, ev.sy];
      if (st.mode === 'wand') return false;
      const p = contentToSource(ed, ev.x, ev.y);
      cur = { prev: p, restore: st.mode === 'restore' };
      strokeTo(p, p, cur.restore);
      last = 0; push(false); ed.invalidateOverlay();
      return true;
    },
    move(ev) {
      cursor = [ev.sx, ev.sy];
      if (!cur) return;
      const p = contentToSource(ed, ev.x, ev.y);
      strokeTo(cur.prev, p, cur.restore); cur.prev = p;
      const now = performance.now();
      if (now - last > 110) { last = now; push(false); }
      ed.invalidateOverlay();
    },
    up() { if (cur) { cur = null; push(true, st.mode === 'restore' ? t('복원', 'Restore') : t('지우기', 'Erase')); ed.invalidateOverlay(); } },
    cancel() { cur = null; ed.store.revert(); loadMask(); },
    tap(ev) {
      if (st.mode !== 'wand') return;
      const [x, y] = contentToSource(ed, ev.x, ev.y);
      runWand({ x, y, tol: st.tol, contiguous: st.contig }, (sel) => { for (let i = 0; i < mask.length; i++) if (sel[i]) mask[i] = 0; });
    },
  };
  function drawOverlay(ctx, view) {
    if (cursor && cur) {
      const f = ed.frameInfo(), lp = ed.logical;
      const r = (st.size / 300) * Math.min(lp.pw, lp.ph) * view.s;
      ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 3;
      ctx.beginPath(); ctx.arc(cursor[0], cursor[1], r, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); void f;
    }
  }

  ed.setPeek(false);
  body.append(seg.el, ctl, bgBox);
  renderCtl(); renderBg();
  ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  return { pointer, drawOverlay, refresh() { loadMask(); renderCtl(); renderBg(); }, onDoc(kind) { if (kind === 'commit') renderBg(); } };
}
