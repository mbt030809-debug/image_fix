// 체형 보정 엔진 단위 테스트. 실행: node web/tests/bodywarp.unit.mjs
import { warpSubject, rowCenters, pushPullFill, amountOf } from '../src/ai/bodywarp.js';

let pass = 0, fail = 0;
const ok = (c, n, e = '') => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', n, e); } };
const W = 120, H = 160;

/** 합성 장면: 세로 그라데이션 배경 + 가운데 인물(몸통 사각형 x 40..80, y 30..150; 머리 원 중심 (60,22) r 14) */
function scene() {
  const src = new Uint8ClampedArray(W * H * 4), mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    const bg = [60 + y * 0.5, 120 + x * 0.3, 200 - y * 0.4];
    const body = x >= 40 && x < 80 && y >= 30 && y < 150;
    const head = Math.hypot(x - 60, y - 22) < 14;
    const inside = body || head;
    const col = inside ? [200, 40 + (y % 20) * 3, 60] : bg; // 인물은 붉은 색 + 줄무늬
    src[i * 4] = col[0]; src[i * 4 + 1] = col[1]; src[i * 4 + 2] = col[2]; src[i * 4 + 3] = 255;
    mask[i] = inside ? 255 : 0;
  }
  return { src, mask };
}
const { src, mask } = scene();
const area = (m, y0 = 0, y1 = H) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) s += m[y * W + x] / 255; return s; };
const rowW = (m, y) => { let s = 0; for (let x = 0; x < W; x++) s += m[y * W + x] > 127 ? 1 : 0; return s; };

console.log('▶ 변형 없음');
{
  const r = warpSubject(src, W, H, mask, []);
  let maxd = 0, nonHole = 0;
  for (let i = 0; i < W * H; i++) { if (mask[i] === 255) maxd = Math.max(maxd, Math.abs(r.rgba[i * 4] - src[i * 4]), Math.abs(r.rgba[i * 4 + 1] - src[i * 4 + 1])); if (!r.hole[i]) { nonHole++; if (r.rgba[i * 4 + 3] !== 0) maxd = Math.max(maxd, Math.abs(r.rgba[i * 4] - src[i * 4]), Math.abs(r.rgba[i * 4 + 2] - src[i * 4 + 2])); } }
  ok(maxd <= 1, 'no ops → the subject is reproduced exactly', String(maxd));
  ok(nonHole > W * H * 0.4, 'most of the picture is outside the changed area');
}

console.log('▶ 폭 줄이기: 인물만 바뀌고 배경은 한 픽셀도 안 바뀐다');
{
  const op = { kind: 'width', y0: 70, y1: 110, amt: -0.2 };
  const r = warpSubject(src, W, H, mask, [op]);
  const wBefore = rowW(mask, 90), wAfter = rowW(r.newMask, 90);
  ok(wAfter < wBefore && Math.abs(wAfter - wBefore * 0.8) <= 2.5, 'waist row is ~20% narrower', `${wBefore} → ${wAfter}`);
  ok(rowW(r.newMask, 40) === rowW(mask, 40) && rowW(r.newMask, 140) === rowW(mask, 140), 'rows outside the band are unchanged');
  let leaked = 0;
  for (let i = 0; i < W * H; i++) if (!r.hole[i] && r.rgba[i * 4 + 3] !== 0 && (Math.abs(r.rgba[i * 4] - src[i * 4]) > 1 || Math.abs(r.rgba[i * 4 + 1] - src[i * 4 + 1]) > 1 || Math.abs(r.rgba[i * 4 + 2] - src[i * 4 + 2]) > 1)) leaked++;
  ok(leaked === 0, 'outside the changed area the patch equals the original (background untouched)');
  // 구멍 밖(배경)은 레이어가 투명 → 원본 그대로. 변경 영역이 인물 가장자리 근처로 한정되는지(배경 먼 곳은 구멍 아님)
  ok(r.hole[10 * W + 5] === 0 && r.hole[90 * W + 5] === 0 && r.hole[90 * W + 115] === 0, 'far background is not part of the changed area');
  // 드러난 배경은 그 높이의 배경 그라데이션과 비슷한 색으로 채워진다
  const y = 90, x = 42; // 예전 몸통 왼쪽 가장자리(이제 배경이 드러난 곳)
  const i = y * W + x, exp = [60 + y * 0.5, 120 + x * 0.3, 200 - y * 0.4];
  ok(r.rgba[i * 4 + 3] > 200 && Math.abs(r.rgba[i * 4] - exp[0]) < 28 && Math.abs(r.rgba[i * 4 + 2] - exp[2]) < 28, 'the uncovered strip is filled with background-like color', `${r.rgba[i * 4]},${r.rgba[i * 4 + 1]},${r.rgba[i * 4 + 2]} vs ${exp.map((v) => v | 0)}`);
  ok(r.rgba[(90 * W + 60) * 4] > 150 && r.rgba[(90 * W + 60) * 4 + 1] < 130, 'the subject interior keeps its color');
}

