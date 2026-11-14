// 레이어 선택/이동/크기·회전 제스처 + 선택 박스 오버레이 (텍스트·스티커 공용)
import { hitLayer, layerBox } from '../compose.js';

const HANDLE = 14;

/** o.types: 선택 가능한 레이어 타입 배열 / o.onSelect(layer|null) / o.onEnd() */
export function LayerKit(ed, o) {
  let drag = null;

  const box = (L) => {
    const g = ed.geom();
    const b = layerBox(L, g, ed.assets);
    const f = ed.frameInfo();
    return { ...b, cx: b.cx + f.x, cy: b.cy + f.y };
  };
  const corners = (b) => {
    const a = (b.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const pts = [[-b.w / 2, -b.h / 2], [b.w / 2, -b.h / 2], [b.w / 2, b.h / 2], [-b.w / 2, b.h / 2]];
    return pts.map(([x, y]) => [b.cx + x * c - y * s, b.cy + x * s + y * c]);
  };
  const handlePos = (b, kind) => { // 콘텐츠 px
    const a = (b.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const loc = kind === 'scale' ? [b.w / 2, b.h / 2] : [0, -b.h / 2 - 34 / ed.view.s];
    return [b.cx + loc[0] * c - loc[1] * s, b.cy + loc[0] * s + loc[1] * c];
  };
  const selected = () => (ed.sel ? ed.layerById(ed.sel) : null);

  function sizePatch(L, k) {
    if (L.t === 'text' || L.t === 'emoji') return { size: Math.max(0.01, Math.min(2, L.size * k)) };
    return { w: Math.max(0.01, Math.min(3, L.w * k)), h: L.h == null ? undefined : Math.max(0.01, Math.min(3, L.h * k)) };
  }

  const pointer = {
    down(ev) {
      const L = selected();
      if (L && o.types.includes(L.t) && !L.lock) {
        const b = box(L);
        for (const kind of ['scale', 'rotate']) {
          const [hx, hy] = handlePos(b, kind);
          const [sx, sy] = ed.view.toScreen(hx, hy);
          if (Math.hypot(sx - ev.sx, sy - ev.sy) <= 26) {
            drag = { kind, L: { ...L }, b, cx: b.cx, cy: b.cy, a0: Math.atan2(ev.y - b.cy, ev.x - b.cx), d0: Math.hypot(ev.x - b.cx, ev.y - b.cy) || 1 };
            return true;
          }
        }
      }
      // 위에서부터 히트 테스트
      const layers = ed.doc().layers;
      const g = ed.geom(), f = ed.frameInfo();
      for (let i = layers.length - 1; i >= 0; i--) {
        const l = layers[i];
        if (!o.types.includes(l.t)) continue;
        if (hitLayer(l, g, ed.assets, ev.x - f.x, ev.y - f.y)) {
          if (ed.sel !== l.id) { ed.sel = l.id; o.onSelect && o.onSelect(l); }
          drag = { kind: 'move', L: { ...l }, startX: ev.x, startY: ev.y, moved: false };
          ed.invalidateOverlay();
          return true;
        }
      }
      if (ed.sel) { ed.sel = null; o.onSelect && o.onSelect(null); ed.invalidateOverlay(); }
      return false;
    },
    move(ev) {
      if (!drag) return;
      const L = drag.L;
      if (drag.kind === 'move') {
        if (!drag.moved && Math.hypot(ev.x - drag.startX, ev.y - drag.startY) < 3 / ed.view.s) return;
        drag.moved = true;
        const f = ed.frameInfo();
        const start = ed.canvasToContent(L.x, L.y);
        const [nx, ny] = ed.contentToCanvas(start[0] + (ev.x - drag.startX), start[1] + (ev.y - drag.startY));
        ed.updateLayer(L.id, { x: Math.max(-0.2, Math.min(1.2, nx)), y: Math.max(-0.2, Math.min(1.2, ny)) });
        void f;
      } else {
        const d = Math.hypot(ev.x - drag.cx, ev.y - drag.cy) || 1;
        const a = Math.atan2(ev.y - drag.cy, ev.x - drag.cx);
        if (drag.kind === 'scale') {
          const patch = sizePatch(L, d / drag.d0);
          ed.updateLayer(L.id, { ...patch, rot: Math.round(((L.rot || 0) + ((a - drag.a0) * 180) / Math.PI) * 10) / 10 });
        } else {
          ed.updateLayer(L.id, { rot: Math.round((((a + Math.PI / 2) * 180) / Math.PI) * 10) / 10 });
        }
      }
    },
    up() {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.kind !== 'move' || d.moved) ed.commit(d.kind === 'move' ? '이동' : '크기/회전');
      o.onEnd && o.onEnd();
      ed.invalidateOverlay();
    },
    cancel() { if (drag) { drag = null; ed.store.revert(); } },
  };

  function drawOverlay(ctx, view) {
    const L = selected();
    if (!L || !o.types.includes(L.t)) return;
    const b = box(L);
    const pts = corners(b).map(([x, y]) => view.toScreen(x, y));
    ctx.save();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffffff'; ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 3;
    ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.stroke();
    ctx.shadowBlur = 0;
    // 회전 핸들
    const [rx, ry] = view.toScreen(...handlePos(b, 'rotate'));
    const top = [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2];
    ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(rx, ry); ctx.stroke();
    const dot = (x, y, fill) => { ctx.beginPath(); ctx.arc(x, y, HANDLE, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.35)'; ctx.stroke(); };
    dot(rx, ry, '#ffffff');
    const [sx, sy] = view.toScreen(...handlePos(b, 'scale'));
    dot(sx, sy, '#ffffff');
    // 아이콘 (↻ / ⤡)
    ctx.strokeStyle = '#1c1c1c'; ctx.lineWidth = 1.8; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(rx, ry, 5, -0.6, Math.PI * 1.45); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sx - 4, sy + 4); ctx.lineTo(sx + 4, sy - 4); ctx.moveTo(sx + 4, sy - 1); ctx.lineTo(sx + 4, sy - 4); ctx.lineTo(sx + 1, sy - 4); ctx.moveTo(sx - 4, sy + 1); ctx.lineTo(sx - 4, sy + 4); ctx.lineTo(sx - 1, sy + 4); ctx.stroke();
    ctx.restore();
  }

  return { pointer, drawOverlay };
}
