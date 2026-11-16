// 인물 경계 자동 맞춤 단위 테스트. 실행: node web/tests/autoselect.unit.mjs
import { refineMask, signedDistance } from '../src/ai/autoselect.js';

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
console.log(`\n${fail ? '✗' : '✅'} ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
