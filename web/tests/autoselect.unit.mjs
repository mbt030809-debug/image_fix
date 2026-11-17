// 인물 경계 자동 맞춤 단위 테스트. 실행: node web/tests/autoselect.unit.mjs
import { refineMask, signedDistance, maskFromSaliency, components } from '../src/ai/autoselect.js';
import { preprocess, postprocess } from '../src/ai/person.js';
import { canny, guidedFilter, refineFromProb, refineFromLasso, resizeF, fillHoles } from '../src/ai/edgesnap.js';

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n, e); } };
const W = 240, H = 320;
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** 합성 장면: 파란 그라데이션 배경 + 입자감, 몸통(둥근 사각) + 머리(원) 인물(주황 계열 + 입자감) */
function scene() {
  const src = new Uint8ClampedArray(W * H * 4), truth = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const body = Math.abs(x - 120) < 46 - Math.max(0, (y - 280)) * 0.6 && y > 90 && y < 300;
    const head = Math.hypot(x - 120, y - 62) < 30;
    const inside = body || head;
    const n = (rnd() - 0.5) * 14;
    const c = inside ? [210 + n, 120 + (y % 30) + n, 70 + n] : [60 + y * 0.12 + n, 110 + x * 0.1 + n, 190 - y * 0.1 + n];
    src[i * 4] = c[0]; src[i * 4 + 1] = c[1]; src[i * 4 + 2] = c[2]; src[i * 4 + 3] = 255;
    truth[i] = inside ? 255 : 0;
  }
  return { src, truth };
}
const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < a.length; k++) { const p = a[k] >= 128, q = b[k] >= 128; if (p && q) i++; if (p || q) u++; } return u ? i / u : 1; };
/** 정답을 r 만큼 부풀리거나(+)/깎은(−) "대충 그린 올가미" */
function loose(truth, r, dx = 0, dy = 0) {
  const d = signedDistance(truth, W, H, 40), out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(W - 1, Math.max(0, x - dx)), sy = Math.min(H - 1, Math.max(0, y - dy));
    out[y * W + x] = d[sy * W + sx] > -r ? 255 : 0;
  }
  return out;
}
const { src, truth } = scene();

