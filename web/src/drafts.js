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

export async function loadDraft() {
  try {
    const [src, doc] = await Promise.all([get('src'), get('doc')]);
    if (src && src.blob && doc && doc.doc) return { src, rec: doc };
  } catch (e) { /* 없음 */ }
  return null;
}
