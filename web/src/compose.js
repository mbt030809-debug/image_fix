// 합성: 보정된 사진 위에 레이어(텍스트/이모지/도형/그리기/이미지)를 그리고 프레임/배경을 입힌다.
// 레이어 좌표는 "캔버스 정규화"(자르기 전 방향 적용 캔버스 기준), 크기는 캔버스 짧은 변(unit) 대비 비율.
import { shapePath, OPEN_SHAPES } from './shapes.js';
import { mulberry32 } from './engine/util.js';

export const FONTS = {
  sans: { ko: '고딕', en: 'Sans', w: 500, stack: '"Noto Sans KR","Noto Sans CJK KR",Roboto,"Apple SD Gothic Neo","Malgun Gothic",system-ui,sans-serif' },
  black: { ko: '굵은 고딕', en: 'Black', w: 900, stack: '"Noto Sans KR","Noto Sans CJK KR",Roboto,"Arial Black",system-ui,sans-serif' },
  serif: { ko: '명조', en: 'Serif', w: 500, stack: '"Noto Serif KR","Noto Serif CJK KR","Source Serif 4",Georgia,"Times New Roman",serif' },
  rounded: { ko: '둥근', en: 'Rounded', w: 600, stack: '"Google Sans","Nunito","Noto Sans KR","Noto Sans CJK KR",system-ui,sans-serif' },
  hand: { ko: '손글씨', en: 'Handwriting', w: 500, stack: '"Nanum Pen Script","Dancing Script","Segoe Script","Noto Sans KR",cursive' },
  script: { ko: '필기체', en: 'Script', w: 500, stack: '"Dancing Script","Brush Script MT","Segoe Script",cursive' },
  mono: { ko: '고정폭', en: 'Mono', w: 500, stack: '"Roboto Mono","Noto Sans Mono CJK KR","Courier New",monospace' },
  impact: { ko: '임팩트', en: 'Impact', w: 900, stack: 'Impact,"Anton","Arial Black","Noto Sans KR","Noto Sans CJK KR",sans-serif' },
};
const EMOJI_STACK = '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji","Twemoji Mozilla",sans-serif';

let mctx = null;
function measureCtx() {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  return mctx;
}

export function fontCss(L, fs) {
  const f = FONTS[L.font] || FONTS.sans;
  const w = L.bold ? Math.min(900, (f.w || 500) + 300) : f.w || 500;
  return `${L.italic ? 'italic ' : ''}${w} ${fs}px ${f.stack}`;
}

