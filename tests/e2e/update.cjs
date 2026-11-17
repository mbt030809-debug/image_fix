// 앱 업데이트 E2E (가짜 네이티브): 설정의 "새 버전 확인"·자동 확인 스위치, 새 버전 안내 → 나중에 / 업데이트 → 내려받기 → 설치, 설치 허용 필요·내려받기 실패·확인 실패, 시작할 때 12시간에 한 번 자동 확인
const path = require('path');
const { launch, close } = require('./lib.cjs');
const { init } = require('./ai_lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');

(async () => {
  const h = await launch({ init, shared: [{ file: path.join(FIX, 'landscape.jpg'), name: 'landscape.jpg' }] });
  const { page } = h;
  let bad = 0;
  const check = (name, ok, extra = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra ? ' ' + extra : '')); if (!ok) bad++; };
  await page.waitForFunction(() => window.imagefix && window.imagefix.editor.base && !window.imagefix.editor.busy, null, { timeout: 30000 });
  await page.evaluate(() => sessionStorage.setItem('t_upd', 'available')); // 가짜 네이티브: 새 버전이 있는 상태로 시작
  await page.reload();
  await page.waitForSelector('.home .tile', { timeout: 15000 });
  h.errors.length = 0;
  const calls = () => page.evaluate(() => window.__ai.upd.calls.join());
  const mode = (m) => page.evaluate((x) => { const U = window.__ai.upd; U.mode = x; U.state = 'idle'; U.calls.length = 0; U.allowed = false; }, m);
  const snack = () => page.locator('.snackbar').last().textContent().catch(() => '');
  const openSettings = async () => { await page.click('.home [aria-label="설정"]'); await page.waitForTimeout(250); };
  const closeModal = async () => { await page.click('.msheet [aria-label="닫기"]'); await page.waitForTimeout(200); };

  // ---------------------------------------------------------------- 1) 자동 확인 (시작 후 약 4초)
  console.log('▶ 시작할 때 자동 확인');
  await page.waitForSelector('.dialog', { timeout: 15000 });
  const dlg = await page.locator('.dialog').textContent();
  check('home shows the new-version dialog by itself: version, notes, download size', /9\.9\.9/.test(dlg) && /개선 1/.test(dlg) && /3\.5 MB/.test(dlg), dlg.slice(0, 120));
  await h.shot('u1_available');
  await page.click('.dialog .btn >> text=나중에'); await page.waitForTimeout(200);
  check('"Later" closes it without downloading', (await calls()) === 'check' && (await page.locator('.dialog').count()) === 0);
  await page.reload(); await page.waitForSelector('.home .tile', { timeout: 15000 });
  await page.waitForTimeout(6500);
  check('every start checks again (no 12-hour wait): the dialog shows again for the same version', (await calls()) === 'check' && (await page.locator('.dialog').count()) === 1);
  await page.click('.dialog .btn >> text=나중에'); await page.waitForTimeout(200);

  // ---------------------------------------------------------------- 2) 설정: 수동 확인
  console.log('▶ 설정: 새 버전 확인');
  await openSettings();
  check('settings show the check button and the auto-check switch (on by default)', (await page.locator('.msheet .btn >> text=새 버전 확인').count()) === 1 && (await page.locator('.msheet .switch >> nth=-1').getAttribute('aria-checked')) === 'true' && /GitHub/.test(await page.locator('.msheet').last().textContent()) && !/\bnull\b/.test(await page.locator('.msheet').last().textContent()));
  await h.shot('u2_settings');
  await mode('none');
  await page.click('.msheet .btn >> text=새 버전 확인'); await page.waitForTimeout(1200);
  check('already up to date → says so', /최신 버전이에요/.test(await snack()) && (await calls()) === 'check');
  await mode('checkfail');
  await page.click('.msheet .btn >> text=새 버전 확인'); await page.waitForTimeout(1200);
  check('a failed check is reported with a hint to check the connection', /확인하지 못했어요/.test(await snack()) && /404/.test(await snack()));
  await mode('available');
  await page.click('.msheet .btn >> text=새 버전 확인'); await page.waitForSelector('.dialog', { timeout: 8000 });
  await page.click('.dialog .btn >> text=업데이트');
  await page.waitForFunction(() => window.__ai.upd.state === 'installing', null, { timeout: 15000 });
  await page.waitForTimeout(900);
  check('Update → download → install, in that order, once each', (await calls()) === 'check,download,install', await calls());
  check('tells the user to confirm on the Android install screen', /설치 화면/.test(await snack()));

  // ---------------------------------------------------------------- 3) 설치 허용 필요 / 내려받기 실패
  console.log('▶ 설치 허용 · 실패');
  await mode('needperm');
  await page.click('.msheet .btn >> text=새 버전 확인'); await page.waitForSelector('.dialog', { timeout: 8000 });
  await page.click('.dialog .btn >> text=업데이트');
  await page.waitForSelector('.dialog >> text=설치 허용이 필요해요', { timeout: 15000 });
  check('"allow installing" explains the Android setting and offers "Install again"', (await page.locator('.dialog .btn >> text=다시 설치').count()) === 1 && (await calls()) === 'check,download,install');
  await page.evaluate(() => { window.__ai.upd.allowed = true; });
  await page.click('.dialog .btn >> text=다시 설치');
  await page.waitForFunction(() => window.__ai.upd.state === 'installing', null, { timeout: 8000 });
  check('after allowing, "Install again" starts the installation', (await calls()) === 'check,download,install,install');
  await mode('dlfail');
  await page.click('.msheet .btn >> text=새 버전 확인'); await page.waitForSelector('.dialog', { timeout: 8000 });
  await page.click('.dialog .btn >> text=업데이트');
  await page.waitForFunction(() => window.__ai.upd.state === 'error', null, { timeout: 15000 });
  await page.waitForTimeout(900);
  check('a failed download (hash mismatch) is reported and nothing is installed', /내려받지 못했어요/.test(await snack()) && !(await calls()).includes('install'), await calls());

  // ---------------------------------------------------------------- 3b) 다른 창이 열려 있으면 가리지 않는다
  console.log('▶ 열린 창을 가리지 않기');
  await closeModal();
  await page.evaluate(() => { const st = window.imagefix.settings; delete st.updateCheckedAt; st.autoUpdate = true; window.imagefix.saveSettings(); sessionStorage.setItem('t_upd', 'available'); });
  await page.reload(); await page.waitForSelector('.home .tile', { timeout: 15000 });
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(300);
  await page.waitForTimeout(6500);
  check('a new version found while another sheet is open does not pop up over it', (await page.locator('.dialog').count()) === 0 && (await page.locator('.msheet h2 >> text=AI로 이미지 만들기').count()) === 1);
  await page.locator('.msheet [aria-label="닫기"]').last().click(); await page.waitForTimeout(250);
  await openSettings();

  // ---------------------------------------------------------------- 4) 자동 확인 끄기
  console.log('▶ 자동 확인 끄기');
  await page.locator('.msheet .switch >> nth=-1').click(); await page.waitForTimeout(150);
  check('the switch is saved (off)', (await page.evaluate(() => window.imagefix.settings.autoUpdate)) === false);
  await closeModal();
  await page.evaluate(() => { const s = window.imagefix.settings; delete s.updateCheckedAt; window.imagefix.saveSettings(); });
  await page.reload(); await page.waitForSelector('.home .tile', { timeout: 15000 });
  await page.waitForTimeout(6500);
  check('with the switch off nothing is checked at start', (await calls()) === '' && (await page.locator('.dialog').count()) === 0);

  const errs = h.errors.filter((e) => !/willReadFrequently|Multiple readback/.test(e));
  console.log('errors:', errs.join('\n') || 'none');
  if (errs.length) bad++;
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ update all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
