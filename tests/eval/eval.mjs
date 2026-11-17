// 경계 정밀화 평가(개발 전용): node eval.mjs <맵폴더> <출력폴더>
// 기준(GT)은 isnet-general-use 의 1024px 결과(사람이 그린 정답이 아닌 "의사 정답")다.
import fs from 'node:fs';
import { maskFromSaliency, components, signedDistance } from '../../web/src/ai/autoselect.js';
import { refineFromProb, refineFromLasso, resizeF } from '../../web/src/ai/edgesnap.js';
const [dir, outDir] = process.argv.slice(2); fs.mkdirSync(outDir, { recursive: true });
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.rgba')).map((f) => f.slice(0, -5)).sort();
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;
const f32 = (p) => { const b = fs.readFileSync(p); return new Float32Array(b.buffer, b.byteOffset, b.length / 4); };
const rgbaResize = (src, sw, sh, w, h) => { // RGBA 이중선형
  const o = new Uint8ClampedArray(w * h * 4), sx = sw / w, sy = sh / h;
  for (let j = 0; j < h; j++) { const fy = Math.max(0, Math.min(sh - 1, (j + 0.5) * sy - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let i = 0; i < w; i++) { const fx = Math.max(0, Math.min(sw - 1, (i + 0.5) * sx - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 4; c++) o[(j * w + i) * 4 + c] = (src[(y0 * sw + x0) * 4 + c] * (1 - tx) + src[(y0 * sw + x1) * 4 + c] * tx) * (1 - ty) + (src[(y1 * sw + x0) * 4 + c] * (1 - tx) + src[(y1 * sw + x1) * 4 + c] * tx) * ty; } }
  return o;
};
const largest = (bin, w, h) => { const { lab, areas } = components(bin, w, h); if (!areas.length) return bin; let bi = 0; areas.forEach((a, i) => { if (a > areas[bi]) bi = i; }); const o = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) if (lab[i] === bi) o[i] = 255; return o; };
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { const p = a[k] > 0, q = b[k] > 0; if (p && q) i++; if (p || q) u++; } return u ? i / u : 1; };
function edgePx(bin, w, h) { const e = []; for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; if (bin[i] && (!bin[i - 1] || !bin[i + 1] || !bin[i - w] || !bin[i + w])) e.push(i); } return e; }
/** 경계 F-score(허용 tol px) + 평균 경계 거리 오차(px) */
function boundary(pred, gt, w, h, tol) {
  const dG = signedDistance(gt, w, h, 60), dP = signedDistance(pred, w, h, 60);
  const eP = edgePx(pred, w, h), eG = edgePx(gt, w, h);
  if (!eP.length || !eG.length) return { f: 0, err: 99 };
  let pr = 0, rc = 0, sum = 0; for (const i of eP) { const d = Math.abs(dG[i]); if (d <= tol) pr++; sum += Math.min(d, 60); } for (const i of eG) if (Math.abs(dP[i]) <= tol) rc++;
  const P = pr / eP.length, R = rc / eG.length; return { f: P + R ? (2 * P * R) / (P + R) : 0, err: sum / eP.length };
}
const rows = []; const agg = {};
for (const n of names) {
  if (only && !only.includes(n)) continue;
  const [W0, H0] = fs.readFileSync(`${dir}/${n}.size`, 'utf8').split(' ').map(Number);
  const k = Math.min(1, 1024 / Math.max(W0, H0)), w = Math.round(W0 * k), h = Math.round(H0 * k), long = Math.max(w, h);
  const raw = new Uint8ClampedArray(fs.readFileSync(`${dir}/${n}.rgba`)); const rgba = k < 1 ? rgbaResize(raw, W0, H0, w, h) : raw;
  const gtp = resizeF(f32(`${dir}/${n}.gt.f32`), 1024, 1024, w, h), gt = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) gt[i] = gtp[i] >= 0.5 ? 255 : 0;
  const GT = largest(gt, w, h), tol = Math.max(2, Math.round(0.003 * long));
  const fp = f32(`${dir}/${n}.fp32.f32`), q8 = f32(`${dir}/${n}.q8.f32`);
  const V = {};
  // V0: 현재 앱 방식(320 확률맵 → 480px 작업 → 색 맞춤)
  { const k2 = Math.min(1, 480 / long), w2 = Math.round(w * k2), h2 = Math.round(h * k2), r2 = rgbaResize(rgba, w, h, w2, h2); const t = Date.now();
    const sal = Uint8Array.from(fp, (v) => Math.round(v * 255)); const r = maskFromSaliency(r2, w2, h2, sal, 320, null); const ms = Date.now() - t;
    const up = resizeF(Float32Array.from(r.mask, (v) => v / 255), w2, h2, w, h); V.v0 = { bin: Uint8Array.from(up, (v) => (v >= 0.5 ? 255 : 0)), ms }; }
  // V5: 모델만(확률 0.5 를 그대로 키움)
  { const p = resizeF(fp, 320, 320, w, h); V.model = { bin: Uint8Array.from(p, (v) => (v >= 0.5 ? 255 : 0)), ms: 0 }; }
  const run = (key, prob, steps, extra = {}) => { const r = refineFromProb(rgba, w, h, prob, 320, { steps, ...extra }); V[key] = { bin: Uint8Array.from(r.alpha, (v) => (v >= 0.5 ? 255 : 0)), alpha: r.alpha, ms: Object.values(r.ms).reduce((a, b) => a + b, 0), ms_: r.ms }; };
  run('cut', fp, { cut: true, canny: false, matte: false });
  run('cut+canny', fp, { cut: true, canny: true, matte: false });
  run('full', fp, { cut: true, canny: true, matte: true });
  run('full_q8', q8, { cut: true, canny: true, matte: true });
  // 올가미 시나리오: 정답을 3% 부풀리고 약간 비틀어 "대충 그린 올가미"를 흉내 낸다
  { const dG = signedDistance(GT, w, h, 80), lr = Math.round((+process.env.LR || 0.03) * long), lasso = new Uint8Array(w * h), ox = Math.round(0.01 * long), oy = -Math.round(0.008 * long);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(w - 1, Math.max(0, x - ox)), sy = Math.min(h - 1, Math.max(0, y - oy)); lasso[y * w + x] = dG[sy * w + sx] > -lr ? 255 : 0; }
    V.lasso_raw = { bin: lasso, ms: 0 };
    { const k2 = Math.min(1, 480 / long), w2 = Math.round(w * k2), h2 = Math.round(h * k2), r2 = rgbaResize(rgba, w, h, w2, h2), l2 = Uint8Array.from(resizeF(Float32Array.from(lasso, (v) => v / 255), w, h, w2, h2), (v) => Math.round(v * 255)); const t = Date.now();
      const sal = Uint8Array.from(fp, (v) => Math.round(v * 255)); const r = maskFromSaliency(r2, w2, h2, sal, 320, l2, { range: 0.04 * 480 }); const ms = Date.now() - t;
      const up = resizeF(Float32Array.from(r.mask, (v) => v / 255), w2, h2, w, h); V.lasso_v0 = { bin: Uint8Array.from(up, (v) => (v >= 0.5 ? 255 : 0)), ms }; }
    { const r = refineFromLasso(rgba, w, h, fp, 320, lasso, { mode: 'hint' }); V.lasso_hint = { bin: Uint8Array.from(r.alpha, (v) => (v >= 0.5 ? 255 : 0)), ms: 0 }; }
    { const r = refineFromLasso(rgba, w, h, fp, 320, lasso); V.lasso_new = { bin: Uint8Array.from(r.alpha, (v) => (v >= 0.5 ? 255 : 0)), ms: Object.values(r.ms).reduce((a, b) => a + b, 0) }; } }
  for (const [key, v] of Object.entries(V)) {
    const bin = largest(v.bin, w, h), b = boundary(bin, GT, w, h, tol);
    const row = { n, key, iou: iou(bin, GT), f: b.f, err: b.err, ms: v.ms }; rows.push(row); (agg[key] ||= []).push(row);
    fs.writeFileSync(`${outDir}/${n}.${key}.u8`, bin);
  }
  fs.writeFileSync(`${outDir}/${n}.GT.u8`, GT); fs.writeFileSync(`${outDir}/${n}.size`, `${w} ${h}`);
}
const keys = ['model', 'v0', 'cut+canny', 'full', 'lasso_raw', 'lasso_v0', 'lasso_hint', 'lasso_new'];
console.log('사진별 경계 F-score(허용오차 ≈0.3% / 경계거리오차 px) ');
console.log(['사진', ...keys].join('\t'));
for (const n of [...new Set(rows.map((r) => r.n))]) console.log([n, ...keys.map((k) => { const r = rows.find((x) => x.n === n && x.key === k); return r ? `${r.f.toFixed(3)}/${r.err.toFixed(1)}` : '-'; })].join('\t'));
console.log('\n평균: key  IoU  F  거리오차px  시간ms(node)');
for (const k of keys) { const a = agg[k]; if (!a) continue; const m = (f) => a.reduce((s, r) => s + r[f], 0) / a.length; console.log(k.padEnd(10), m('iou').toFixed(3), m('f').toFixed(3), m('err').toFixed(2), Math.round(m('ms'))); }
