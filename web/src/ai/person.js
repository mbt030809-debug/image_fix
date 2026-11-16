// 인물(주요 피사체) 분리 모델 U²-Net-P(4.5MB, Apache-2.0)를 ONNX Runtime Web(wasm, 단일 스레드)로 기기에서 실행한다.
// 모델·런타임은 앱에 포함돼 있어(`ort/`, `models/`) 인터넷이 필요 없고, 사진은 기기 밖으로 나가지 않는다.
const SIZE = 320;
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];
let sessP = null, ortP = null;

function loadOrt() {
  if (ortP) return ortP;
  ortP = new Promise((resolve, reject) => {
    if (window.ort) return resolve(window.ort);
    const s = document.createElement('script');
    s.src = new URL('ort/ort.wasm.min.js', document.baseURI).href;
    s.onload = () => (window.ort ? resolve(window.ort) : reject(new Error('ort missing')));
    s.onerror = () => reject(new Error('ort load failed'));
    document.head.appendChild(s);
  }).catch((e) => { ortP = null; throw e; });
  return ortP;
}
function session() {
  if (sessP) return sessP;
  sessP = (async () => {
    const ort = await loadOrt();
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).href;
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.simd = true;
    const r = await fetch(new URL('models/u2netp.onnx', document.baseURI).href);
    if (!r.ok) throw new Error('model ' + r.status);
    return ort.InferenceSession.create(new Uint8Array(await r.arrayBuffer()), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  })().catch((e) => { sessP = null; throw e; });
  return sessP;
}

/** RGBA(SIZE×SIZE) → NCHW float32 (rembg 의 u2net 전처리: 최댓값으로 나눈 뒤 ImageNet 평균/표준편차) */
export function preprocess(rgba, w = SIZE, h = SIZE) {
  const n = w * h, out = new Float32Array(3 * n);
  let mx = 1; for (let i = 0; i < n; i++) { const p = i * 4; mx = Math.max(mx, rgba[p], rgba[p + 1], rgba[p + 2]); }
  for (let i = 0; i < n; i++) { const p = i * 4; for (let c = 0; c < 3; c++) out[c * n + i] = (rgba[p + c] / mx - MEAN[c]) / STD[c]; }
  return out;
}
/** 모델 출력(확률) → 0..255, 최소/최대로 늘린다 */
export function postprocess(d) {
  let lo = Infinity, hi = -Infinity; for (let i = 0; i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  const out = new Uint8Array(d.length), k = hi > lo ? 255 / (hi - lo) : 0;
  for (let i = 0; i < d.length; i++) out[i] = Math.round((d[i] - lo) * k);
  return out;
}

/** 사진(canvas 또는 ImageBitmap 등 drawImage 가능한 것)에서 피사체 맵(SIZE×SIZE, 0..255)을 만든다 */
export async function personMap(source) {
  const ort = await loadOrt(), sess = await session();
  const cv = document.createElement('canvas'); cv.width = SIZE; cv.height = SIZE;
  const cx = cv.getContext('2d', { willReadFrequently: true }); cx.drawImage(source, 0, 0, SIZE, SIZE);
  const input = new ort.Tensor('float32', preprocess(cx.getImageData(0, 0, SIZE, SIZE).data), [1, 3, SIZE, SIZE]);
  const res = await sess.run({ [sess.inputNames[0]]: input });
  return { map: postprocess(res[sess.outputNames[0]].data), size: SIZE };
}
export const MAP_SIZE = SIZE;
