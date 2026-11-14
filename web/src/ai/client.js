// AI 요청 실행: 네이티브 릴레이로 업로드 → 폴링 → 결과 수신 (제공자별 호스트/키는 네이티브가 관리)
import { bridge, blobToB64 } from '../bridge.js';

const CHUNK = 192 * 1024;

export class AiError extends Error {
  constructor(info) {
    super((info && (info.message || info.code)) || 'ai error');
    this.info = info || {};
  }
}

/**
 * provider: 'openai' | 'openrouter' | 'cloudflare'
 * req: {method, path, contentType?, body?: Blob}
 * opts: {signal?: AbortSignal, onPhase?: (phase)=>void, timeoutMs?: number}
 * 반환 {id, status} (state==='done'). 결과를 다 쓴 뒤 bridge.ai.release(id) 는 호출자 책임.
 */
export async function runRelay(provider, req, opts = {}) {
  const { onPhase, signal, timeoutMs = 360000 } = opts;
  const body = req.body || null;
  const spec = { provider, method: req.method, path: req.path };
  if (body) { spec.type = req.contentType; spec.len = body.size; }
  if (signal && signal.aborted) throw new AiError({ code: 'cancelled' });
  const id = bridge.ai.begin(spec);
  let finished = false;
  const abort = () => { if (!finished) bridge.ai.cancel(id); };
  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    onPhase && onPhase('upload');
    if (body) {
      for (let off = 0; off < body.size; off += CHUNK) {
        if (signal && signal.aborted) throw new AiError({ code: 'cancelled' });
        const b64 = await blobToB64(body.slice(off, off + CHUNK));
        if (!bridge.ai.chunk(id, b64)) throw new AiError({ code: 'upload', message: 'chunk rejected' });
      }
    }
    if (signal && signal.aborted) throw new AiError({ code: 'cancelled' });
    if (!bridge.ai.send(id)) throw new AiError({ code: 'upload', message: 'send rejected' });
    onPhase && onPhase('wait');
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 350));
      const st = bridge.ai.status(id);
      if (st.state === 'done') { finished = true; return { id, status: st }; }
      if (st.state === 'cancelled') throw new AiError({ code: 'cancelled' });
      if (st.state === 'error') throw new AiError(st);
      if (Date.now() - t0 > timeoutMs) { bridge.ai.cancel(id); throw new AiError({ code: 'timeout' }); }
    }
  } catch (e) {
    finished = true;
    bridge.ai.release(id);
    throw e;
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
  }
}

export async function fetchResult(id, i) {
  const res = await fetch(`/__ai/${id}/${i}`, { cache: 'no-store' });
  if (!res.ok) throw new AiError({ code: 'bad_response', status: res.status });
  return res.blob();
}

/** OpenAI: 이미지 편집 요청 → 결과 이미지 Blob 배열 (네이티브가 data[].b64_json 을 풀어 준다) */
export async function editImages(provider, req, opts) {
  const { id, status } = await runRelay(provider, req, opts);
  try {
    const n = Math.max(0, Math.min(10, status.n | 0));
    if (!n) throw new AiError({ code: 'bad_response', message: 'no images' });
    const out = [];
    for (let i = 0; i < n; i++) out.push(await fetchResult(id, i));
    return out;
  } finally {
    bridge.ai.release(id);
  }
}

/** raw 응답 제공자(OpenRouter/Cloudflare): 응답 본문 Blob + Content-Type 을 그대로 받는다 */
export async function relayRaw(provider, req, opts) {
  const { id, status } = await runRelay(provider, req, opts);
  try {
    const blob = await fetchResult(id, 0);
    return { blob, ctype: String(status.ctype || blob.type || ''), status };
  } finally {
    bridge.ai.release(id);
  }
}

/** OpenAI 키 확인 + 사용 가능한 모델 id 목록 (네이티브가 id 만 뽑아 준다) */
export async function listModelIds(opts) {
  const { id, status } = await runRelay('openai', { method: 'GET', path: '/models' }, opts);
  bridge.ai.release(id);
  return Array.isArray(status.ids) ? status.ids.map(String) : [];
}