console.log('▶ 폭 늘리기');
{
  const r = warpSubject(src, W, H, mask, [{ kind: 'width', y0: 70, y1: 110, amt: 0.2 }]);
  ok(rowW(r.newMask, 90) > rowW(mask, 90) + 5, 'waist row is wider', `${rowW(mask, 90)} → ${rowW(r.newMask, 90)}`);
  let leaked = 0;
  for (let i = 0; i < W * H; i++) if (!r.hole[i] && r.rgba[i * 4 + 3] !== 0 && Math.abs(r.rgba[i * 4] - src[i * 4]) > 1) leaked++;
  ok(leaked === 0, 'still equal to the original outside the changed area');
}

console.log('▶ 길이 늘리기/줄이기');
{
  const k = 0.15, op = { kind: 'height', y0: 80, y1: 120, amt: k };
  const r = warpSubject(src, W, H, mask, [op]);
  const shift = 40 * k; // 밴드 아래 내용이 내려가는 양
  // 몸통 아래 끝(150)이 shift 만큼 내려가면 화면 안(≤159)이라 행 폭이 유지된다
  ok(rowW(r.newMask, 150 + 4) > 30 && rowW(mask, 150 + 4) === 0, 'the bottom of the body moved down by the stretch', String(shift));
  ok(rowW(r.newMask, 60) === rowW(mask, 60), 'rows above the band do not move');
  const s = warpSubject(src, W, H, mask, [{ kind: 'height', y0: 80, y1: 120, amt: -0.15 }]);
  ok(rowW(s.newMask, 148) < 5 && rowW(mask, 148) > 30, 'shortening pulls the bottom up');
}

console.log('▶ 확대/축소 (눈·턱 같은 작은 부분)');
{
  const dot = new Uint8Array(mask), s2 = new Uint8ClampedArray(src);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x - 60, y - 22) < 3) { s2[(y * W + x) * 4] = 255; s2[(y * W + x) * 4 + 1] = 255; s2[(y * W + x) * 4 + 2] = 255; }
  const count = (rgba) => { let n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] > 0 && rgba[(y * W + x) * 4] > 230 && rgba[(y * W + x) * 4 + 1] > 230 && rgba[(y * W + x) * 4 + 2] > 230) n++; return n; };
  const big = warpSubject(s2, W, H, dot, [{ kind: 'bulge', cx: 60, cy: 22, r: 12, amt: 0.4 }]);
  const small = warpSubject(s2, W, H, dot, [{ kind: 'bulge', cx: 60, cy: 22, r: 12, amt: -0.4 }]);
  const none = warpSubject(s2, W, H, dot, []);
  ok(count(big.rgba) > count(none.rgba) * 1.4 && count(small.rgba) < count(none.rgba) * 0.8, 'enlarge grows the dot, shrink makes it smaller', `${count(small.rgba)} < ${count(none.rgba)} < ${count(big.rgba)}`);
}

console.log('▶ 대칭 · 안정성');
{
  const r = warpSubject(src, W, H, mask, [{ kind: 'width', y0: 60, y1: 120, amt: -0.25 }]);
  let asym = 0; for (let x = 0; x < W / 2; x++) asym = Math.max(asym, Math.abs(r.newMask[100 * W + 60 - 1 - x] - r.newMask[100 * W + 60 + x]));
  ok(asym <= 3, 'a symmetric subject stays symmetric', String(asym));
  let bad = 0; for (let i = 0; i < r.rgba.length; i++) if (!Number.isFinite(r.rgba[i])) bad++;
  ok(bad === 0 && r.rgba.length === W * H * 4 && r.newMask.length === W * H, 'finite values, right sizes');
  const r2 = warpSubject(src, W, H, mask, [{ kind: 'width', y0: 60, y1: 120, amt: -0.25 }]);
  ok(Buffer.compare(Buffer.from(r.rgba), Buffer.from(r2.rgba)) === 0, 'deterministic (same input → same pixels)');
  const none = warpSubject(src, W, H, new Uint8Array(W * H), [{ kind: 'width', y0: 10, y1: 100, amt: -0.2 }]);
  ok(none.changed === 0, 'an empty mask changes nothing');
  const all = warpSubject(src, W, H, new Uint8Array(W * H).fill(255), [{ kind: 'width', y0: 10, y1: 100, amt: -0.2 }]);
  ok(all.rgba.length === W * H * 4, 'a full-frame mask does not crash (no known background)');
}

console.log('▶ 도우미');
{
  const c = rowCenters(mask, W, H);
  ok(Math.abs(c[100] - 59.5) < 1 && Math.abs(c[5] - 59.5) < 5 && c.every(Number.isFinite), 'row centers sit on the body axis, also for empty rows');
  const known = new Uint8Array(W * H).fill(1), rgba = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) { rgba[i * 4] = 100; rgba[i * 4 + 1] = 150; rgba[i * 4 + 2] = 200; rgba[i * 4 + 3] = 255; }
  for (let y = 50; y < 90; y++) for (let x = 40; x < 80; x++) known[y * W + x] = 0;
  const f = pushPullFill(rgba, known, W, H);
  ok(Math.abs(f[(70 * W + 60) * 3] - 100) < 2 && Math.abs(f[(70 * W + 60) * 3 + 2] - 200) < 2, 'push-pull fills a hole with the surrounding flat color');
  ok(amountOf('width', 100) === 0.15 && amountOf('bulge', -50) === -0.2 && amountOf('height', 0) === 0, 'amount scale');
}

console.log(`\nBody warp tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
