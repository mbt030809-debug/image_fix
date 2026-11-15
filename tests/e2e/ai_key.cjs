// API 키 입력 흐름 E2E (실기기 제보: "API 입력하면 오류남, 키가 사라짐")
//  - 원인 1: 설정(모달) 위에서 토스트가 시트 뒤에 가려져 오류 안내가 보이지 않았다 → 이제 모달 위 + 입력 아래 고정 안내
//  - 입력 정리(Bearer/따옴표/주소째 붙인 계정 ID), 바뀐 칸 안내, 저장 실패(원인 표시)·대체 저장소·읽을 수 없는 키·보관 기능 점검
//  - 제공자: Cloudflare(계정 ID + 토큰) · ModelScope(토큰) · Pollinations(키 없음)
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
  await page.reload();
  h.errors.length = 0;
  await page.waitForSelector('.home .tile', { timeout: 15000 });

  const ACC = '0123456789abcdef0123456789abcdef';
  const M = () => page.locator('.msheet').last();
  const keyField = () => M().locator('input[type=password]');
  const acctField = () => M().locator('input[name=imagefix-ai-account]');
  const saveBtn = () => M().locator('.btn', { hasText: /키 저장|저장 \/ 바꾸기/ });
  // 입력 아래 안내(문제 해결 블록 안의 점검 결과는 제외)
  const msgs = () => M().evaluate((el) => [...el.querySelectorAll('.ai-keymsg')].filter((e) => !e.closest('details')).map((e) => e.textContent));
  const calls = () => page.evaluate(() => window.__ai.setKeyCalls.length);
  const lastCall = () => page.evaluate(() => window.__ai.setKeyCalls.at(-1));
  const kv = async () => (await M().locator('.kv b').textContent()).trim();
  const press = async () => { await saveBtn().click(); await page.waitForTimeout(180); };
  /** 토스트가 실제로 눈에 보이나: 토스트 한가운데를 눌렀을 때 맨 위 요소가 토스트인가 */
  const toastInfo = () => page.evaluate(() => {
    const s = document.querySelector('.snackbar');
    if (!s) return null;
    const b = s.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return { text: s.textContent, onTop: !!(top && top.closest && top.closest('.snackbar')), cls: s.className, y: Math.round(b.top), inView: b.top >= 0 && b.bottom <= innerHeight };
  });

  // 설정 열기: 홈 → "AI로 이미지 만들기" → Cloudflare 탭 → 키 설정
  await page.click('.home .tile >> text=AI로 이미지 만들기'); await page.waitForTimeout(250);
  await page.click('.msheet .chip[data-id=cloudflare]'); await page.waitForTimeout(150);
  await page.click('.msheet .ai-setup .btn'); await page.waitForTimeout(300);
  check('AI settings opens on Cloudflare (account ID + token)', (await acctField().count()) === 1 && (await keyField().count()) === 1);
  // 제공자별 칸: Pollinations 는 키 없음 / ModelScope 는 토큰만
  await M().locator('.chip[data-id=pollinations]').click(); await page.waitForTimeout(120);
  check('Pollinations needs no key: no key field, no troubleshooting block, no connection test', (await kv()) === '필요 없음' && (await keyField().count()) === 0 && (await acctField().count()) === 0 && (await M().locator('details.ai-adv').count()) === 0 && (await M().locator('.btn', { hasText: '연결 테스트' }).count()) === 0);
  await M().locator('.chip[data-id=modelscope]').click(); await page.waitForTimeout(120);
  check('ModelScope asks for the token only', (await keyField().count()) === 1 && (await acctField().count()) === 0 && (await keyField().getAttribute('placeholder')) === 'ModelScope 액세스 토큰');
  await M().locator('.chip[data-id=cloudflare]').click(); await page.waitForTimeout(120);
  check('back on Cloudflare: account ID + token again', (await acctField().count()) === 1 && (await keyField().count()) === 1);

  // ---------------------------------------------------------------- 1) 오류 안내가 눈에 보인다
  console.log('▶ 오류 안내가 보인다(토스트 + 입력 아래 고정 안내)');
  let c0 = await calls();
  await press();
  let ti = await toastInfo();
  check('toast is on top of the modal (was hidden behind the sheet)', ti && ti.onTop && ti.inView, JSON.stringify(ti));
  check('toast is placed at the top while a modal is open (does not cover the buttons)', ti && /\btop\b/.test(ti.cls) && ti.y < 120);
  let m = await msgs();
  check('inline message under the key field says what is missing', m.length === 1 && /계정 ID와 API 토큰을 모두 입력/.test(m[0]), JSON.stringify(m));
  check('nothing reached native', (await calls()) === c0);
  const role = await M().locator('.ai-keymsg').first().getAttribute('role');
  check('inline error has role=alert', role === 'alert');
  await h.shot('k1_inline_error');

  // 토큰만 입력 → 계정 ID 없음 / 입력한 키는 그대로
  await keyField().fill('cf-token-abcdef123456');
  await press();
  m = await msgs();
  check('token only → asks for the account ID (not a vague error)', m.length === 1 && /계정 ID를 입력해 주세요/.test(m[0]), JSON.stringify(m));
  check('the typed token is NOT cleared by the error', (await keyField().inputValue()) === 'cf-token-abcdef123456');
  check('still nothing saved', (await kv()) === '없음' && (await calls()) === c0);

  // 칸이 바뀐 경우
  await acctField().fill('cf-token-abcdef123456');
  await keyField().fill(ACC);
  await press();
  m = await msgs();
  check('swapped fields are detected', m.length === 1 && /바뀐 것 같아요/.test(m[0]), JSON.stringify(m));
  check('swapped: nothing reaches native, typed values kept', (await calls()) === c0 && (await keyField().inputValue()) === ACC);
  await acctField().fill('1234');
  await keyField().fill('cf-token-abcdef123456');
  await press();
  m = await msgs();
  check('malformed account ID → format message', m.length === 1 && /계정 ID 형식이 올바르지 않아요/.test(m[0]), JSON.stringify(m));

  // ---------------------------------------------------------------- 2) 붙여넣기 정리
  console.log('▶ 붙여넣기 정리 (Bearer · 주소째 붙인 계정 ID)');
  await acctField().fill('https://dash.cloudflare.com/' + ACC.toUpperCase() + '/workers/overview');
  await keyField().fill('  Authorization: Bearer "cf-token-abcdef123456"  \n');
  await press();
  check('saved natively with the cleaned token and the 32-character account ID', JSON.stringify(await lastCall()) === JSON.stringify(['cloudflare', 'key', ACC]), JSON.stringify(await lastCall()));
  check('hint is shown, the field was emptied', (await kv()).includes('3456') && (await keyField().inputValue()) === '');
  m = await msgs();
  check('inline success message', m.length === 1 && /키를 안전하게 저장했어요/.test(m[0]) && (await M().locator('.ai-keymsg.ok').count()) === 1, JSON.stringify(m));
  ti = await toastInfo();
  check('success toast is visible too', ti && ti.onTop && /저장했어요/.test(ti.text), JSON.stringify(ti));
  check('the account ID field shows the cleaned 32 characters', (await acctField().inputValue()) === ACC);
  await h.shot('k2_saved_inline');

  // ---------------------------------------------------------------- 3) 네이티브 저장 실패: 원인을 보여 준다
  console.log('▶ 저장 실패(Keystore): 원인 표시 · 입력 유지');
  await M().locator('.chip[data-id=modelscope]').click(); await page.waitForTimeout(150);
  await page.evaluate(() => { window.__ai.keyMode = 'store'; });
  await keyField().fill('ms-abcdef123456');
  await press();
  m = await msgs();
  check('store failure shows the reason and where to look', m.length === 1 && /기기에 안전하게 저장하지 못했어요/.test(m[0]) && /KeyStoreException/.test(m[0]) && /문제 해결/.test(m[0]), JSON.stringify(m));
  check('the typed key stays so the user can retry', (await keyField().inputValue()) === 'ms-abcdef123456' && (await kv()) === '없음');
  await h.shot('k3_store_failed');

  // 문제 해결: 보관 기능 점검
  console.log('▶ 문제 해결: 보관 기능 점검');
  const det = M().locator('details.ai-adv', { hasText: '문제 해결' });
  check('troubleshooting section exists (collapsed)', (await det.count()) === 1 && !(await det.evaluate((d) => d.open)));
  await det.locator('summary').click(); await page.waitForTimeout(100);
  await page.evaluate(() => { window.__ai.selfTest = 'hw=KeyStoreException sw=ok'; });
  await det.locator('.btn', { hasText: '보관 기능 점검' }).click(); await page.waitForTimeout(150);
  let tm = (await det.locator('.ai-keymsg').allTextContents()).join('|');
  check('check names the failing tier and the working one', /Keystore\): 오류 \(KeyStoreException\)/.test(tm) && /앱 전용 저장소: 정상/.test(tm) && (await det.locator('.ai-keymsg.ok').count()) === 1, tm);
  await page.evaluate(() => { window.__ai.selfTest = 'hw=KeyStoreException hw2=ok sw=ok'; });
  await det.locator('.btn', { hasText: '보관 기능 점검' }).click(); await page.waitForTimeout(150);
  tm = (await det.locator('.ai-keymsg').allTextContents()).join('|');
  check('second Keystore alias result is shown', /보조 키: 정상/.test(tm) && (await det.locator('.ai-keymsg.ok').count()) === 1, tm);
  await page.evaluate(() => { window.__ai.selfTest = 'hw=KeyStoreException sw=IOException'; });
  await det.locator('.btn', { hasText: '보관 기능 점검' }).click(); await page.waitForTimeout(150);
  tm = (await det.locator('.ai-keymsg').allTextContents()).join('|');
  check('both failing → error + asks to report the result', (await det.locator('.ai-keymsg.err').count()) === 1 && /이 결과를 알려 주세요/.test(tm) && /IOException/.test(tm), tm);
  await h.shot('k4_troubleshoot');

  // ---------------------------------------------------------------- 4) 대체 저장소 / 읽을 수 없는 키
  console.log('▶ 대체 저장소(sw) · 읽을 수 없는 키');
  await page.evaluate(() => { window.__ai.keyMode = 'sw'; });
  await press();
  check('with the fallback storage the save succeeds', (await kv()).includes('3456') && /키를 안전하게 저장했어요/.test((await msgs())[0]));
  check('the fallback is disclosed (lower protection)', /앱 전용 저장소에 암호화해 보관/.test(await M().textContent()));
  await page.evaluate(() => { window.__ai.keyMode = 'unreadable'; });
  await keyField().fill('ms-zzzzzz987654');
  await press();
  m = await msgs();
  check('saved-but-unreadable is reported (never "saved")', m.some((x) => /저장했지만 다시 읽지 못했어요/.test(x)) && m.some((x) => /저장된 키를 읽을 수 없어요/.test(x)), JSON.stringify(m));
  check('key row says it is unreadable', (await kv()) === '읽을 수 없음');
  await page.evaluate(() => { window.__ai.keyMode = 'ok'; });
  await keyField().fill('ms-yyyyyy123456');
  await press();
  m = await msgs();
  check('re-entering the key recovers', (await kv()).includes('3456') && m.length === 1 && /안전하게 저장했어요/.test(m[0]), JSON.stringify(m));

  // 닫았다가 다시 열어도 저장된 상태가 보인다
  await M().locator('[aria-label="닫기"]').click(); await page.waitForTimeout(250);
  await page.waitForFunction(() => !!window.__ai.prov.modelscope.key);
  check('the saved keys survive closing the settings (each provider has its own slot; Pollinations has none)', await page.evaluate(() => !!window.__ai.prov.modelscope.key && !!window.__ai.prov.cloudflare.key && !window.__ai.prov.pollinations.key));
  check('no console errors', h.errors.length === 0, h.errors.slice(0, 3).join(' | '));
  await close(h);
  console.log(bad ? `\n✗ ${bad} check(s) failed` : '\n✓ ai_key all passed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
