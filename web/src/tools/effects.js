// 효과: 블러·초점·아트·빛·왜곡·글리치 (스택 방식, 항목별 파라미터/강도/ON-OFF)
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn, uid } from '../store.js';
import { EFFECTS, EFFECT_CATS, getEffect, effectDefaults } from '../engine/effects.js';
import { Slider, Chips, IconBtn, Btn } from '../ui/components.js';

function drawThumb(cv, item) {
  const tmp = document.createElement('canvas'); tmp.width = item.w; tmp.height = item.h;
  tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(item.d), item.w, item.h), 0, 0);
  const c = cv.getContext('2d'), k = Math.max(cv.width / item.w, cv.height / item.h);
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(tmp, (cv.width - item.w * k) / 2, (cv.height - item.h * k) / 2, item.w * k, item.h * k);
}

export function open(ed, body) {
  let cat = 'blur', selId = null, thumbs = new Map(), geoKey = '', tok = 0;
  const catChips = Chips({ label: t('분류', 'Category'), items: EFFECT_CATS.map(([id, ko]) => ({ id, label: ko })), value: cat, onSelect: (id) => { cat = id; renderRow(); } });
  const row = h('div', { class: 'thumbs', role: 'group', 'aria-label': t('효과', 'Effects') });
  const stackEl = h('div', { class: 'chips wrap' });
  const ctl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });

  const items = () => ed.doc().fx;
  const cur = () => items().find((x) => x.id === selId) || null;
  const setFx = (id, patch, commit, label) => {
    ed.preview((d) => setIn(d, 'fx', d.fx.map((x) => (x.id === id ? { ...x, ...patch } : x))));
    if (commit) ed.commit(label || t('효과', 'Effect'));
  };

  function renderRow() {
    row.replaceChildren();
    for (const e of EFFECTS.filter((x) => x.cat === cat)) {
      const cv = h('canvas', { width: 96, height: 96, 'aria-hidden': 'true' });
      const b = h('button', { class: 'thumb', type: 'button', 'aria-label': t(e.ko, e.en), 'data-id': e.id }, cv, h('span', { class: 'tl' }, t(e.ko, e.en)));
      b.addEventListener('click', () => addEffect(e.id));
      const it = thumbs.get(e.id); if (it) drawThumb(cv, it);
      row.append(b);
    }
  }
  async function loadThumbs() {
    const d = ed.doc();
    const key = JSON.stringify([d.geo, d.retouch]);
    if (key === geoKey && thumbs.size) return;
    geoKey = key;
    const my = ++tok;
    try {
      const list = await ed.engine.thumbsFx({ geo: d.geo, retouch: d.retouch }, EFFECTS.map((x) => x.id), 96);
      if (my !== tok) return;
      thumbs = new Map(list.map((x) => [x.id, x]));
      for (const b of row.querySelectorAll('.thumb')) { const it = thumbs.get(b.dataset.id); if (it) drawThumb(b.querySelector('canvas'), it); }
    } catch (e) { console.error(e); }
  }

  function addEffect(k) {
    const item = { id: uid('f'), k, on: true, mix: 100, p: effectDefaults(k) };
    ed.apply((d) => setIn(d, 'fx', [...d.fx, item]), t('효과 추가', 'Add effect'));
    selId = item.id;
    renderStack(); renderCtl();
    ed.invalidateOverlay();
    ed.announce(t(getEffect(k).ko, getEffect(k).en));
  }

  function renderStack() {
    stackEl.replaceChildren();
    const list = items();
    if (!list.length) { stackEl.append(h('p', { class: 'sheet-note' }, t('위에서 효과를 골라 추가하세요. 여러 개를 겹칠 수 있어요.', 'Pick an effect above to add it. You can stack several.'))); return; }
    for (const it of list) {
      const def = getEffect(it.k);
      const b = h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(it.id === selId), style: { opacity: it.on === false ? '.5' : '1' } }, icon('check', 'sm chk'), t(def.ko, def.en));
      b.addEventListener('click', () => { selId = it.id; renderStack(); renderCtl(); ed.invalidateOverlay(); });
      stackEl.append(b);
    }
  }

  function renderCtl() {
    ctl.replaceChildren();
    const it = cur();
    if (!it) return;
    const def = getEffect(it.k);
    const q = { ...effectDefaults(it.k), ...it.p };
    for (const pm of def.params) {
      if (pm.type === 'select') {
        ctl.append(h('div', { class: 'sheet-sec', style: { marginTop: '4px' } }, t(pm.ko, pm.en)),
          Chips({ label: t(pm.ko, pm.en), items: pm.options.map(([v, l]) => ({ id: String(v), label: l })), value: String(q[pm.key]), onSelect: (v) => { setFx(it.id, { p: { ...cur().p, [pm.key]: +v } }, true); } }).el);
      } else {
        ctl.append(Slider({ label: t(pm.ko, pm.en), min: pm.min, max: pm.max, value: q[pm.key], def: pm.def, bipolar: pm.min < 0, step: 1,
          onInput: (v) => setFx(it.id, { p: { ...cur().p, [pm.key]: v } }, false), onChange: () => ed.commit(t(def.ko, def.en)) }).el);
      }
    }
    ctl.append(Slider({ label: t('적용 강도', 'Mix'), min: 0, max: 100, value: it.mix == null ? 100 : it.mix, def: 100, unit: '%', bipolar: false, onInput: (v) => setFx(it.id, { mix: v }, false), onChange: () => ed.commit(t('효과 강도', 'Effect mix')) }).el);
    ctl.append(h('div', { class: 'row', style: { gap: '8px' } },
      Btn(it.on === false ? t('켜기', 'Turn on') : t('끄기', 'Turn off'), 'outlined', () => { setFx(it.id, { on: it.on === false }, true); renderStack(); renderCtl(); }, it.on === false ? 'eye' : 'eye-off'),
      Btn(t('삭제', 'Remove'), 'outlined', () => { ed.apply((d) => setIn(d, 'fx', d.fx.filter((x) => x.id !== it.id)), t('효과 삭제', 'Remove effect')); selId = null; renderStack(); renderCtl(); ed.invalidateOverlay(); }, 'trash-2')));
  }

  // 캔버스 핸들 ------------------------------------------------------
  const toPct = (ev) => {
    const f = ed.frameInfo(), lp = ed.logical;
    return [((ev.x - f.x) / lp.pw) * 100, ((ev.y - f.y) / lp.ph) * 100];
  };
  const fromPct = (px, py) => {
    const f = ed.frameInfo(), lp = ed.logical;
    return ed.view.toScreen(f.x + (px / 100) * lp.pw, f.y + (py / 100) * lp.ph);
  };
  let dragging = false;
  const pointer = {
    down(ev) {
      const it = cur();
      if (!it) return false;
      const hd = getEffect(it.k).handle;
      if (!hd) return false;
      const q = { ...effectDefaults(it.k), ...it.p };
      let target;
      if (hd.kind === 'point') target = fromPct(q[hd.x], q[hd.y]);
      else target = fromPct(50, q[hd.pos]);
      if (Math.hypot(target[0] - ev.sx, target[1] - ev.sy) > 44) return false;
      dragging = true;
      return true;
    },
    move(ev) {
      const it = cur();
      if (!dragging || !it) return;
      const hd = getEffect(it.k).handle;
      const [px, py] = toPct(ev);
      const clampP = (v) => Math.max(0, Math.min(100, Math.round(v)));
      if (hd.kind === 'point') setFx(it.id, { p: { ...it.p, [hd.x]: clampP(px), [hd.y]: clampP(py) } }, false);
      else setFx(it.id, { p: { ...it.p, [hd.pos]: clampP(py) } }, false);
    },
    up() { if (dragging) { dragging = false; ed.commit(t('효과', 'Effect')); renderCtl(); } },
    cancel() { dragging = false; ed.store.revert(); },
  };
  function drawOverlay(ctx, view) {
    const it = cur();
    if (!it) return;
    const hd = getEffect(it.k).handle;
    if (!hd) return;
    const q = { ...effectDefaults(it.k), ...it.p };
    ctx.save();
    ctx.strokeStyle = '#fff'; ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.5; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 3;
    const f = ed.frameInfo(), lp = ed.logical;
    if (hd.kind === 'point') {
      const [sx, sy] = fromPct(q[hd.x], q[hd.y]);
      ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy); ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8); ctx.stroke();
      if (hd.radius) {
        const mn = Math.min(lp.pw, lp.ph);
        const r = it.k === 'radialfocus' ? (q[hd.radius] / 100) * 0.5 * mn * 1.2 : (q[hd.radius] / 100) * mn * 0.75;
        ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(sx, sy, r * view.s, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (hd.kind === 'band') {
      const w = lp.pw, hh = lp.ph, ang = (q[hd.angle] * Math.PI) / 180;
      const py = hh * (q[hd.pos] / 100), half = (q[hd.size] / 100) * 0.5 * Math.hypot(w, hh) * 0.5;
      const dx = Math.cos(ang), dy = Math.sin(ang), nx = -Math.sin(ang), ny = Math.cos(ang), L = Math.hypot(w, hh);
      const line = (off, dash) => {
        const cx = w / 2 + nx * off, cy = py + ny * off - 0;
        const a = view.toScreen(f.x + cx - dx * L, f.y + cy - dy * L), b = view.toScreen(f.x + cx + dx * L, f.y + cy + dy * L);
        ctx.setLineDash(dash ? [6, 5] : []); ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      };
      line(-half, true); line(half, true); line(0, false);
      const [sx, sy] = view.toScreen(f.x + w / 2, f.y + py);
      ctx.setLineDash([]); ctx.beginPath(); ctx.arc(sx, sy, 14, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  ed.setPeek(false);
  body.append(catChips.el, row, h('div', { class: 'sheet-sec' }, t('적용한 효과', 'Applied')), stackEl, ctl);
  ed.setActions([Btn(t('모두 지우기', 'Clear all'), 'text', () => { ed.apply((d) => setIn(d, 'fx', []), t('효과 초기화', 'Clear effects')); selId = null; renderStack(); renderCtl(); ed.invalidateOverlay(); }), IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);
  selId = items().length ? items()[items().length - 1].id : null;
  renderRow(); renderStack(); renderCtl(); loadThumbs();
  return { pointer, drawOverlay, refresh() { selId = null; renderStack(); renderCtl(); } };
}
