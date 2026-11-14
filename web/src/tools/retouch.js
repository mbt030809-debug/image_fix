// 리터치: 치유 / 복제 / 지우기(인페인팅) / 리퀴파이 + 인물 보정 바로가기
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { Segmented, Chips, Slider, Btn, IconBtn, toast } from '../ui/components.js';
import { canvasToSource, orientedSize, apply3 } from '../engine/geometry.js';

export function contentToSource(ed, cx, cy) {
  const [u, v] = ed.contentToCanvas(cx, cy);
  const info = ed.info, geo = ed.doc().geo;
  const [Wo, Ho] = orientedSize(info.w, info.h, geo);
  const M = canvasToSource(geo, info.w, info.h);
  const [sx, sy] = apply3(M, u * Wo, v * Ho);
  return [sx / info.w, sy / info.h];
}

const FACE = [['smooth', '피부 매끄럽게', 'Smooth skin'], ['teeth', '치아 미백', 'Whiten teeth'], ['eyes', '눈 밝게', 'Brighten eyes'], ['redeye', '적목 제거', 'Remove red-eye']];

export function open(ed, body) {
  const st = Object.assign({ mode: 'heal', size: 8, soft: 60, op: 100, liq: 'push', str: 60 }, ed.app.settings.retouch || {});
  let src = null, offset = null, setSrc = false, cur = null, last = 0, trail = [], cursor = null;
  const save = () => { ed.app.settings.retouch = { ...st }; ed.app.saveSettings(); };

  const seg = Segmented({ label: t('도구', 'Tool'), items: [{ id: 'heal', label: t('치유', 'Heal') }, { id: 'clone', label: t('복제', 'Clone') }, { id: 'erase', label: t('지우기', 'Erase') }, { id: 'liq', label: t('유동화', 'Liquify') }], value: st.mode, onChange: (v) => { st.mode = v; save(); renderCtl(); ed.invalidateOverlay(); } });
  const ctl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } });
  const radius = () => st.size / 300;

  function renderCtl() {
    ctl.replaceChildren();
    const mk = (label, key, min, max, def, unit = '') => Slider({ label, min, max, value: st[key], def, unit, bipolar: false, onInput: (v) => { st[key] = v; }, onChange: save }).el;
    if (st.mode === 'heal' || st.mode === 'clone') {
      ctl.append(h('p', { class: 'sheet-note' }, src ? t('복사할 부분을 문지르세요. 소스를 바꾸려면 아래 버튼을 누르고 다시 지정하세요.', 'Brush over the area to cover. To change the source, tap the button below and pick again.') : t('먼저 복사할 부분(소스)을 사진에서 한 번 눌러 지정하세요.', 'First tap a spot on the photo to use as the source.')),
        Btn(src ? t('소스 다시 지정', 'Pick source again') : t('소스 지정', 'Pick source'), 'outlined', () => { setSrc = true; toast(t('소스로 쓸 곳을 눌러 주세요', 'Tap the source spot')); }, 'crosshair'));
    } else if (st.mode === 'erase') {
      ctl.append(h('p', { class: 'sheet-note' }, t('지우고 싶은 물체 위를 문지르면 주변 질감으로 채워져요. 작은 물체에 가장 잘 맞아요.', 'Brush over an object to fill it from its surroundings. Works best on small objects.')));
    } else {
      ctl.append(h('p', { class: 'sheet-note' }, t('픽셀 유동화: 사진을 손가락으로 밀거나 부풀리고 비틀어 모양을 바꿔요.', 'Pixel liquify: push, bloat, pinch or twirl the photo with your finger.')), Chips({ label: t('유동화 모드', 'Liquify mode'), items: [{ id: 'push', label: t('밀기', 'Push') }, { id: 'bloat', label: t('확대', 'Bloat') }, { id: 'pinch', label: t('축소', 'Pinch') }, { id: 'twirl', label: t('비틀기 ↻', 'Twirl ↻') }, { id: 'twirlL', label: t('비틀기 ↺', 'Twirl ↺') }, { id: 'recon', label: t('복원', 'Restore') }], value: st.liq, onSelect: (v) => { st.liq = v; save(); } }).el, mk(t('강도', 'Strength'), 'str', 5, 100, 60, '%'));
    }
    ctl.append(mk(t('브러시 크기', 'Brush size'), 'size', 1, 60, 8));
    if (st.mode !== 'liq') ctl.append(mk(t('부드러움', 'Softness'), 'soft', 0, 100, 60, '%'));
    if (st.mode === 'heal' || st.mode === 'clone') ctl.append(mk(t('불투명도', 'Opacity'), 'op', 10, 100, 100, '%'));
    ctl.append(h('div', { class: 'sheet-sec' }, t('인물 보정 (브러시로 칠하기)', 'Portrait retouch (paint with brush)')),
      Chips({ label: t('인물 보정', 'Portrait'), items: FACE.map(([id, ko, en]) => ({ id, label: t(ko, en) })), onSelect: (id) => { ed.openTool('brush'); ed.tool && ed.tool.startPreset && ed.tool.startPreset(id); } }).el);
  }

  ed.setPeek(false);
  body.append(seg.el, ctl);
  renderCtl();
  ed.setActions([IconBtn('check', t('완료', 'Done'), () => ed.closeTool(true), 'tint')]);

  const makeOp = (pts) => {
    const r = radius();
    if (st.mode === 'heal' || st.mode === 'clone') return { k: 'clone', mode: st.mode, ox: offset[0], oy: offset[1], r, soft: st.soft / 100, op: st.op / 100, pts };
    if (st.mode === 'erase') return { k: 'erase', r, pts };
    return { k: 'liq', mode: st.liq, r, str: st.str / 100, pts };
  };
  const withOp = (d, op) => setIn(d, 'retouch', [...d.retouch, op]);

  const pointer = {
    down(ev) {
      cursor = [ev.sx, ev.sy];
      const p = contentToSource(ed, ev.x, ev.y);
      if (st.mode === 'heal' || st.mode === 'clone') {
        if (!src || setSrc) { src = p; offset = null; setSrc = false; renderCtl(); ed.invalidateOverlay(); return true; }
        if (!offset) offset = [src[0] - p[0], src[1] - p[1]];
      }
      cur = { pts: [p[0], p[1]] };
      trail = [[ev.sx, ev.sy]];
      last = 0;
      ed.invalidateOverlay();
      return true;
    },
    move(ev) {
      cursor = [ev.sx, ev.sy];
      if (!cur) { ed.invalidateOverlay(); return; }
      const p = contentToSource(ed, ev.x, ev.y);
      const n = cur.pts.length;
      if (Math.hypot(cur.pts[n - 2] - p[0], cur.pts[n - 1] - p[1]) < radius() * 0.12) return;
      cur.pts.push(p[0], p[1]);
      trail.push([ev.sx, ev.sy]);
      const now = performance.now();
      if (st.mode !== 'erase' && now - last > 90) { last = now; const op = makeOp(cur.pts.slice()); ed.preview((d) => withOp(d, op)); }
      ed.invalidateOverlay();
    },
    up() {
      if (!cur) return;
      const pts = cur.pts.slice(); cur = null; trail = [];
      ed.store.revert();
      const op = makeOp(pts);
      ed.apply((d) => withOp(d, op), t('리터치', 'Retouch'));
      ed.invalidateOverlay();
    },
    cancel() { cur = null; trail = []; ed.store.revert(); ed.invalidateOverlay(); },
  };

  function drawOverlay(ctx, view) {
    const r = radius() * ed.unit() * view.s;
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 3;
    if (st.mode === 'erase' && trail.length) { ctx.fillStyle = 'rgba(255,70,70,.28)'; for (const [x, y] of trail) { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); } }
    if (cursor && cur) { ctx.beginPath(); ctx.arc(cursor[0], cursor[1], r, 0, Math.PI * 2); ctx.stroke(); }
    if ((st.mode === 'heal' || st.mode === 'clone') && src) {
      const f = ed.frameInfo();
      // 소스 점을 화면으로: 현재 오프셋이 있으면 현재 브러시 위치 + 오프셋을 보여주는 대신 최초 지정 지점을 표시
      const sp = srcToScreen(src);
      if (sp) { ctx.beginPath(); ctx.arc(sp[0], sp[1], 12, 0, Math.PI * 2); ctx.moveTo(sp[0] - 18, sp[1]); ctx.lineTo(sp[0] + 18, sp[1]); ctx.moveTo(sp[0], sp[1] - 18); ctx.lineTo(sp[0], sp[1] + 18); ctx.stroke(); }
      void f;
    }
    ctx.restore();
  }
  // 원본 좌표 → 화면 (현재 지오메트리를 역으로: 근사. 회전/원근이 없으면 정확)
  function srcToScreen(p) {
    const info = ed.info, geo = ed.doc().geo;
    // 캔버스 → 원본 행렬의 역을 사용
    const M = canvasToSource(geo, info.w, info.h);
    const inv = invert3(M);
    if (!inv) return null;
    const [Wo, Ho] = orientedSize(info.w, info.h, geo);
    const [cx, cy] = apply3(inv, p[0] * info.w, p[1] * info.h);
    const [lx, ly] = ed.canvasToContent(cx / Wo, cy / Ho);
    return ed.view.toScreen(lx, ly);
  }
  function invert3(m) {
    const [a, b, c, d, e, f, g, hh, i] = m;
    const A = e * i - f * hh, B = -(d * i - f * g), C = d * hh - e * g, det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    const k = 1 / det;
    return [A * k, -(b * i - c * hh) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, -(a * f - c * d) * k, C * k, -(a * hh - b * g) * k, (a * e - b * d) * k];
  }

  return { pointer, drawOverlay, refresh() {}, debug: () => ({ src, offset, scr: src && srcToScreen(src) }) };
}
