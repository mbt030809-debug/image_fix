// 공용 수학/이미지 유틸 (DOM 의존 없음: 워커·Node 테스트 공용)

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 이미지 버퍼: {w,h,d:Uint8ClampedArray RGBA(비프리멀티플라이드)} */
export function makeImg(w, h) {
  return { w, h, d: new Uint8ClampedArray(w * h * 4) };
}
export function cloneImg(img) {
  return { w: img.w, h: img.h, d: new Uint8ClampedArray(img.d) };
}
export function fillImg(img, r, g, b, a = 255) {
  const d = img.d;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
  }
  return img;
}

export function hasAlpha(img) {
  const d = img.d;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 255) return true;
  return false;
}

/** 0..1 휘도 플레인 */
export function lumaPlane(img) {
  const { w, h, d } = img;
  const n = w * h;
  const out = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2]) / 255;
  }
  return out;
}

/** 양선형 샘플 (RGBA, 프리멀티플라이드 가중). 바깥은 투명 */
export function sampleBilinear(img, x, y, out) {
  const { w, h, d } = img;
  x -= 0.5; y -= 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let r = 0, g = 0, b = 0, a = 0;
  for (let k = 0; k < 4; k++) {
    const xx = x0 + (k & 1), yy = y0 + (k >> 1);
    const wt = ((k & 1) ? fx : 1 - fx) * ((k >> 1) ? fy : 1 - fy);
    if (wt === 0 || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
    const i = (yy * w + xx) * 4;
    const al = d[i + 3] * wt;
    r += d[i] * al; g += d[i + 1] * al; b += d[i + 2] * al; a += al;
  }
  if (a <= 0) { out[0] = out[1] = out[2] = out[3] = 0; return out; }
  out[0] = r / a; out[1] = g / a; out[2] = b / a; out[3] = a;
  return out;
}

/** 가장자리 복제 양선형 샘플 (알파 무시, 불투명 이미지용 빠른 경로) */
export function sampleClamp(d, w, h, x, y, out) {
  x -= 0.5; y -= 0.5;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  let x1 = x0 + 1, y1 = y0 + 1;
  x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0;
  x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1;
  y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0;
  y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1;
  const i00 = (y0 * w + x0) * 4, i10 = (y0 * w + x1) * 4, i01 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  out[0] = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
  out[1] = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
  out[2] = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
  out[3] = d[i00 + 3] * w00 + d[i10 + 3] * w10 + d[i01 + 3] * w01 + d[i11 + 3] * w11;
  return out;
}

/** 영역 평균 축소 / 양선형 확대 (순수 JS 폴백: 캔버스 없는 환경·테스트용). 프리멀티플라이드 가중. */
export function resizeJS(img, nw, nh) {
  const { w, h, d } = img;
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  if (nw === w && nh === h) return cloneImg(img);

  // 1단계: 가로 (w×h → nw×h), 값은 (색*알파/255, 알파) 평균
  const tmp = new Float32Array(nw * h * 4);
  const sx = w / nw;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      if (sx > 1) {
        const x0 = x * sx, x1 = (x + 1) * sx;
        let wt = 0;
        for (let xi = Math.floor(x0); xi < Math.ceil(x1) && xi < w; xi++) {
          const cov = Math.min(xi + 1, x1) - Math.max(xi, x0);
          const i = (y * w + xi) * 4;
          const al = d[i + 3] / 255;
          r += d[i] * al * cov; g += d[i + 1] * al * cov; b += d[i + 2] * al * cov; a += d[i + 3] * cov; wt += cov;
        }
        r /= wt; g /= wt; b /= wt; a /= wt;
      } else {
        const fx = (x + 0.5) * sx - 0.5;
        const x0 = clamp(Math.floor(fx), 0, w - 1), x1 = Math.min(w - 1, x0 + 1);
        const t = clamp(fx - x0, 0, 1);
        const i0 = (y * w + x0) * 4, i1 = (y * w + x1) * 4;
        const a0 = d[i0 + 3] / 255, a1 = d[i1 + 3] / 255;
        r = d[i0] * a0 * (1 - t) + d[i1] * a1 * t;
        g = d[i0 + 1] * a0 * (1 - t) + d[i1 + 1] * a1 * t;
        b = d[i0 + 2] * a0 * (1 - t) + d[i1 + 2] * a1 * t;
        a = d[i0 + 3] * (1 - t) + d[i1 + 3] * t;
      }
      const o = (y * nw + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }

  // 2단계: 세로 (nw×h → nw×nh) + 비프리멀티플라이드 복원
  const out = makeImg(nw, nh);
  const od = out.d;
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      if (sy > 1) {
        const y0 = y * sy, y1 = (y + 1) * sy;
        let wt = 0;
        for (let yi = Math.floor(y0); yi < Math.ceil(y1) && yi < h; yi++) {
          const cov = Math.min(yi + 1, y1) - Math.max(yi, y0);
          const i = (yi * nw + x) * 4;
          r += tmp[i] * cov; g += tmp[i + 1] * cov; b += tmp[i + 2] * cov; a += tmp[i + 3] * cov; wt += cov;
        }
        r /= wt; g /= wt; b /= wt; a /= wt;
      } else {
        const fy = (y + 0.5) * sy - 0.5;
        const y0 = clamp(Math.floor(fy), 0, h - 1), y1 = Math.min(h - 1, y0 + 1);
        const t = clamp(fy - y0, 0, 1);
        const i0 = (y0 * nw + x) * 4, i1 = (y1 * nw + x) * 4;
        r = tmp[i0] * (1 - t) + tmp[i1] * t; g = tmp[i0 + 1] * (1 - t) + tmp[i1 + 1] * t;
        b = tmp[i0 + 2] * (1 - t) + tmp[i1 + 2] * t; a = tmp[i0 + 3] * (1 - t) + tmp[i1 + 3] * t;
      }
      const o = (y * nw + x) * 4;
      if (a > 1e-6) {
        const k = 255 / a;
        od[o] = r * k; od[o + 1] = g * k; od[o + 2] = b * k; od[o + 3] = a;
      }
    }
  }
  return out;
}

/** 캔버스를 쓸 수 있으면 하드웨어 리사이즈, 아니면 JS 폴백 */
export function resizeImg(img, nw, nh) {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  if (nw === img.w && nh === img.h) return cloneImg(img);
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const a = new OffscreenCanvas(img.w, img.h);
      const actx = a.getContext('2d');
      actx.putImageData(new ImageData(img.d, img.w, img.h), 0, 0);
      const b = new OffscreenCanvas(nw, nh);
      const bctx = b.getContext('2d', { willReadFrequently: true });
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
      // 큰 폭 축소는 2배씩 단계 축소해 앨리어싱 방지
      let cur = a, cw = img.w, ch = img.h;
      while (cw / 2 >= nw && ch / 2 >= nh) {
        const nwc = Math.max(nw, Math.floor(cw / 2)), nhc = Math.max(nh, Math.floor(ch / 2));
        const t = new OffscreenCanvas(nwc, nhc);
        const tctx = t.getContext('2d');
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nwc, nhc);
        cur = t; cw = nwc; ch = nhc;
      }
      bctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
      const id = bctx.getImageData(0, 0, nw, nh);
      return { w: nw, h: nh, d: id.data };
    } catch (e) { /* 폴백 */ }
  }
  return resizeJS(img, nw, nh);
}
