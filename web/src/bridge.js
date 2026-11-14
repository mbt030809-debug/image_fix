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
      const res = await fetch('/__shared/' + i);
      if (!res.ok) continue;
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
  setBars(hex, darkIcons) { if (A) A.setBars(hex, !!darkIcons); },
  toast(msg) { if (A) A.toast(msg); },
  haptic() { if (A) A.haptic(); },
  keepScreenOn(on) { if (A) A.keepScreenOn(!!on); },
  exit() { if (A) A.exit(); },
};

function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => { const s = String(fr.result); resolve(s.slice(s.indexOf(',') + 1)); };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}
