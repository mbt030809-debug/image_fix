// 인물 경계 자동 맞춤: 올가미(대충 둘러싼 선)를 "힌트"로 쓰고 실제 경계는 이미지(색 + 가장자리)로 정한다.
//  - 올가미 안쪽 깊은 곳 = 확실한 인물, 바깥 깊은 곳 = 확실한 배경, 선 주변 띠 = 미확정
//  - 확실한 두 영역의 색 분포(히스토그램)로 띠의 픽셀을 인물/배경으로 점수 매기고,
//    이웃 픽셀 색이 크게 다른 곳(가장자리)에서 자르기 쉽게 그래프 컷(최대 흐름)으로 한 번에 푼다.
//  - 올가미와의 거리 사전 확률로 올가미에서 너무 멀리 벗어나지 않게 한다.
// 순수 함수(DOM 없음) — Node 에서 테스트한다.

/** 이진(0/255) 마스크의 부호 있는 거리(안쪽 +, 바깥 −). 체임퍼 3-4 근사, 단위: 픽셀. */
export function signedDistance(bin, w, h, cap) {
  const INF = 1e9, A = 1, B = 1.41421356;
  const dIn = new Float32Array(w * h), dOut = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) { dIn[i] = bin[i] ? INF : 0; dOut[i] = bin[i] ? 0 : INF; }
  const pass = (d) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + A);
      if (y > 0) { v = Math.min(v, d[i - w] + A); if (x > 0) v = Math.min(v, d[i - w - 1] + B); if (x < w - 1) v = Math.min(v, d[i - w + 1] + B); }
      d[i] = v;
    }
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x; let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + A);
      if (y < h - 1) { v = Math.min(v, d[i + w] + A); if (x < w - 1) v = Math.min(v, d[i + w + 1] + B); if (x > 0) v = Math.min(v, d[i + w - 1] + B); }
      d[i] = v;
    }
  };
  pass(dIn); pass(dOut);
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = bin[i] ? Math.min(cap, dIn[i]) : -Math.min(cap, dOut[i]);
  return out;
}

/** 두 가지 양자화(4비트·3비트)를 평균한 색 히스토그램 확률 */
function histModel(rgba, idxs, n) {
  const h4 = new Float32Array(4096), h3 = new Float32Array(512);
  for (let k = 0; k < n; k++) {
    const p = idxs[k] * 4, r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
    h4[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
    h3[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)]++;
  }
  const t4 = n + 4096 * 0.05, t3 = n + 512 * 0.05;
  return (r, g, b) => 0.5 * (h4[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)] + 0.05) / t4 * 1 + 0.5 * (h3[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)] + 0.05) / t3 * (512 / 4096);
}

/** 최대 흐름(Dinic). 노드 0=source, 1=sink. 간선은 정방향/역방향 쌍. */
function makeGraph(nNodes, maxEdges) {
  const head = new Int32Array(nNodes).fill(-1), next = new Int32Array(maxEdges * 2), to = new Int32Array(maxEdges * 2), cap = new Float32Array(maxEdges * 2);
  let ne = 0;
  const add = (u, v, c, rc) => { to[ne] = v; cap[ne] = c; next[ne] = head[u]; head[u] = ne++; to[ne] = u; cap[ne] = rc; next[ne] = head[v]; head[v] = ne++; };
  return { head, next, to, cap, add, n: nNodes };
}
function maxflow(g, s, t) {
  const { head, next, to, cap, n } = g;
  const level = new Int32Array(n), it = new Int32Array(n), q = new Int32Array(n), stackE = new Int32Array(n + 1), stackV = new Int32Array(n + 1);
  const EPS = 1e-6;
  let flow = 0;
  const bfs = () => {
    level.fill(-1); level[s] = 0; let qh = 0, qt = 0; q[qt++] = s;
    while (qh < qt) { const u = q[qh++]; for (let e = head[u]; e !== -1; e = next[e]) { const v = to[e]; if (level[v] < 0 && cap[e] > EPS) { level[v] = level[u] + 1; q[qt++] = v; } } }
    return level[t] >= 0;
  };
  while (bfs()) {
    for (let i = 0; i < n; i++) it[i] = head[i];
    // 반복형 DFS: 막다른 길이면 되돌아가며 level 을 무효화
    let sp = 0; stackV[0] = s;
    while (true) {
      const u = stackV[sp];
      if (u === t) {
        let f = Infinity; for (let i = 0; i < sp; i++) f = Math.min(f, cap[stackE[i]]);
        for (let i = 0; i < sp; i++) { cap[stackE[i]] -= f; cap[stackE[i] ^ 1] += f; }
        flow += f;
        // 포화된 첫 간선까지 되감기
        let k = 0; while (k < sp && cap[stackE[k]] > EPS) k++;
        sp = k; continue;
      }
      let advanced = false;
      for (; it[u] !== -1; it[u] = next[it[u]]) {
        const e = it[u], v = to[e];
        if (cap[e] > EPS && level[v] === level[u] + 1) { stackE[sp] = e; stackV[++sp] = v; advanced = true; break; }
      }
      if (advanced) continue;
      if (sp === 0) break;
      level[u] = -1; sp--; it[stackV[sp]] = next[it[stackV[sp]]];
    }
  }
  return flow;
}

