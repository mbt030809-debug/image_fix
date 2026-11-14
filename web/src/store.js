// 문서 모델 + 히스토리 (불변 객체 스냅샷)
import { DEFAULT_GEO } from './engine/geometry.js';

export function newDoc() {
  return {
    v: 1,
    geo: DEFAULT_GEO(),
    retouch: [],
    adj: {},
    filter: { id: 'none', amt: 100 },
    lutRef: null,
    fx: [],
    locals: [],
    layers: [],
    frame: null,
    bg: { type: 'none' },
  };
}

/** 경로 기반 불변 갱신: setIn(doc, 'adj.exposure', 10) / setIn(doc, ['layers', 2, 'x'], .5) */
export function setIn(obj, path, val) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  const rec = (o, i) => {
    const k = keys[i];
    const base = o == null ? (typeof keys[i] === 'number' ? [] : {}) : o;
    const copy = Array.isArray(base) ? base.slice() : { ...base };
    copy[k] = i === keys.length - 1 ? val : rec(base[k], i + 1);
    return copy;
  };
  return rec(obj, 0);
}
export function delIn(obj, path) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  const last = keys[keys.length - 1];
  const parent = keys.length > 1 ? getIn(obj, keys.slice(0, -1)) : obj;
  if (parent == null) return obj;
  const copy = Array.isArray(parent) ? parent.filter((_, i) => i !== last) : (() => { const c = { ...parent }; delete c[last]; return c; })();
  return keys.length > 1 ? setIn(obj, keys.slice(0, -1), copy) : copy;
}
export function getIn(obj, path) {
  const keys = Array.isArray(path) ? path : String(path).split('.');
  let o = obj;
  for (const k of keys) { if (o == null) return undefined; o = o[k]; }
  return o;
}

export class Store {
  constructor(doc) {
    this.base = doc || newDoc();   // 마지막 커밋된 문서
    this.doc = this.base;          // 현재(미리보기 포함)
    this.past = [];
    this.future = [];
    this.labels = [];              // past 와 같은 길이: 각 항목의 라벨(= 해당 상태로 이어진 변경)
    this.listeners = new Set();
    this.max = 120;
    this.revision = 0;
    this.savedRevision = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind) { this.listeners.forEach((f) => f(kind, this.doc)); }
  get() { return this.doc; }
  getBase() { return this.base; }

  /** 미리보기: 커밋된 문서(base)에서 fn 을 적용한 결과를 보여줌 (히스토리 없음) */
  preview(fn) {
    this.doc = fn(this.base);
    this.emit('preview');
  }
  /** 미리보기를 확정해 히스토리에 기록 */
  commit(label) {
    if (this.doc === this.base) return;
    this.past.push(this.base);
    this.labels.push(label || '');
    if (this.past.length > this.max) { this.past.shift(); this.labels.shift(); }
    this.future = [];
    this.base = this.doc;
    this.revision++;
    this.emit('commit');
  }
  /** 한 번에 적용+확정 */
  apply(fn, label) {
    this.doc = fn(this.base);
    this.commit(label);
  }
  /** 미리보기 취소 */
  revert() {
    if (this.doc !== this.base) { this.doc = this.base; this.emit('revert'); }
  }
  canUndo() { return this.past.length > 0; }
  canRedo() { return this.future.length > 0; }
  undo() {
    if (!this.past.length) return false;
    this.future.push(this.base);
    this.base = this.doc = this.past.pop();
    this.labels.pop();
    this.revision--;
    this.emit('undo');
    return true;
  }
  redo() {
    if (!this.future.length) return false;
    this.past.push(this.base);
    this.labels.push('');
    this.base = this.doc = this.future.pop();
    this.revision++;
    this.emit('redo');
    return true;
  }
  /** 새 문서로 교체하고 히스토리 초기화 */
  reset(doc) {
    this.base = this.doc = doc || newDoc();
    this.past = []; this.future = []; this.labels = [];
    this.revision = 0; this.savedRevision = 0;
    this.emit('reset');
  }
  isDirty() { return this.revision !== this.savedRevision || this.doc !== this.base; }
  markSaved() { this.savedRevision = this.revision; }
}

let idSeq = 1;
export const uid = (p = 'l') => p + Date.now().toString(36) + (idSeq++).toString(36);
