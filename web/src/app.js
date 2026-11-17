// 앱 셸: 홈 화면, 설정, 사진 열기, 테마, 뒤로가기
import { h, icon, ensureSprite } from './ui/dom.js';
import { t, initLang, setLang, getLang } from './i18n.js';
import { Engine } from './engine/client.js';
import { Editor } from './editor.js';
import { Collage } from './collage.js';
import { bridge } from './bridge.js';
import * as Drafts from './drafts.js';
import { toast, openModal, Segmented, Switch, Chips, Btn, Slider, handleBack, confirmDialog } from './ui/components.js';
import { openAiSettings, aiConfig } from './tools/aisettings.js';
import { checkManually } from './update.js';
import { openGenerate } from './tools/aigenerate.js';

const SETTINGS_KEY = 'imagefix.settings';
const VERSION = '2.3.0';

async function decodeFile(file) {
  const opts = { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' };
  try { return await createImageBitmap(file, opts); }
  catch (e) {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); return await createImageBitmap(img); }
    finally { URL.revokeObjectURL(url); }
  }
}

export class App {
  constructor(root) {
    this.root = root;
    this.settings = this.loadSettings();
    initLang();
    if (this.settings.lang) setLang(this.settings.lang);
    ensureSprite();
    this.applyTheme();
    aiConfig(this);
    this.engine = new Engine();
    this.screen = 'home';
    this.homeEl = this.buildHome();
    this.editor = new Editor(this);
    this.editor.el.classList.add('screen');
    this.editor.el.hidden = true;
    this.collage = new Collage(this);
    root.append(this.homeEl, this.editor.el, this.collage.el);
    window.__onBack = () => this.onBack();
    window.__onPause = () => { this.editor.flushDraft(); };
    this.refreshDraftCard();
    bridge.onImages((files) => { if (this.pendingCollage) { this.pendingCollage = false; this.collage.open(files); } else this.openFiles(files); });
    window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (this.settings.theme === 'system') this.applyTheme(); });
  }

  loadSettings() {
    const d = { theme: 'dark', maxSide: 'auto', reduceMotion: false, format: 'image/jpeg', quality: 92, showStats: false, grid: true, presets: [] };
    try { return { ...d, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch (e) { return d; }
  }
  saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* noop */ } }

  applyTheme() {
    let th = this.settings.theme;
    if (th === 'system') th = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.dataset.theme = th;
    document.documentElement.dataset.reduceMotion = this.settings.reduceMotion ? '1' : '0';
    try { localStorage.setItem('imagefix.reduceMotion', this.settings.reduceMotion ? '1' : '0'); } catch (e) { /* noop */ }
    bridge.setBars(th === 'light' ? '#F6F6F6' : '#121212', th === 'light');
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = th === 'light' ? '#f6f6f6' : '#121212';
  }

  // ------------------------------------------------------------ 홈
  buildHome() {
    const logo = h('div', { class: 'logo', 'aria-hidden': 'true' }, icon('aperture', 'lg'));
    const settingsBtn = h('button', { class: 'iconbtn', type: 'button', 'aria-label': t('설정', 'Settings') }, icon('settings'));
    settingsBtn.addEventListener('click', () => this.openSettings());
    const pick = h('button', { class: 'btn filled block', type: 'button' }, icon('image'), t('사진 선택', 'Choose photo'));
    pick.addEventListener('click', () => bridge.pickImages(false));
    const tiles = [];
    if (bridge.canCamera()) {
      const cam = h('button', { class: 'tile', type: 'button' }, icon('camera', 'lg'), h('b', null, t('카메라', 'Camera')), h('span', null, t('바로 촬영해서 편집', 'Shoot and edit')));
      cam.addEventListener('click', () => bridge.takePhoto()); tiles.push(cam);
    }
    const col = h('button', { class: 'tile', type: 'button' }, icon('layout-grid', 'lg'), h('b', null, t('콜라주', 'Collage')), h('span', null, t('여러 장을 한 장으로', 'Combine several photos')));
    col.addEventListener('click', () => { this.pendingCollage = true; bridge.pickImages(true); }); tiles.push(col);
    if (bridge.ai.available()) {
      const gen = h('button', { class: 'tile', type: 'button' }, icon('wand-sparkles', 'lg'), h('b', null, t('AI로 이미지 만들기', 'Create with AI')), h('span', null, t('문구만으로 새 이미지 (무료 옵션)', 'New image from a prompt (free option)')));
      gen.addEventListener('click', () => openGenerate(this)); tiles.push(gen);
    }
    const blank = h('button', { class: 'tile', type: 'button' }, icon('square-dashed', 'lg'), h('b', null, t('빈 캔버스', 'Blank canvas')), h('span', null, t('텍스트·스티커로 디자인', 'Design with text & stickers')));
    blank.addEventListener('click', () => this.openBlankDialog()); tiles.push(blank);
    this.draftCard = h('div', { hidden: true });
    const wrap = h('div', { class: 'wrap' },
      h('header', null, h('div', { class: 'brand' }, logo, h('span', { translate: 'no' }, 'ImageFix')), settingsBtn),
      this.draftCard,
      h('section', { class: 'hero' }, h('h1', null, t('편집할 사진을 선택하세요', 'Choose a photo to edit')), h('p', null, t('자르기, 보정, 필터부터 텍스트·스티커·리터치까지. 편집은 이 기기 안에서 처리되고, AI 기능을 쓸 때만 선택한 영역(또는 입력한 문구)이 AI 서버로 가요.', 'Crop, adjust, filters, text, stickers and retouch. Editing runs on this device; only when you use AI features is the area you select (or your prompt) sent to an AI server.')), pick),
      h('div', { class: 'tiles' }, ...tiles),
      h('p', { class: 'foot' }, t('기본은 오프라인 · 인터넷은 AI 기능과 새 버전 확인에만, 필요한 부분(선택 영역·문구)만 사용해요', 'Offline by default · the internet is used only for AI features and update checks, and only for what you select or type')));
    const el = h('div', { class: 'screen home' }, wrap);
    return el;
  }

  openBlankDialog() {
    const presets = [['sq', '1:1', 1080, 1080], ['p45', '4:5', 1080, 1350], ['s916', '9:16', 1080, 1920], ['l169', '16:9', 1920, 1080], ['a4', 'A4', 1240, 1754], ['wide', '3:2', 1800, 1200]];
    let sel = presets[0], color = '#ffffff';
    const chips = Chips({ label: t('크기', 'Size'), items: presets.map((p) => ({ id: p[0], label: `${p[1]}  ${p[2]}×${p[3]}` })), value: 'sq', wrap: true, onSelect: (id) => { sel = presets.find((p) => p[0] === id); } });
    const cols = ['#ffffff', '#000000', '#f5e6c8', '#ffd1dc', '#b8e0ff', '#1f2937', '#ff3b30', '#34c759'];
    const sw = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('배경색', 'Background') });
    const bs = cols.map((c) => { const b = h('button', { class: 'swatch', type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: { background: c } }); b.addEventListener('click', () => { color = c; bs.forEach((x, i) => x.setAttribute('aria-checked', String(cols[i] === c))); }); sw.append(b); return b; });
    openModal({ title: t('빈 캔버스', 'Blank canvas'), build: (body, close) => {
      body.append(h('div', { class: 'sheet-sec' }, t('크기', 'Size')), chips.el, h('div', { class: 'sheet-sec' }, t('배경색', 'Background')), sw,
        h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '16px' } }, Btn(t('취소', 'Cancel'), 'text', close), Btn(t('만들기', 'Create'), 'filled', async () => {
          close();
          const [, , w, hh] = sel;
          const cv = document.createElement('canvas'); cv.width = w; cv.height = hh;
          const c = cv.getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, w, hh);
          const id = c.getImageData(0, 0, w, hh);
          const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
          await this.editor.openBuffer(w, hh, id.data.buffer, 'canvas', blob);
          this.showEditor();
        })));
    } });
  }

  // ------------------------------------------------------------ 설정
  openSettings() {
    const s = this.settings;
    openModal({ title: t('설정', 'Settings'), build: (body) => {
      const lang = Segmented({ label: t('언어', 'Language'), items: [{ id: 'ko', label: '한국어' }, { id: 'en', label: 'English' }], value: getLang(), onChange: (v) => { setLang(v); s.lang = v; this.saveSettings(); toast(t('언어를 바꿨어요. 앱을 다시 열면 모두 적용돼요.', 'Language changed. Reopen the app to apply everywhere.')); } });
      const theme = Segmented({ label: t('테마', 'Theme'), items: [{ id: 'dark', label: t('다크', 'Dark') }, { id: 'light', label: t('라이트', 'Light') }, { id: 'system', label: t('시스템', 'System') }], value: s.theme, onChange: (v) => { s.theme = v; this.saveSettings(); this.applyTheme(); } });
      const res = Chips({ label: t('작업 해상도', 'Working resolution'), items: [{ id: 'auto', label: t('자동', 'Auto') }, { id: '2560', label: '2560' }, { id: '3072', label: '3072' }, { id: '4096', label: '4096' }, { id: '6000', label: '6000' }], value: String(s.maxSide), wrap: true, onSelect: (id) => { s.maxSide = id; this.saveSettings(); } });
      const motion = Switch({ label: t('움직임 줄이기', 'Reduce motion'), value: s.reduceMotion, onChange: (v) => { s.reduceMotion = v; this.saveSettings(); this.applyTheme(); } });
      const grid = Switch({ label: t('자르기 격자선', 'Crop grid'), value: s.grid !== false, onChange: (v) => { s.grid = v; this.saveSettings(); } });
      const stats = Switch({ label: t('처리 정보 표시', 'Show processing info'), value: s.showStats, onChange: (v) => { s.showStats = v; this.saveSettings(); this.editor.stats.hidden = !v; } });
      body.append(...[h('div', { class: 'sheet-sec' }, t('언어', 'Language')), lang.el, h('div', { class: 'sheet-sec' }, t('테마', 'Theme')), theme.el,
        h('div', { class: 'sheet-sec' }, t('작업 해상도 (긴 변 px)', 'Working resolution (long side, px)')), res.el,
        h('p', { class: 'sheet-note' }, t('높을수록 선명하지만 메모리를 더 써요. 보통은 자동을 권장해요.', 'Higher is sharper but uses more memory. Auto is recommended.')),
        motion.el, grid.el, stats.el,
        h('div', { class: 'sheet-sec' }, t('AI 도구', 'AI tools')),
        h('p', { class: 'sheet-note' }, bridge.ai.available() ? t('Cloudflare(하루 무료)·ModelScope Qwen-Image-Edit·Gemini·fal.ai FLUX.1 Fill·deAPI 로 선택한 영역을 고치거나 채우고, 새 이미지도 만들어요(Cloudflare·Gemini). 내 키·토큰은 기기에 암호화돼 저장돼요.', 'Edit or fill a selected area with Cloudflare (daily free), ModelScope Qwen-Image-Edit, Gemini, fal.ai FLUX.1 Fill or deAPI, and create new images (Cloudflare, Gemini). Your keys/tokens are stored encrypted on this device.') : t('AI 기능은 앱(APK)에서만 쓸 수 있어요.', 'AI features work only in the app (APK).')),
        bridge.ai.available() ? Btn(t('AI 설정 (제공자·키·모델)', 'AI settings (provider · key · model)'), 'tonal', () => openAiSettings(this), 'key-round') : null,
        h('div', { class: 'sheet-sec' }, t('정보', 'About')),
        h('div', { class: 'kv' }, h('span', null, t('버전', 'Version')), h('b', null, VERSION)),
        bridge.update.available() ? Btn(t('새 버전 확인', 'Check for updates'), 'tonal', () => checkManually(), 'refresh-cw') : null,
        bridge.update.available() ? Switch({ label: t('시작할 때 새 버전 알림 (GitHub 확인)', 'Check for updates at start (GitHub)'), value: s.autoUpdate !== false, onChange: (v) => { s.autoUpdate = v; this.saveSettings(); } }).el : null,
        bridge.update.available() ? h('p', { class: 'sheet-note' }, t('확인은 GitHub 의 공개 파일(release/latest.json)을 읽기만 하고, 사진·문구 등 아무것도 보내지 않아요. 설치는 안드로이드의 설치 화면에서 한 번 더 확인해요.', 'Checking only reads a public GitHub file (release/latest.json); nothing is sent. Installing is confirmed once more on the Android install screen.')) : null,
        h('p', { class: 'sheet-note' }, t('아이콘: Lucide (ISC), 폰트: SIL OFL 1.1. 인터넷 권한은 AI 기능(AI 수정·이미지 만들기)과 새 버전 확인에만 쓰여요. 쓰지 않으면 사진은 기기 밖으로 나가지 않아요.', 'Icons: Lucide (ISC), fonts: SIL OFL 1.1. The internet permission is used only by AI features (AI edit, Create with AI) and the update check. If you never use them, your photos never leave the device.'))].filter(Boolean));
    } });
  }

  async refreshDraftCard() {
    const d = await Drafts.loadDraft();
    this.draftCard.replaceChildren();
    this.draftCard.hidden = !d;
    if (!d) return;
    const when = new Date(d.rec.ts || Date.now());
    const label = `${when.getMonth() + 1}/${when.getDate()} ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
    const b = h('button', { class: 'tile', type: 'button', style: { flexDirection: 'row', alignItems: 'center', width: '100%' } },
      d.rec.thumb ? h('img', { src: d.rec.thumb, alt: '', style: { width: '56px', height: '56px', objectFit: 'cover', borderRadius: '8px', flex: 'none' } }) : icon('history', 'lg'),
      h('div', { style: { minWidth: 0 } }, h('b', null, t('이어서 편집하기', 'Continue editing')), h('br'), h('span', null, `${d.rec.name || ''} · ${label}`)));
    b.addEventListener('click', () => this.restoreDraft(d));
    this.draftCard.append(b);
  }

  async restoreDraft(d) {
    try {
      this.showEditor();
      this.editor.loadingEl.hidden = false;
      const file = new File([d.src.blob], (d.src.name || 'image') + '.jpg', { type: d.src.blob.type || 'image/jpeg' });
      const bmp = await decodeFile(file);
      const pre = await Drafts.readAssets(d.rec.doc); // openBitmap 이 저장소를 비우기 전에 자산(레이어 이미지·마스크)을 읽어 둔다
      await this.editor.openBitmap(bmp, d.src.name || 'image', d.src.blob);
      await this.editor.restoreDoc(d.rec, pre);
      toast(t('이전 작업을 불러왔어요 (실행 취소 기록은 초기화돼요)', 'Restored your last session (undo history is reset)'));
    } catch (e) { console.error(e); this.goHome(true); toast(t('이전 작업을 불러오지 못했어요.', "Couldn't restore the last session.")); }
  }

  // ------------------------------------------------------------ 화면 전환 / 열기
  showCollage() { this.screen = 'collage'; this.homeEl.hidden = true; this.editor.el.hidden = true; this.collage.el.hidden = false; requestAnimationFrame(() => this.collage.layoutCanvas()); }
  showEditor() { this.screen = 'editor'; this.homeEl.hidden = true; this.collage.el.hidden = true; this.editor.el.hidden = false; this.editor.stats.hidden = !this.settings.showStats; requestAnimationFrame(() => this.editor.view.resize()); }
  goHome(keepDraft) {
    this.screen = 'home'; this.editor.closeAll(); this.editor.el.hidden = true; this.collage.el.hidden = true; this.homeEl.hidden = false;
    clearTimeout(this.editor.draftT);
    if (keepDraft) this.refreshDraftCard(); else Drafts.clearAll().then(() => this.refreshDraftCard());
  }

  /** AI 로 만든 이미지(Blob)를 바로 편집기로 연다 */
  async openGenerated(blob) {
    await this.openFiles([new File([blob], 'AI 이미지.png', { type: blob.type || 'image/png' })]);
  }

  async openFiles(files) {
    if (!files || !files.length) return;
    const f = files[0];
    try {
      this.showEditor();
      this.editor.loadingEl.hidden = false;
      const bmp = await decodeFile(f);
      await this.editor.openBitmap(bmp, f.name, f);
      if (files.length > 1) toast(t('첫 번째 사진을 열었어요', 'Opened the first photo'));
    } catch (e) {
      console.error(e);
      this.goHome(true);
      toast(t('사진을 열 수 없어요. 다른 사진을 선택해 보세요.', "Can't open this photo. Try another one."));
    }
  }

  onBack() {
    if (handleBack()) return true;
    if (this.screen === 'editor') return this.editor.onBack();
    if (this.screen === 'collage') { this.collage.close(); return true; }
    if (this.exitArmed) return false;
    this.exitArmed = true;
    toast(t('한 번 더 누르면 종료돼요', 'Press back again to exit'), { duration: 2000 });
    setTimeout(() => { this.exitArmed = false; }, 2000);
    return true;
  }
}