function layoutText(ctx, L, fs) {
  ctx.font = fontCss(L, fs);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${(L.spacing || 0) * fs}px`;
  const lines = String(L.text == null ? '' : L.text).split('\n');
  const lh = fs * (L.lineH || 1.25);
  let bw = 0;
  const widths = lines.map((s) => { const w = ctx.measureText(s || ' ').width; if (w > bw) bw = w; return w; });
  return { lines, widths, bw, lh, bh: lines.length * lh };
}

/** 사진(px) 기하 정보 */
export function makeGeom(pw, ph, crop) {
  const c = crop || [0, 0, 1, 1];
  const Wc = pw / c[2], Hc = ph / c[3];
  return {
    pw, ph, crop: c, Wc, Hc, unit: Math.min(Wc, Hc),
    px: (x, y) => [((x - c[0]) / c[2]) * pw, ((y - c[1]) / c[3]) * ph],
    inv: (px, py) => [c[0] + (px / pw) * c[2], c[1] + (py / ph) * c[3]],
  };
}

/** 레이어 박스 (회전 전 크기, 사진 px) */
export function layerBox(L, g, assets) {
  const [cx, cy] = g.px(L.x, L.y);
  let w = 0, h = 0;
  if (L.t === 'text') {
    const fs = Math.max(4, L.size * g.unit);
    const lay = layoutText(measureCtx(), L, fs);
    const pad = L.box && L.box.on ? (L.box.pad == null ? 0.4 : L.box.pad) * fs : 0;
    w = lay.bw + pad * 2; h = lay.bh + pad * 2;
  } else if (L.t === 'emoji') {
    w = h = L.size * g.unit * 1.2;
  } else if (L.t === 'shape') {
    w = L.w * g.unit; h = (L.h == null ? L.w : L.h) * g.unit;
    if (L.kind === 'line') h = Math.max(h, (L.sw || 0.01) * g.unit * 2 + 8);
  } else if (L.t === 'image') {
    const a = assets && assets.get(L.asset);
    w = L.w * g.unit; h = (a ? (a.height / a.width) * w : (L.h || L.w) * g.unit);
  }
  return { cx, cy, w: Math.max(w, 8), h: Math.max(h, 8), rot: L.rot || 0 };
}

export function hitLayer(L, g, assets, px, py) {
  if (L.hidden || L.lock) return false;
  if (L.t === 'draw') return false;
  const b = layerBox(L, g, assets);
  const a = (-b.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = px - b.cx, dy = py - b.cy;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  const pad = 14;
  return Math.abs(lx) <= b.w / 2 + pad && Math.abs(ly) <= b.h / 2 + pad;
}

function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function setCommon(ctx, L, g) {
  const [cx, cy] = g.px(L.x, L.y);
  ctx.translate(cx, cy);
  if (L.rot) ctx.rotate((L.rot * Math.PI) / 180);
  ctx.globalAlpha = L.opacity == null ? 1 : L.opacity;
  ctx.globalCompositeOperation = L.blend && L.blend !== 'normal' ? L.blend : 'source-over';
}

function applyShadow(ctx, sh, unit) {
  if (sh && sh.on) {
    ctx.shadowColor = sh.color || 'rgba(0,0,0,.5)';
    ctx.shadowBlur = (sh.blur == null ? 0.04 : sh.blur) * unit;
    ctx.shadowOffsetX = (sh.dx || 0) * unit; ctx.shadowOffsetY = (sh.dy == null ? 0.015 : sh.dy) * unit;
  }
}
function clearShadow(ctx) { ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; }

const textCache = new Map();
function renderTextBitmap(L, fs, unit) {
  const key = JSON.stringify([L.text, L.font, L.bold, L.italic, L.underline, L.strike, L.align, L.color, L.grad, L.spacing, L.lineH, L.stroke, L.shadow, L.box, Math.round(fs * 10), Math.round(unit)]);
  const hit = textCache.get(key);
  if (hit) { textCache.delete(key); textCache.set(key, hit); return hit; }
  const mc = measureCtx();
  const lay = layoutText(mc, L, fs);
  const { bw, bh, lh } = lay;
  const box = L.box && L.box.on ? L.box : null;
  const pad = box ? (box.pad == null ? 0.4 : box.pad) * fs : 0;
  const st = L.stroke && L.stroke.w > 0 ? L.stroke : null;
  const sh = L.shadow && L.shadow.on ? L.shadow : null;
  const margin = Math.ceil(fs * 0.3 + (st ? st.w * fs : 0) + (sh ? ((sh.blur == null ? 0.04 : sh.blur) + Math.abs(sh.dx || 0) + Math.abs(sh.dy == null ? 0.015 : sh.dy)) * unit : 0));
  const W = Math.min(8192, Math.ceil(bw + pad * 2 + margin * 2)), H = Math.min(8192, Math.ceil(bh + pad * 2 + margin * 2));
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, W); cv.height = Math.max(2, H);
  const o = cv.getContext('2d');
  o.translate(cv.width / 2, cv.height / 2);
  if (box) {
    o.fillStyle = box.color || '#000000';
    rrect(o, -bw / 2 - pad, -bh / 2 - pad, bw + pad * 2, bh + pad * 2, (box.radius == null ? 0.3 : box.radius) * fs);
    o.fill();
  }
  layoutText(o, L, fs);
  o.textBaseline = 'middle'; o.textAlign = 'left'; o.lineJoin = 'round'; o.miterLimit = 2;
  let fill = L.color || '#ffffff';
  if (L.grad && L.grad.on) {
    const a = ((L.grad.angle == null ? 90 : L.grad.angle) * Math.PI) / 180;
    const gr = o.createLinearGradient(-Math.cos(a) * bw / 2, -Math.sin(a) * bh / 2, Math.cos(a) * bw / 2, Math.sin(a) * bh / 2);
    gr.addColorStop(0, L.color || '#ffffff'); gr.addColorStop(1, L.grad.color2 || '#ff3b5c');
    fill = gr;
  }
  const lineX = (i) => (L.align === 'left' ? -bw / 2 : L.align === 'right' ? bw / 2 - lay.widths[i] : -lay.widths[i] / 2);
  const lineY = (i) => -bh / 2 + lh * (i + 0.5);
  if (sh) { // 그림자 전용 패스 (가장 바깥 형태)
    o.save(); applyShadow(o, sh, unit);
    for (let i = 0; i < lay.lines.length; i++) {
      if (st) { o.lineWidth = st.w * fs; o.strokeStyle = st.color || '#000'; o.strokeText(lay.lines[i], lineX(i), lineY(i)); }
      else { o.fillStyle = fill; o.fillText(lay.lines[i], lineX(i), lineY(i)); }
    }
    o.restore();
  }
  for (let i = 0; i < lay.lines.length; i++) {
    if (st) { o.lineWidth = st.w * fs; o.strokeStyle = st.color || '#000000'; o.strokeText(lay.lines[i], lineX(i), lineY(i)); }
    o.fillStyle = fill; o.fillText(lay.lines[i], lineX(i), lineY(i));
    if (L.underline || L.strike) {
      o.fillStyle = typeof fill === 'string' ? fill : (L.color || '#fff');
      const th = Math.max(1, fs * 0.06);
      if (L.underline) o.fillRect(lineX(i), lineY(i) + fs * 0.42, lay.widths[i], th);
      if (L.strike) o.fillRect(lineX(i), lineY(i) - th / 2, lay.widths[i], th);
    }
  }
  const res = { cv };
  textCache.set(key, res);
  if (textCache.size > 24) textCache.delete(textCache.keys().next().value);
  return res;
}

function drawText(ctx, L, g) {
  const fs = Math.max(4, L.size * g.unit);
  const bm = renderTextBitmap(L, fs, g.unit);
  ctx.save();
  setCommon(ctx, L, g);
  ctx.drawImage(bm.cv, -bm.cv.width / 2, -bm.cv.height / 2);
  ctx.restore();
}

function drawEmoji(ctx, L, g) {
  ctx.save();
  setCommon(ctx, L, g);
  const fs = L.size * g.unit;
  if (L.flip) ctx.scale(-1, 1);
  ctx.font = `${fs}px ${EMOJI_STACK}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  applyShadow(ctx, L.shadow, g.unit);
  ctx.fillText(L.ch || '🙂', 0, fs * 0.06);
  ctx.restore();
}