/** 4-이웃 연결 성분 라벨링 후 작은 섬/구멍 정리. out: 0/255 */
function tidy(out, w, h, frac) {
  const n = w * h, lab = new Int32Array(n).fill(-1);
  const comps = []; const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (lab[s] >= 0) continue;
    const v = out[s] ? 1 : 0, id = comps.length; let sp = 0, cnt = 0, touch = false; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp]; cnt++; const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touch = true;
      if (x > 0 && lab[p - 1] < 0 && (out[p - 1] ? 1 : 0) === v) { lab[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && lab[p + 1] < 0 && (out[p + 1] ? 1 : 0) === v) { lab[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && lab[p - w] < 0 && (out[p - w] ? 1 : 0) === v) { lab[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && lab[p + w] < 0 && (out[p + w] ? 1 : 0) === v) { lab[p + w] = id; stack[sp++] = p + w; }
    }
    comps.push({ v, cnt, touch });
  }
  let fgMax = 0; for (const c of comps) if (c.v) fgMax = Math.max(fgMax, c.cnt);
  const lim = Math.max(4, fgMax * frac), flip = new Uint8Array(comps.length);
  comps.forEach((c, i) => { if (c.v ? c.cnt < lim : (!c.touch && c.cnt < lim)) flip[i] = 1; });
  for (let i = 0; i < n; i++) if (flip[lab[i]]) out[i] = out[i] ? 0 : 255;
}

/**
 * rough(0..255, w×h)를 이미지 경계에 맞춰 다듬는다.
 * opts: band(띠 반경 px, 기본 긴 변의 3%), prior(올가미 사전 세기), smooth(가장자리 매끄러움)
 * 반환: { mask(0/255), ok, changed }  — 못 믿을 결과면 ok:false 와 함께 rough 이진화본을 돌려준다.
 */
