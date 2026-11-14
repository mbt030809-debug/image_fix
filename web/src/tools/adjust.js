// 조정: 노출·밝기·대비·하이라이트·그림자·색온도·채도·디테일·비네팅·그레인 + 자동 보정 + 히스토그램
import { h, icon } from '../ui/dom.js';
import { t } from '../i18n.js';
import { setIn } from '../store.js';
import { IconBtn, Btn, toast } from '../ui/components.js';
import { ParamPanel } from './panel.js';
import { DEFAULTS } from '../engine/develop.js';

const P = (key, ko, en, group, min = -100, max = 100, def = 0, extra = {}) => ({ key, ko, en, group, min, max, def, ...extra });

export const ADJ_PARAMS = [
  P('exposure', '노출', 'Exposure', 'light'), P('brightness', '밝기', 'Brightness', 'light'), P('contrast', '대비', 'Contrast', 'light'),
  P('highlights', '하이라이트', 'Highlights', 'light'), P('shadows', '그림자', 'Shadows', 'light'), P('whites', '화이트', 'Whites', 'light'),
  P('blacks', '블랙', 'Blacks', 'light'), P('dehaze', '안개 제거', 'Dehaze', 'light'), P('fade', '페이드', 'Fade', 'light', 0, 100),
  P('saturation', '채도', 'Saturation', 'color'), P('vibrance', '생동감', 'Vibrance', 'color'), P('temp', '색온도', 'Warmth', 'color'),
  P('tint', '틴트', 'Tint', 'color'), P('hue', '색상 회전', 'Hue', 'color', -180, 180),
  P('sharpen', '선명도', 'Sharpen', 'detail', 0, 100), P('clarity', '명료도', 'Clarity', 'detail'), P('texture', '질감', 'Texture', 'detail'),
  P('denoise', '노이즈 제거', 'Denoise', 'detail', 0, 100),
  P('vignette', '비네팅', 'Vignette', 'look'), P('vigSize', '비네팅 크기', 'Vignette size', 'look', 0, 100, DEFAULTS.vigSize),
  P('vigFeather', '비네팅 번짐', 'Vignette feather', 'look', 0, 100, DEFAULTS.vigFeather), P('grain', '그레인', 'Grain', 'look', 0, 100),
  P('grainSize', '그레인 크기', 'Grain size', 'look', 0, 100, DEFAULTS.grainSize),
];
export const ADJ_GROUPS = [{ id: 'light', ko: '밝기', en: 'Light' }, { id: 'color', ko: '색상', en: 'Color' }, { id: 'detail', ko: '디테일', en: 'Detail' }, { id: 'look', ko: '효과', en: 'Look' }];

export function open(ed, body) {
  const get = (k) => ed.doc().adj[k];
  const set = (k, v, commit) => {
    const def = ADJ_PARAMS.find((p) => p.key === k).def;
    ed.preview((d) => {
      const adj = { ...d.adj };
      if (v === def) delete adj[k]; else adj[k] = v;
      return setIn(d, 'adj', adj);
    });
    if (commit) ed.commit(t('조정', 'Adjust'));
  };
  const panel = ParamPanel(ed, { params: ADJ_PARAMS, groups: ADJ_GROUPS, get, set });
  ed.setPeek(true);

  // 히스토그램 (펼침 상태에서 표시)
  const hist = h('canvas', { class: 'hist', width: 256, height: 56, 'aria-label': t('히스토그램', 'Histogram'), role: 'img', hidden: true });
  function drawHist(hh) {
    if (!hh) return;
    const c = hist.getContext('2d'), W = hist.width, H = hist.height;
    c.clearRect(0, 0, W, H);
    let mx = 1;
    for (let i = 0; i < 768; i++) mx = Math.max(mx, hh[i + (i < 256 ? 0 : 0)]);
    const cols = ['rgba(255,80,80,.55)', 'rgba(70,210,110,.55)', 'rgba(90,150,255,.55)'];
    c.globalCompositeOperation = 'lighter';
    for (let ch = 0; ch < 3; ch++) {
      c.fillStyle = cols[ch];
      c.beginPath(); c.moveTo(0, H);
      for (let i = 0; i < 256; i++) c.lineTo(i, H - Math.pow(hh[ch * 256 + i] / mx, 0.6) * (H - 2));
      c.lineTo(255, H); c.closePath(); c.fill();
    }
  }
  ed.wantHist = true; ed.onHist = drawHist; if (ed.hist) drawHist(ed.hist);
  ed.requestRender('full');

  body.append(panel.el, hist);

  const reset = Btn(t('초기화', 'Reset'), 'text', () => {
    ed.apply((d) => setIn(d, 'adj', {}), t('조정 초기화', 'Reset adjustments'));
    panel.refresh();
  });
  const auto = IconBtn('wand-sparkles', t('자동 보정', 'Auto enhance'), async () => {
    try {
      const adj = await ed.engine.analyze({ geo: ed.doc().geo, retouch: ed.doc().retouch });
      const clean = {};
      for (const [k, v] of Object.entries(adj)) if (v) clean[k] = v;
      ed.apply((d) => setIn(d, 'adj', { ...d.adj, ...clean }), t('자동 보정', 'Auto enhance'));
      panel.refresh();
      toast(t('자동 보정을 적용했어요', 'Auto enhance applied'));
    } catch (e) { console.error(e); }
  }, 'tint');
  ed.setActions([auto, reset]);

  return {
    refresh() { panel.refresh(); },
    onPeek(peek) { panel.render(peek); hist.hidden = peek; if (!peek && ed.hist) drawHist(ed.hist); },
    close() { ed.wantHist = false; ed.onHist = null; },
  };
}