console.log('▶ 올가미가 경계 밖으로 넉넉할 때(+8px)');
{
  const rough = loose(truth, 8), t0 = Date.now();
  const r = refineMask(src, W, H, rough, { band: 14 });
  const a = iou(rough, truth), b = iou(r.mask, truth);
  ok(r.ok, 'ok');
  ok(b > 0.97, `IoU 0.97 초과 (${a.toFixed(3)} → ${b.toFixed(3)})`);
  ok(b > a, '올가미보다 좋아짐');
  ok(Date.now() - t0 < 4000, `빠름 (${Date.now() - t0}ms)`);
}
console.log('▶ 올가미가 경계 안쪽으로 파고들 때(−8px)');
{
  const rough = loose(truth, -8), r = refineMask(src, W, H, rough, { band: 14 });
  const a = iou(rough, truth), b = iou(r.mask, truth);
  ok(r.ok && b > 0.96 && b > a, `IoU ${a.toFixed(3)} → ${b.toFixed(3)}`);
}
console.log('▶ 올가미가 비뚤게(+6 부풀림, 4px 이동)');
{
  const rough = loose(truth, 6, 4, -3), r = refineMask(src, W, H, rough, { band: 14 });
  const a = iou(rough, truth), b = iou(r.mask, truth);
  ok(r.ok && b > 0.95 && b > a, `IoU ${a.toFixed(3)} → ${b.toFixed(3)}`);
}
console.log('▶ 올가미가 정확하면 거의 그대로');
{
  const r = refineMask(src, W, H, truth, { band: 10 });
  ok(iou(r.mask, truth) > 0.985, `IoU ${iou(r.mask, truth).toFixed(3)}`);
}
console.log('▶ 색 구분이 안 되는 장면은 올가미 그대로(믿지 않음)');
{
  const flat = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const v = 120 + (rnd() - 0.5) * 10; flat[i * 4] = v; flat[i * 4 + 1] = v; flat[i * 4 + 2] = v; flat[i * 4 + 3] = 255; }
  const rough = loose(truth, 4), r = refineMask(flat, W, H, rough, { band: 12 });
  ok(iou(r.mask, rough) > 0.9, `올가미와 비슷 (${iou(r.mask, rough).toFixed(3)})`);
}
console.log('▶ 경계 조건');
{
  ok(refineMask(src, W, H, new Uint8Array(W * H), {}).ok === false, '빈 선택 → ok:false');
  ok(refineMask(src, W, H, new Uint8Array(W * H).fill(255), {}).ok === false, '전체 선택 → ok:false');
  const small = new Uint8Array(W * H); for (let y = 100; y < 104; y++) for (let x = 100; x < 104; x++) small[y * W + x] = 255;
  ok(refineMask(src, W, H, small, { band: 14 }).mask.length === W * H, '아주 작은 선택도 안전');
  const a = refineMask(src, W, H, loose(truth, 8), { band: 14 }), b = refineMask(src, W, H, loose(truth, 8), { band: 14 });
  ok(a.mask.every((v, i) => v === b.mask[i]), '결정적');
  // 배경의 작은 섬(올가미 밖)이 인물로 따라오지 않음
  let stray = 0; const m = a.mask; for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) stray += m[y * W + x] ? 1 : 0;
  ok(stray === 0, '먼 배경은 선택되지 않음');
}
console.log('▶ 인물 분리 모델 결과와 합치기(합성 피사체 맵)');
{
  const SZ = 80, sal = new Uint8Array(SZ * SZ);
  // 모델이 낸 거친 피사체 맵: 정답을 80×80 으로 줄인 것 + 바깥에 다른 물체 하나
  for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) sal[y * SZ + x] = truth[Math.floor((y + 0.5) * H / SZ) * W + Math.floor((x + 0.5) * W / SZ)] ? 255 : 0;
  for (let y = 4; y < 14; y++) for (let x = 4; x < 16; x++) sal[y * SZ + x] = 255; // 구석의 다른 물체
  const r1 = maskFromSaliency(src, W, H, sal, SZ, null);
  ok(r1.ok && iou(r1.mask, truth) > 0.95, `자동 선택: 가장 큰 덩어리만 고름 (IoU ${iou(r1.mask, truth).toFixed(3)})`);
  const r2 = maskFromSaliency(src, W, H, sal, SZ, loose(truth, 10), { range: 14 });
  ok(r2.ok && iou(r2.mask, truth) > 0.95, `올가미 + 모델 (IoU ${iou(r2.mask, truth).toFixed(3)})`);
  const none = maskFromSaliency(src, W, H, new Uint8Array(SZ * SZ), SZ, loose(truth, 10), { range: 14 });
  ok(!none.ok, '모델이 아무것도 못 찾으면 ok:false(색 맞춤으로 넘어감)');
  const far = new Uint8Array(W * H); for (let y = 5; y < 60; y++) for (let x = 190; x < 235; x++) far[y * W + x] = 255; // 올가미가 인물이 없는 곳
  ok(!maskFromSaliency(src, W, H, sal, SZ, far, { range: 8 }).ok, '올가미 안에 인물이 없으면 ok:false');
  const c = components(truth, W, H); ok(c.areas.length === 2 || c.areas.length === 1, '연결 성분');
  const p = preprocess(new Uint8ClampedArray(4 * 4).fill(255), 2, 2); ok(p.length === 12 && Math.abs(p[0] - (1 - 0.485) / 0.229) < 1e-4, '전처리');
  const q = postprocess(new Float32Array([0.2, 0.4, 0.6])); ok(q[0] === 0 && q[2] === 255 && Math.abs(q[1] - 128) <= 1, '후처리(최소/최대 늘이기)');
}
console.log('▶ 경계 정밀화(Canny · 가이디드 필터 · 확률맵 → 마스크)');
{
  const e = canny(src, W, H, {}), dE = signedDistance(Uint8Array.from(e, (v) => (v ? 255 : 0)), W, H, 6), dT = signedDistance(truth, W, H, 6); let bd = 0, hit = 0;
  for (let i = 0; i < W * H; i++) if (Math.abs(dT[i]) < 1.5) { bd++; if (dE[i] > 0 || dE[i] === 0 || Math.abs(dE[i]) <= 3) hit++; } // 실제 경계 근처 픽셀 중 Canny 선이 3px 안에 있는 비율
  let near = 0; for (let i = 0; i < W * H; i++) if (Math.abs(dT[i]) < 1.5 && (e[i] || e[i - 1] || e[i + 1] || e[i - W] || e[i + W] || e[i - 2] || e[i + 2] || e[i - 2 * W] || e[i + 2 * W])) near++;
  ok(near / bd > 0.8, `Canny 가 실제 인물 경계의 대부분을 찾음 (${(near / bd * 100).toFixed(0)}%)`);
  const guide = new Float32Array(W * H), m = new Float32Array(W * H); for (let i = 0; i < W * H; i++) { guide[i] = src[i * 4] / 255; m[i] = truth[i] ? 1 : 0; }
  const q = guidedFilter(guide, m, W, H, 4, 1e-3); let mn = 1, mx = 0; for (const v of q) { if (v < mn) mn = v; if (v > mx) mx = v; }
  ok(mn >= 0 && mx <= 1 && q[120 * W + 120] > 0.9 && q[10 * W + 10] < 0.1, '가이디드 필터: 0..1 알파, 안쪽 1 · 바깥 0');
  // 모델 확률맵을 일부러 거칠게(80×80, 경계 흐림) 만든 뒤 정밀화
  const SZ = 80, p = new Float32Array(SZ * SZ);
  for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) p[y * SZ + x] = truth[Math.floor((y + 0.5) * H / SZ) * W + Math.floor((x + 0.5) * W / SZ)] ? 0.95 : 0.03;
  const coarse = resizeF(p, SZ, SZ, W, H), cb = Uint8Array.from(coarse, (v) => (v >= 0.5 ? 255 : 0));
  const r = refineFromProb(src, W, H, p, SZ, { largest: true });
  ok(iou(r.bin, truth) >= iou(cb, truth) - 0.005 && iou(r.bin, truth) > 0.97, `확률맵 정밀화 IoU ${iou(cb, truth).toFixed(3)} → ${iou(r.bin, truth).toFixed(3)}`);
  const l = refineFromLasso(src, W, H, p, SZ, loose(truth, 24));
  ok(l.ok && iou(l.bin, truth) > 0.95, `넉넉한 올가미(+24px) + 모델 IoU ${iou(l.bin, truth).toFixed(3)} (${l.mode})`);
  const hint = refineFromLasso(src, W, H, new Float32Array(SZ * SZ).fill(0.02), SZ, loose(truth, 6));
  ok(hint.mode === 'hint' && iou(hint.bin, truth) > 0.9, `모델이 못 찾으면 올가미를 힌트로 (IoU ${iou(hint.bin, truth).toFixed(3)})`);
  const holey = Uint8Array.from(truth); for (let y = 100; y < 106; y++) for (let x = 110; x < 116; x++) holey[y * W + x] = 0;
  ok(fillHoles(holey, W, H, 0.03)[103 * W + 112] === 255, '인물 안쪽의 작은 구멍을 메움');
}
console.log(`\n${fail ? '✗' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
