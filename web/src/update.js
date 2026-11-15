// 앱 업데이트: GitHub 의 release/latest.json 을 확인해 새 버전이 있으면 알리고, 내려받아 설치한다(네이티브 Updater + PackageInstaller).
// 확인은 시작할 때 12시간에 한 번(설정에서 끌 수 있음)과 설정의 "새 버전 확인" 버튼으로 한다. 이 확인에서 보내는 것은 없다(GitHub 파일을 읽기만 한다).
import { t } from './i18n.js';
import { bridge } from './bridge.js';
import { toast, confirmDialog } from './ui/components.js';

const DAY12 = 12 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

/** 확인이 끝날 때까지 기다려 최종 상태를 돌려준다 */
export async function checkStatus(timeoutMs = 30000) {
  bridge.update.check();
  const t0 = Date.now();
  for (;;) {
    await sleep(350);
    const st = bridge.update.status();
    if (st.state !== 'checking') return st;
    if (Date.now() - t0 > timeoutMs) return { state: 'error', err: 'timeout' };
  }
}

/** 새 버전 안내 → (동의하면) 내려받기 → 설치 시작. 반환: 'updated'(설치 화면으로 넘김) | 'later' | 'failed' */
export async function offerUpdate(st) {
  const notes = (st.notes || '').trim();
  const v = await confirmDialog({
    title: t(`새 버전 ${st.versionName} 이 있어요`, `Version ${st.versionName} is available`),
    body: (notes ? notes + '\n\n' : '') + t(`내려받기 약 ${mb(st.size || 0)}. 설치하면 앱이 다시 시작돼요(작업은 자동 복구돼요).`, `Download ≈ ${mb(st.size || 0)}. The app restarts after installing (your work is restored).`),
    actions: [{ label: t('나중에', 'Later'), value: 'later' }, { label: t('업데이트', 'Update'), value: 'go', kind: 'filled' }],
  });
  if (v !== 'go') return 'later';
  return downloadAndInstall(st);
}

export async function downloadAndInstall(st0) {
  toast(t('새 버전을 내려받는 중…', 'Downloading the new version…'), { duration: 3000 });
  bridge.update.download();
  let last = 0;
  for (;;) {
    await sleep(500);
    const st = bridge.update.status();
    if (st.state === 'downloading') {
      const pct = st.total ? Math.floor((st.done / st.total) * 100) : 0;
      if (pct >= last + 20) { last = pct; toast(t(`내려받는 중… ${pct}%`, `Downloading… ${pct}%`), { duration: 1500 }); }
      continue;
    }
    if (st.state === 'ready') break;
    toast(t('내려받지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.', "Couldn't download the update. Check your connection and try again.") + (st.err ? ` (${String(st.err).slice(0, 60)})` : ''), { duration: 6000 });
    return 'failed';
  }
  return installNow();
}

async function installNow() {
  bridge.update.install();
  await sleep(600);
  const st = bridge.update.status();
  if (st.state === 'needperm') {
    const v = await confirmDialog({
      title: t('설치 허용이 필요해요', 'Allow installing'),
      body: t('열리는 설정에서 “이 출처의 앱 허용”을 켠 뒤 돌아와서 “다시 설치”를 눌러 주세요.', 'In the settings that open, turn on "Allow from this source", come back, and tap "Install again".'),
      actions: [{ label: t('취소', 'Cancel'), value: 'no' }, { label: t('다시 설치', 'Install again'), value: 'again', kind: 'filled' }],
    });
    return v === 'again' ? installNow() : 'later';
  }
  if (st.state === 'error') { toast(t('설치를 시작하지 못했어요', "Couldn't start the installation") + (st.err ? ` (${String(st.err).slice(0, 60)})` : ''), { duration: 6000 }); return 'failed'; }
  toast(t('설치 화면에서 “업데이트”를 눌러 주세요', 'Tap "Update" on the install screen'), { duration: 6000 });
  return 'updated';
}

/** 설정의 "새 버전 확인" 버튼 */
export async function checkManually() {
  if (!bridge.update.available()) { toast(t('업데이트는 앱(APK)에서만 쓸 수 있어요', 'Updates work only in the app (APK)')); return; }
  toast(t('새 버전을 확인하는 중…', 'Checking for updates…'), { duration: 2000 });
  const st = await checkStatus();
  if (st.state === 'available') await offerUpdate(st);
  else if (st.state === 'none') toast(t('최신 버전이에요', "You're up to date"));
  else toast(t('새 버전을 확인하지 못했어요. 인터넷 연결을 확인해 주세요.', "Couldn't check for updates. Check your connection.") + (st.err ? ` (${String(st.err).slice(0, 60)})` : ''), { duration: 5000 });
}

/** 시작할 때 조용히 확인(12시간에 한 번, 설정에서 끌 수 있음). 홈 화면일 때만 안내한다 */
export async function autoCheck(app) {
  try {
    if (!bridge.update.available() || app.settings.autoUpdate === false) return;
    const now = Date.now();
    if (app.settings.updateCheckedAt && now - app.settings.updateCheckedAt < DAY12) return;
    const st = await checkStatus();
    if (st.state === 'none' || st.state === 'available') { app.settings.updateCheckedAt = now; app.saveSettings(); }
    if (st.state === 'available' && app.screen === 'home') await offerUpdate(st);
  } catch (e) { /* 조용히 넘어간다 */ }
}
