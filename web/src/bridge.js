// Android 쉘 브리지 래퍼 (브라우저에서는 대체 동작)
const A = typeof window !== 'undefined' ? window.Android : undefined;
export const isNative = !!A;

let imageHandler = null;
const nameFromHeader = (v) => { try { return decodeURIComponent(v || ''); } catch (e) { return v || ''; } };

async function pullPending() {
  if (!A) return [];
  const n = A.pendingCount();
  const files = [];
  for (let i = 0; i < n; i++) {
    try {
      let res = await fetch('/__shared/' + i);
      if (!res.ok) continue;
      const mt = (res.headers.get('Content-Type') || '').toLowerCase();
      const nm = nameFromHeader(res.headers.get('X-File-Name')).toLowerCase();
      if (/hei[cf]/.test(mt) || /\.(heic|heif)$/.test(nm)) { const r2 = await fetch('/__shared/' + i + '?convert=1'); if (r2.ok) res = r2; }
      const blob = await res.blob();
      const name = nameFromHeader(res.headers.get('X-File-Name')) || 'image';
      files.push(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
    } catch (e) { /* 건너뜀 */ }
  }
  A.clearPending();
  return files;
}

/** HEIC 등 WebView 가 못 읽는 포맷: 네이티브에서 JPEG 변환본 받기 (pending 인덱스 필요) */
export async function convertPending(index) {
  const res = await fetch('/__shared/' + index + '?convert=1');
  if (!res.ok) throw new Error('convert failed');
  return new File([await res.blob()], 'converted.jpg', { type: 'image/jpeg' });
}

if (typeof window !== 'undefined') {
  window.__nativeImages = async () => {
    const files = await pullPending();
    if (files.length && imageHandler) imageHandler(files);
  };
}

export const bridge = {
  isNative,
  info() {
    if (!A) return { sdk: 0, memMB: (navigator.deviceMemory || 4) * 1024, camera: false, model: 'web' };
    try { return JSON.parse(A.deviceInfo()); } catch (e) { return {}; }
  },
  /** 이미지가 선택/공유로 들어오면 호출될 핸들러 등록. 시작 시 대기 중인 이미지도 즉시 전달 */
  onImages(fn) {
    imageHandler = fn;
    if (A) pullPending().then((files) => { if (files.length) fn(files); });
  },
  pickImages(multiple) {
    if (A) { A.pickImages(!!multiple); return; }
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = !!multiple;
    inp.onchange = () => { if (inp.files && inp.files.length && imageHandler) imageHandler(Array.from(inp.files)); };
    inp.click();
  },
  canCamera() { return A ? !!this.info().camera : false; },
  takePhoto() { if (A) A.takePhoto(); },
  /** 파일 선택(이미지 외: LUT 등). 브라우저 input 을 사용 (WebView 는 onShowFileChooser 로 처리) */
  pickFile(accept, multiple = false) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept || '*/*'; inp.multiple = multiple;
      inp.onchange = () => resolve(inp.files ? Array.from(inp.files) : []);
      inp.oncancel = () => resolve([]);
      inp.click();
    });
  },
  async saveBlob(blob, name) {
    if (A && A.beginSave) {
      const id = A.beginSave(name, blob.type || 'image/jpeg');
      if (!id || id.startsWith('ERR:')) throw new Error(id || 'ERR:begin');
      const CH = 192 * 1024;
      for (let off = 0; off < blob.size; off += CH) {
        const b64 = await blobToB64(blob.slice(off, off + CH));
        if (!A.writeChunk(id, b64)) { A.abortSave(id); throw new Error('ERR:write'); }
      }
      const uri = A.endSave(id);
      if (!uri || uri.startsWith('ERR:')) throw new Error(uri || 'ERR:end');
      return { uri, name };
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { uri: null, name, blobUrl: url };
  },
  async share(res, blob) {
    if (A && res && res.uri) { A.share(res.uri, blob ? blob.type : 'image/jpeg'); return true; }
    try {
      if (navigator.canShare && blob && navigator.canShare({ files: [new File([blob], res.name, { type: blob.type })] })) {
        await navigator.share({ files: [new File([blob], res.name, { type: blob.type })] });
        return true;
      }
    } catch (e) { /* 취소 */ }
    return false;
  },
  view(res) { if (A && res && res.uri) A.viewImage(res.uri); },
  /**
   * AI 요청 릴레이(네이티브 전용). 웹 페이지는 인터넷에 직접 접근할 수 없고(CSP + 외부 요청 403),
   * 키는 기기 Keystore 에 암호화돼 있어 JS 로 다시 읽을 수 없다. 네이티브가 허용된 호스트/경로로만 전달한다.
   */
  ai: {
    available() { return !!(A && A.aiInfo); },
    info() { try { return A && A.aiInfo ? JSON.parse(A.aiInfo()) : null; } catch (e) { return null; } },
    /** key 가 빈 문자열이면 키는 유지하고 서버 주소만 바꾼다. 성공 true, 실패 시 사유 문자열 */
    setKey(key, base) { const r = A.aiSetKey(key || '', base || ''); return r === 'OK' ? true : String(r || 'ERR:unknown'); },
    clearKey() { A.aiClearKey(); },
    begin(spec) { const id = A.aiBegin(JSON.stringify(spec)); if (!id || String(id).startsWith('ERR:')) throw new Error(id || 'ERR:begin'); return String(id); },
    chunk(id, b64) { return !!A.aiChunk(id, b64); },
    send(id) { return !!A.aiSend(id); },
    status(id) { try { return JSON.parse(A.aiStatus(id)); } catch (e) { return { state: 'error', status: 0, code: 'bad_response' }; } },
    cancel(id) { try { A.aiCancel(id); } catch (e) { /* noop */ } },
    release(id) { try { A.aiRelease(id); } catch (e) { /* noop */ } },
  },
  setBars(hex, darkIcons) { if (A) A.setBars(hex, !!darkIcons); },
  toast(msg) { if (A) A.toast(msg); },
  haptic() { if (A) A.haptic(); },
  keepScreenOn(on) { if (A) A.keepScreenOn(!!on); },
  exit() { if (A) A.exit(); },
};

export function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
