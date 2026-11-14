// .cube 3D LUT 파서 → {size, data: Float32Array(size^3*3)} (R 가 가장 빠르게 변하는 순서)
export function parseCube(text) {
  let size = 0;
  const vals = [];
  let dmin = [0, 0, 0], dmax = [1, 1, 1];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const up = line.toUpperCase();
    if (up.startsWith('LUT_3D_SIZE')) { size = parseInt(line.split(/\s+/)[1], 10); continue; }
    if (up.startsWith('LUT_1D_SIZE')) throw new Error('1D LUT 는 지원하지 않아요');
    if (up.startsWith('DOMAIN_MIN')) { dmin = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('DOMAIN_MAX')) { dmax = line.split(/\s+/).slice(1, 4).map(Number); continue; }
    if (up.startsWith('TITLE') || up.startsWith('LUT_')) continue;
    const p = line.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((v) => Number.isFinite(v))) vals.push(p[0], p[1], p[2]);
  }
  if (!size || size < 2 || size > 128) throw new Error('LUT 크기를 읽을 수 없어요');
  if (vals.length < size * size * size * 3) throw new Error('LUT 데이터가 부족해요');
  const data = new Float32Array(size * size * size * 3);
  for (let i = 0; i < data.length; i++) {
    const c = i % 3;
    data[i] = Math.min(1, Math.max(0, (vals[i] - dmin[c]) / ((dmax[c] - dmin[c]) || 1)));
  }
  return { size, data };
}