export function refineMask(rgba, w, h, rough, opts = {}) {
  const n = w * h, bin = new Uint8Array(n);
  let fgN = 0; for (let i = 0; i < n; i++) { if (rough[i] >= 128) { bin[i] = 255; fgN++; } }
  const fallback = (why) => ({ mask: bin, ok: false, changed: 0, why });
  if (!fgN || fgN === n) return fallback('empty');
  const band = Math.max(2, opts.band != null ? opts.band : 0.03 * Math.max(w, h));
  const prior = opts.prior != null ? opts.prior : 1.2, lam = opts.smooth != null ? opts.smooth : 14;
  const d = signedDistance(bin, w, h, band + 2);
  const fgIdx = [], bgIdx = [], node = new Int32Array(n).fill(-1), bandIdx = [];
  for (let i = 0; i < n; i++) {
    if (d[i] > band) fgIdx.push(i); else if (d[i] < -band) bgIdx.push(i);
    else { node[i] = bandIdx.length; bandIdx.push(i); }
  }
  if (fgIdx.length < 30 || bgIdx.length < 30 || !bandIdx.length) return fallback('no-sure');
  const pf = histModel(rgba, fgIdx, fgIdx.length), pb = histModel(rgba, bgIdx, bgIdx.length);
  // 두 색 분포가 겹치면(인물과 배경이 같은 색) 색으로는 못 가르므로 올가미를 그대로 둔다
  { let ov = 0, m = 0; const stepF = Math.max(1, Math.floor(fgIdx.length / 600)), stepB = Math.max(1, Math.floor(bgIdx.length / 600));
    for (let k = 0; k < fgIdx.length; k += stepF) { const p = fgIdx[k] * 4, a1 = pf(rgba[p], rgba[p + 1], rgba[p + 2]), b1 = pb(rgba[p], rgba[p + 1], rgba[p + 2]); ov += b1 / (a1 + b1); m++; }
    for (let k = 0; k < bgIdx.length; k += stepB) { const p = bgIdx[k] * 4, a1 = pf(rgba[p], rgba[p + 1], rgba[p + 2]), b1 = pb(rgba[p], rgba[p + 1], rgba[p + 2]); ov += a1 / (a1 + b1); m++; }
    if (ov / m > 0.3) return fallback('similar'); }
  // 이웃 색차의 평균으로 가장자리 감도(β) 추정 (띠 근처에서만)
  const dx8 = [1, 1, 0, -1], dy8 = [0, 1, 1, 1];
  const cd = (a, b) => { const p = a * 4, q = b * 4, r = rgba[p] - rgba[q], g = rgba[p + 1] - rgba[q + 1], bb = rgba[p + 2] - rgba[q + 2]; return r * r + g * g + bb * bb; };
  let sum = 0, cnt = 0;
  for (const i of bandIdx) { const x = i % w, y = (i / w) | 0; for (let k = 0; k < 4; k++) { const xx = x + dx8[k], yy = y + dy8[k]; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; sum += cd(i, yy * w + xx); cnt++; } }
  const beta = cnt ? 1 / (2 * Math.max(30, sum / cnt)) : 1 / 2000;
  const N = bandIdx.length, S = N, T = N + 1; // 그래프 노드: 띠 픽셀 + source(인물) + sink(배경)
  const g = makeGraph(N + 2, N * 6);
  const capS = new Float32Array(N), capT = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const i = bandIdx[k], p = i * 4, r = rgba[p], gg = rgba[p + 1], b = rgba[p + 2];
    const eps = 1e-4, Df = -Math.log(pf(r, gg, b) + eps), Db = -Math.log(pb(r, gg, b) + eps);
    const pr = prior * (Math.abs(d[i]) / band) * (Math.abs(d[i]) / band + 0.3); // 올가미에서 멀수록 올가미 쪽 라벨을 선호
    capS[k] = Db + (d[i] < 0 ? pr : 0); // 배경으로 두는 비용 (source→i)
    capT[k] = Df + (d[i] > 0 ? pr : 0); // 인물로 두는 비용 (i→sink)
  }
  for (let k = 0; k < N; k++) {
    const i = bandIdx[k], x = i % w, y = (i / w) | 0;
    for (let q = 0; q < 8; q++) {
      const dx = q < 4 ? dx8[q] : -dx8[q - 4], dy = q < 4 ? dy8[q] : -dy8[q - 4];
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx, wt = lam * Math.exp(-beta * cd(i, j)) / (dx && dy ? 1.41421356 : 1) + 0.4;
      const kj = node[j];
      if (kj >= 0) { if (q < 4) g.add(k, kj, wt, wt); }
      else if (d[j] > 0) capS[k] += wt; else capT[k] += wt;
    }
  }
  for (let k = 0; k < N; k++) { const m = Math.min(capS[k], capT[k]); if (capS[k] - m > 1e-6) g.add(S, k, capS[k] - m, 0); if (capT[k] - m > 1e-6) g.add(k, T, capT[k] - m, 0); }
  maxflow(g, S, T);
  // source 쪽에서 닿는 노드 = 인물
  const reach = new Uint8Array(N + 2), qu = new Int32Array(N + 2); let qh = 0, qt = 0; qu[qt++] = S; reach[S] = 1;
  while (qh < qt) { const u = qu[qh++]; for (let e = g.head[u]; e !== -1; e = g.next[e]) { const v = g.to[e]; if (!reach[v] && g.cap[e] > 1e-6) { reach[v] = 1; qu[qt++] = v; } } }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = node[i] >= 0 ? (reach[node[i]] ? 255 : 0) : (d[i] > 0 ? 255 : 0);
  tidy(out, w, h, opts.islands != null ? opts.islands : 0.01);
  let outN = 0, ch = 0; for (let i = 0; i < n; i++) { if (out[i]) outN++; if ((out[i] > 0) !== (bin[i] > 0)) ch++; }
  // 결과가 올가미와 너무 달라지면(색 구분 실패) 믿지 않는다
  if (outN < fgN * 0.5 || outN > fgN * 1.6) return fallback('implausible');
  return { mask: out, ok: true, changed: ch };
}
