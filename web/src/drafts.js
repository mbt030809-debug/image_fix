// 작업 자동 복구: 앱이 백그라운드에서 종료돼도 마지막 편집을 이어서 할 수 있도록 IndexedDB 에 보관
const DB = 'imagefix', STORE = 'kv';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    } catch (e) { reject(e); }
  });
  return dbp;
}
function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode), s = t.objectStore(STORE);
    const req = fn(s);
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
export const put = (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => null);
export const get = (k) => tx('readonly', (s) => s.get(k)).catch(() => null);
export const clearAll = () => tx('readwrite', (s) => s.clear()).catch(() => null);

/**
 * 문서가 참조하는 자산(이미지 레이어·배경 사진·배경 제거 마스크)의 저장본을 미리 읽어 둔다.
 * 사진을 다시 여는 과정(startDraft)이 저장소를 비우므로, 반드시 열기 "전에" 호출해야 한다.
 */
export async function readAssets(doc) {
  const assets = new Map(), masks = new Map();
  const keys = new Set();
  for (const L of (doc && doc.layers) || []) if (L && L.t === 'image' && L.asset) keys.add(L.asset);
  if (doc && doc.bg && doc.bg.type === 'image' && doc.bg.asset) keys.add(doc.bg.asset);
  for (const k of keys) { const b = await get('asset:' + k); if (b) assets.set(k, b); }
  for (const op of (doc && doc.retouch) || []) {
    if (op && (op.k === 'cut' || op.k === 'bgblur') && op.mask) { const m = await get('mask:' + op.mask); if (m) masks.set(op.mask, m); }
  }
  return { assets, masks };
}

export async function loadDraft() {
  try {
    const [src, doc] = await Promise.all([get('src'), get('doc')]);
    if (src && src.blob && doc && doc.doc) return { src, rec: doc };
  } catch (e) { /* 없음 */ }
  return null;
}