function drawShape(ctx, L, g) {
  const w = L.w * g.unit, hh = (L.h == null ? L.w : L.h) * g.unit;
  ctx.save();
  setCommon(ctx, L, g);
  if (L.flip) ctx.scale(-1, 1);
  const path = shapePath(L.kind);
  const sp = new Path2D();
  sp.addPath(path, new DOMMatrix([w, 0, 0, hh, 0, 0]));
  applyShadow(ctx, L.shadow, g.unit);
  const open = OPEN_SHAPES.has(L.kind);
  const fillRule = L.kind === 'ring' ? 'evenodd' : 'nonzero';
  if (!open && L.fill) { ctx.fillStyle = L.fill; ctx.fill(sp, fillRule); clearShadow(ctx); }
  if (L.stroke || open) {
    ctx.lineWidth = Math.max(1, (L.sw == null ? 0.012 : L.sw) * g.unit);
    ctx.strokeStyle = L.stroke || L.fill || '#ffffff';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke(sp);
  }
  ctx.restore();
}

function drawImageLayer(ctx, L, g, assets) {
  const a = assets && assets.get(L.asset);
  if (!a) return;
  const w = L.w * g.unit, hh = (a.height / a.width) * w;
  ctx.save();
  setCommon(ctx, L, g);
  if (L.flip) ctx.scale(-1, 1);
  applyShadow(ctx, L.shadow, g.unit);
  if (L.radius) { rrect(ctx, -w / 2, -hh / 2, w, hh, L.radius * Math.min(w, hh)); ctx.save(); ctx.clip(); ctx.drawImage(a.src || a, -w / 2, -hh / 2, w, hh); ctx.restore(); }
  else ctx.drawImage(a.src || a, -w / 2, -hh / 2, w, hh);
  if (L.border && L.border.w > 0) {
    clearShadow(ctx);
    ctx.lineWidth = L.border.w * g.unit; ctx.strokeStyle = L.border.color || '#fff';
    if (L.radius) rrect(ctx, -w / 2, -hh / 2, w, hh, L.radius * Math.min(w, hh)); else { ctx.beginPath(); ctx.rect(-w / 2, -hh / 2, w, hh); }
    ctx.stroke();
  }
  ctx.restore();
}

