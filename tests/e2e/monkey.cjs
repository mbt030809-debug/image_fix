// 무작위 조작 테스트: 도구/컨트롤/제스처를 랜덤하게 눌러 예외·멈춤을 찾는다. 사용: node monkey.cjs <seed> <steps> [fixture]
const path = require('path');
const { launch, close, openPhoto } = require('./lib.cjs');
const FIX = path.resolve(__dirname, '../fixtures');
const seed = parseInt(process.argv[2] || '1', 10);
const steps = parseInt(process.argv[3] || '120', 10);
const fixture = process.argv[4] || 'landscape.jpg';
let s = seed * 7919 + 13;
const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const SKIP = /LUT|사진 추가|사진 교체|사진에서 색|스포이트|직접 선택|Import|Add photo|Replace|Pick color|Eyedropper|공유|Share/;

(async () => {
  const h = await launch({ w: 412, h: 915, dpr: 1.5 });
  const { page } = h;
  await openPhoto(page, path.join(FIX, fixture));
  const log = [];
  for (let i = 0; i < steps; i++) {
    let desc = '';
    try {
      if (await page.locator('.scrim').count()) { await page.evaluate(() => window.__onBack && window.__onBack()); await page.waitForTimeout(80); }
      const r = rnd();
      const stage = await page.locator('.screen:not([hidden]) .stage').first().boundingBox();
      if (r < 0.14) {
        // 하단 줄 = 상위 목록(분류): 분류를 누르고, 80% 는 하위 목록의 도구까지 누른다
        const gid = pick(await page.$$eval('.strip [data-group]', (els) => els.map((e) => e.dataset.group)));
        desc = 'tool group ' + gid;
        await page.click('.strip [data-group=' + gid + ']', { timeout: 12000 }); // 필터 썸네일 등 무거운 작업 직후에는 메인 스레드가 잠깐 막힌다
        if (gid !== 'layers' && rnd() < 0.8) {
          const subs = await page.$$eval('.subrow:not([hidden]) [data-tool]', (els) => els.map((e) => e.dataset.tool));
          if (subs.length) { const id = pick(subs); desc += ' > ' + id; await page.click('.subrow [data-tool=' + id + ']', { timeout: 12000 }); }
        }
      } else if (r < 0.17) {
        // 패널 손잡이를 잡고 위/아래로 끌기(높이 조절)
        const gb = await page.locator('.editor.ed .sheet:not([hidden]) .sheet-grab').first().boundingBox().catch(() => null);
        if (gb) {
          desc = 'sheet drag';
          const x = gb.x + gb.width / 2, y = gb.y + gb.height / 2, dy = (rnd() - 0.5) * 420;
          await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x, y + dy / 2, { steps: 3 }); await page.mouse.move(x, y + dy, { steps: 3 }); await page.mouse.up();
        }
      } else if (r < 0.55) {
        const btns = await page.$$('.sheet:not([hidden]) button:visible, .sheet:not([hidden]) .chip:visible, .sheet:not([hidden]) .thumb:visible, .sheet:not([hidden]) .gbtn:visible');
        if (btns.length) {
          const b = pick(btns);
          const txt = ((await b.textContent()) || '') + ((await b.getAttribute('aria-label')) || '');
          if (!SKIP.test(txt) && !/완료|Done|적용|Apply/.test(txt)) { desc = 'click ' + txt.trim().slice(0, 14); await b.click({ timeout: 2000, force: true }); }
        }
      } else if (r < 0.72) {
        const n = await page.locator('.sheet:not([hidden]) .slider').count();
        if (n) {
          const k = Math.floor(rnd() * n);
          const v = rnd();
          desc = 'slider ' + k;
          await page.evaluate(([k, v]) => {
            const el = document.querySelectorAll('.sheet:not([hidden]) .slider')[k];
            if (!el) return;
            el.value = +el.min + v * (+el.max - +el.min);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }, [k, v]);
        }
      } else if (r < 0.88 && stage) {
        desc = 'drag';
        const x0 = stage.x + stage.width * (0.15 + rnd() * 0.7);
        const y0 = stage.y + stage.height * (0.15 + rnd() * 0.7);
        await page.mouse.move(x0, y0);
        await page.mouse.down();
        for (let k = 0; k < 4; k++) await page.mouse.move(x0 + (rnd() - 0.5) * 160, y0 + (rnd() - 0.5) * 160, { steps: 2 });
        await page.mouse.up();
      } else if (r < 0.94) {
        desc = 'undo/redo';
        await page.click(rnd() < 0.6 ? '[aria-label="실행 취소"]' : '[aria-label="다시 실행"]', { timeout: 2000, force: true });
      } else if (r < 0.97) {
        desc = 'zoomchip';
        await page.click('.zoomchip', { timeout: 2000 });
      } else {
        desc = 'export';
        await page.click('.topbar .btn.filled', { timeout: 2000 });
        await page.waitForTimeout(120);
        await page.evaluate(() => window.__onBack && window.__onBack());
      }
      log.push(desc);
      await page.waitForTimeout(40);
      if (i % 10 === 9) await page.waitForFunction(() => !window.imagefix.editor.busy, null, { timeout: 40000 });
    } catch (e) { log.push('ERR [' + desc + '] ' + String(e.message).split('\n')[0].slice(0, 80)); if (process.env.MONKEY_DEBUG) { console.log('--- ERR [' + desc + ']\n' + e.message.slice(0, 900)); console.log('    state:', JSON.stringify(await page.evaluate(() => { const ed = window.imagefix.editor, st = document.querySelector('.editor.ed .strip'); const b = st.getBoundingClientRect(); return { screen: window.imagefix.screen, scrim: document.querySelectorAll('.scrim').length, toolId: ed.toolId, group: ed.groupId, stripRect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], vh: innerHeight, hiddenEd: ed.el.hidden, sheetSized: ed.sheetEl.className }; }).catch((x) => String(x)))); console.log('    frames:', JSON.stringify(await page.evaluate(() => new Promise((res) => { const out = []; let n = 0; const f = () => { const r = document.querySelector('.strip [data-group=tune]').getBoundingClientRect(); const e = document.querySelector('.editor.ed'); out.push([Math.round(r.left * 10) / 10, Math.round(r.top * 10) / 10, Math.round(r.width * 10) / 10, e.scrollTop, document.scrollingElement.scrollTop, document.querySelector('#app').scrollTop]); if (++n < 8) requestAnimationFrame(f); else res(out); }; requestAnimationFrame(f); })))); } }
  }
  await page.waitForFunction(() => !window.imagefix.editor.busy, null, { timeout: 60000 });
  console.log('seed ' + seed + ': steps=' + steps + ' tools=' + log.filter((l) => l.startsWith('tool')).length + ' drags=' + log.filter((l) => l.startsWith('sheet')).length + ' errors=' + h.errors.length);
  const soft = log.filter((l) => l.startsWith('ERR'));
  if (soft.length) console.log('  soft failures (test-side):', soft.length, soft.slice(0, 5).join(' | '));
  if (h.errors.length) console.log(h.errors.slice(0, 15).join('\n'));
  console.log('  state:', JSON.stringify(await page.evaluate(() => {
    const d = window.imagefix.editor.doc();
    return { fx: d.fx.length, locals: d.locals.length, layers: d.layers.length, retouch: d.retouch.length, frame: !!d.frame, geo: d.geo.crop.map((v) => +v.toFixed(2)) };
  })));
  await h.shot('monkey_' + seed);
  await close(h);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