// ------------------------------------------------------------ 그리기 레이어
export const BRUSHES = [
  ['pen', '펜', 'Pen'], ['marker', '마커', 'Marker'], ['highlighter', '형광펜', 'Highlighter'], ['neon', '네온', 'Neon'],
  ['spray', '스프레이', 'Spray'], ['dotted', '점선', 'Dotted'], ['eraser', '지우개', 'Eraser'],
];

function strokePath(ctx, pts, g) {
  ctx.beginPath();
  const P = [];
  for (let i = 0; i < pts.length; i += 2) P.push(g.px(pts[i], pts[i + 1]));
  if (!P.length) return P;
  ctx.moveTo(P[0][0], P[0][1]);
  if (P.length === 1) { ctx.lineTo(P[0][0] + 0.01, P[0][1]); return P; }
  for (let i = 1; i < P.length - 1; i++) {
    const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
    ctx.quadraticCurveTo(P[i][0], P[i][1], mx, my);
  }
  const l = P[P.length - 1];
  ctx.lineTo(l[0], l[1]);
  return P;
}

function drawStroke(ctx, s, g) {
  const size = Math.max(1, s.size * g.unit);
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = size;
  const op = s.opacity == null ? 1 : s.opacity;
  const col = s.color || '#ffffff';
  switch (s.brush) {
    case 'eraser':
      ctx.globalCompositeOperation = 'destination-out'; ctx.strokeStyle = '#000'; ctx.globalAlpha = 1; strokePath(ctx, s.pts, g); ctx.stroke(); break;
    case 'highlighter':
      ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = Math.min(op, 0.55) ; ctx.strokeStyle = col; ctx.lineCap = 'square'; ctx.lineWidth = size * 1.6; strokePath(ctx, s.pts, g); ctx.stroke(); break;
    case 'marker':
      ctx.globalAlpha = op * 0.85; ctx.strokeStyle = col; ctx.lineWidth = size * 1.3; strokePath(ctx, s.pts, g); ctx.stroke(); break;
    case 'neon': {
      ctx.globalAlpha = op; ctx.strokeStyle = col; ctx.shadowColor = col; ctx.shadowBlur = size * 2.2;
      ctx.lineWidth = size * 1.1; strokePath(ctx, s.pts, g); ctx.stroke(); ctx.stroke();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = size * 0.4; ctx.globalAlpha = Math.min(1, op + 0.1); strokePath(ctx, s.pts, g); ctx.stroke(); break;
    }
    case 'dotted':
      ctx.globalAlpha = op; ctx.strokeStyle = col; ctx.setLineDash([0, size * 1.9]); strokePath(ctx, s.pts, g); ctx.stroke(); break;
    case 'spray': {
      ctx.globalAlpha = op; ctx.fillStyle = col;
      const rnd = mulberry32((s.seed || 1) * 9301);
      const R = size * 1.6, step = Math.max(1, R * 0.35);
      for (let i = 0; i + 1 < s.pts.length; i += 2) {
        const [x, y] = g.px(s.pts[i], s.pts[i + 1]);
        let nx = x, ny = y;
        if (i + 3 < s.pts.length) { [nx, ny] = g.px(s.pts[i + 2], s.pts[i + 3]); }
        const len = Math.hypot(nx - x, ny - y), n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k < n; k++) {
          const px = x + ((nx - x) * k) / n, py = y + ((ny - y) * k) / n;
          for (let d = 0; d < 14; d++) {
            const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * R;
            ctx.fillRect(px + Math.cos(a) * r, py + Math.sin(a) * r, Math.max(1, size * 0.08), Math.max(1, size * 0.08));
          }
        }
      }
      break;
    }
    default:
      ctx.globalAlpha = op; ctx.strokeStyle = col; strokePath(ctx, s.pts, g); ctx.stroke();
  }
  ctx.restore();
}

const drawCache = new WeakMap();
function drawDrawLayer(ctx, L, g) {
  // 지우개는 해당 레이어 안에서만 작동하도록 오프스크린에 그린 뒤 합성 (레이어 객체 단위 캐시)
  const key = g.pw + 'x' + g.ph + '|' + g.crop.join(',');
  let hit = drawCache.get(L);
  if (!hit || hit.key !== key) {
    const off = document.createElement('canvas');
    off.width = g.pw; off.height = g.ph;
    const o = off.getContext('2d');
    for (const s of L.strokes || []) drawStroke(o, s, g);
    hit = { key, off };
    drawCache.set(L, hit);
  }
  ctx.save();
  ctx.globalAlpha = L.opacity == null ? 1 : L.opacity;
  ctx.globalCompositeOperation = L.blend && L.blend !== 'normal' ? L.blend : 'source-over';
  ctx.drawImage(hit.off, 0, 0);
  ctx.restore();
}

export { drawStroke };

export function drawLayers(ctx, layers, g, assets, opts = {}) {
  for (const L of layers || []) {
    if (!L || L.hidden || (opts.skip && opts.skip.has(L.id))) continue;
    switch (L.t) {
      case 'text': drawText(ctx, L, g); break;
      case 'emoji': drawEmoji(ctx, L, g); break;
      case 'shape': drawShape(ctx, L, g); break;
      case 'image': drawImageLayer(ctx, L, g, assets); break;
      case 'draw': drawDrawLayer(ctx, L, g); break;
      default: break;
    }
  }
}

// ------------------------------------------------------------ 배경 (투명 영역 채우기)
export function drawBackground(ctx, bg, w, h, assets) {
  if (!bg || bg.type === 'none') return false;
  if (bg.type === 'color') { ctx.fillStyle = bg.color || '#ffffff'; ctx.fillRect(0, 0, w, h); return true; }
  if (bg.type === 'gradient') {
    const a = ((bg.angle == null ? 135 : bg.angle) * Math.PI) / 180, r = Math.hypot(w, h) / 2;
    const gr = ctx.createLinearGradient(w / 2 - Math.cos(a) * r, h / 2 - Math.sin(a) * r, w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r);
    gr.addColorStop(0, bg.color || '#ff9a9e'); gr.addColorStop(1, bg.color2 || '#fad0c4');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h); return true;
  }
  if (bg.type === 'image') {
    const a = assets && assets.get(bg.asset);
    if (a) { const k = Math.max(w / a.width, h / a.height); ctx.drawImage(a.src || a, (w - a.width * k) / 2, (h - a.height * k) / 2, a.width * k, a.height * k); return true; }
  }
  return false;
}

// ------------------------------------------------------------ 프레임
export const FRAME_PRESETS = [
  { id: 'none', ko: '없음', en: 'None', p: null },
  { id: 'white', ko: '화이트', en: 'White', p: { pad: 4, color: '#ffffff', radius: 0, shadow: 0, bg: 'color' } },
  { id: 'black', ko: '블랙', en: 'Black', p: { pad: 4, color: '#0b0b0b', radius: 0, shadow: 0, bg: 'color' } },
  { id: 'polaroid', ko: '폴라로이드', en: 'Polaroid', p: { pad: 5, bottom: 14, color: '#fafafa', radius: 1, shadow: 40, bg: 'color' } },
  { id: 'rounded', ko: '둥근 모서리', en: 'Rounded', p: { pad: 0, color: '#ffffff', radius: 8, shadow: 0, bg: 'color' } },
  { id: 'card', ko: '카드', en: 'Card', p: { pad: 7, color: '#efefef', radius: 5, shadow: 55, bg: 'color' } },
  { id: 'blur11', ko: '블러 1:1', en: 'Blur 1:1', p: { pad: 6, color: '#222222', radius: 4, shadow: 35, bg: 'blur', aspect: '1:1' } },
  { id: 'blur45', ko: '블러 4:5', en: 'Blur 4:5', p: { pad: 6, color: '#222222', radius: 4, shadow: 35, bg: 'blur', aspect: '4:5' } },
  { id: 'blur916', ko: '블러 9:16', en: 'Blur 9:16', p: { pad: 6, color: '#222222', radius: 4, shadow: 35, bg: 'blur', aspect: '9:16' } },
  { id: 'grad', ko: '그라데이션', en: 'Gradient', p: { pad: 6, color: '#ff9a9e', color2: '#fad0c4', radius: 4, shadow: 30, bg: 'gradient' } },
  { id: 'film', ko: '필름', en: 'Film', p: { pad: 7, color: '#0e0e0e', radius: 0, shadow: 0, bg: 'color', film: true } },
  { id: 'double', ko: '이중선', en: 'Double line', p: { pad: 7, color: '#ffffff', radius: 0, shadow: 0, bg: 'color', line: 1 } },
];

function aspectOf(a) {
  if (!a || a === 'free') return 0;
  const [x, y] = a.split(':').map(Number);
  return x / y;
}

export function frameLayout(pw, ph, f) {
  if (!f) return { W: pw, H: ph, x: 0, y: 0, pad: 0 };
  const mn = Math.min(pw, ph);
  const pad = (f.pad || 0) / 100 * mn;
  const bottom = (f.bottom || 0) / 100 * mn;
  let W = pw + pad * 2, H = ph + pad * 2 + bottom;
  const asp = aspectOf(f.aspect);
  if (asp) { if (W / H > asp) H = W / asp; else W = H * asp; }
  const x = (W - pw) / 2;
  const y = (H - bottom - ph) / 2;
  return { W: Math.round(W), H: Math.round(H), x, y, pad, bottom };
}

/** photo(canvas) → 프레임이 적용된 새 캔버스 */
export function applyFrame(photo, f, assets) {
  const lay = frameLayout(photo.width, photo.height, f);
  const out = document.createElement('canvas');
  out.width = lay.W; out.height = lay.H;
  const c = out.getContext('2d');
  // 배경
  if (f.bg === 'blur') {
    const k = Math.max(lay.W / photo.width, lay.H / photo.height) * 1.15;
    c.save();
    c.filter = `blur(${Math.max(4, Math.min(lay.W, lay.H) * 0.035)}px) brightness(.82) saturate(1.15)`;
    c.drawImage(photo, (lay.W - photo.width * k) / 2, (lay.H - photo.height * k) / 2, photo.width * k, photo.height * k);
    c.restore();
  } else if (f.bg === 'gradient') drawBackground(c, { type: 'gradient', color: f.color, color2: f.color2, angle: 135 }, lay.W, lay.H);
  else { c.fillStyle = f.color || '#ffffff'; c.fillRect(0, 0, lay.W, lay.H); }
  const mn = Math.min(photo.width, photo.height);
  const r = (f.radius || 0) / 100 * mn;
  // 그림자 + 사진
  c.save();
  if (f.shadow) { c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = (f.shadow / 100) * mn * 0.06; c.shadowOffsetY = (f.shadow / 100) * mn * 0.015; }
  if (r > 0) { rrect(c, lay.x, lay.y, photo.width, photo.height, r); c.fillStyle = '#000'; c.fill(); }
  else if (f.shadow) { c.fillStyle = '#000'; c.fillRect(lay.x, lay.y, photo.width, photo.height); }
  c.restore();
  c.save();
  if (r > 0) { rrect(c, lay.x, lay.y, photo.width, photo.height, r); c.clip(); }
  c.drawImage(photo, lay.x, lay.y);
  c.restore();
  if (f.line) {
    c.strokeStyle = 'rgba(0,0,0,.7)'; c.lineWidth = Math.max(1, mn * 0.004);
    const m = lay.pad * 0.45;
    c.strokeRect(m, m, lay.W - m * 2, lay.H - m * 2);
    c.strokeRect(m + lay.pad * 0.2, m + lay.pad * 0.2, lay.W - (m + lay.pad * 0.2) * 2, lay.H - (m + lay.pad * 0.2) * 2);
  }
  if (f.film) {
    c.fillStyle = '#f2f2f2';
    const hole = lay.pad * 0.42, gap = hole * 1.7;
    for (let x = gap * 0.5; x < lay.W; x += gap) {
      rrect(c, x, lay.pad * 0.28, hole * 0.8, hole, hole * 0.2); c.fill();
      rrect(c, x, lay.H - lay.pad * 0.28 - hole, hole * 0.8, hole, hole * 0.2); c.fill();
    }
  }
  void assets;
  return out;
}

/** 전체 합성: base(canvas/bitmap) + doc → 새 캔버스(프레임 포함) */
export function composeDoc(base, doc, assets, opts = {}) {
  const pw = base.width, ph = base.height;
  const photo = document.createElement('canvas');
  photo.width = pw; photo.height = ph;
  const ctx = photo.getContext('2d');
  if (!opts.noBg && drawBackground(ctx, doc.bg, pw, ph, assets)) { /* 배경 먼저 */ }
  ctx.drawImage(base, 0, 0);
  if (!opts.noLayers && doc.layers && doc.layers.length) {
    const g = makeGeom(pw, ph, opts.crop || doc.geo.crop);
    drawLayers(ctx, doc.layers, g, assets, opts);
  }
  if (!opts.noFrame && doc.frame && (doc.frame.pad || doc.frame.bottom || doc.frame.aspect || doc.frame.radius)) return applyFrame(photo, doc.frame, assets);
  return photo;
}
