// 도구 레지스트리(상위/하위 목록) 무결성 + 규격 사진(여권) 가이드 계산. 실행: node web/tests/tools.unit.mjs
import { TOOLS, ACTIONS, GROUPS, TOOL_BY_ID, groupOf } from '../src/tools/index.js';
import { GUIDES, guideLayout } from '../src/tools/crop.js';
import { ICONS } from '../src/icons.js';

let pass = 0, fail = 0;
function ok(cond, name, extra = '') { if (cond) pass++; else { fail++; console.log('  ✗ FAIL:', name, extra); } }
function near(a, b, eps, name) { ok(Math.abs(a - b) <= eps, name, `(${a} vs ${b})`); }

console.log('▶ 상위/하위 목록');
{
  const ids = [...TOOLS, ...ACTIONS].map((x) => x.id);
  ok(new Set(ids).size === ids.length, 'ids are unique across tools and actions');
  ok(TOOLS.length === 17 && ACTIONS.length === 2, 'seventeen tools + two actions');
  const grouped = GROUPS.flatMap((g) => g.items);
  ok(new Set(grouped).size === grouped.length, 'no item sits in two groups');
  ok(ids.every((id) => grouped.includes(id)) && grouped.every((id) => ids.includes(id)), 'every tool/action belongs to exactly one group');
  ok(GROUPS.length === 6 && GROUPS.length < TOOLS.length / 2, 'six top-level groups (was sixteen tools in one strip)');
  const expect = { canvas: ['crop', 'resize', 'frame'], tune: ['adjust', 'color', 'curves', 'filter', 'effects'], refine: ['retouch', 'brush', 'cutout', 'body'], decor: ['text', 'sticker', 'draw'], aitools: ['ai', 'aigen', 'aiset'], layers: ['layers'] };
  ok(GROUPS.map((g) => g.id).join() === 'canvas,tune,refine,decor,aitools,layers', 'group order: canvas, tune, refine, decor, AI tools, layers');
  for (const g of GROUPS) ok(JSON.stringify(g.items) === JSON.stringify(expect[g.id]), `${g.id} → ${expect[g.id].join(', ')}`, JSON.stringify(g.items));
  ok(GROUPS.filter((g) => !g.direct).every((g) => g.items.length >= 2 && g.items.length <= 5), 'sub-lists have 2–5 items (fit one row without scrolling)');
  ok(GROUPS.filter((g) => g.direct).every((g) => g.items.length === 1 && TOOL_BY_ID[g.items[0]].open), 'a direct group is a single real tool (layers)');
  ok(GROUPS.every((g) => g.items.every((id) => TOOL_BY_ID[id])), 'every group item resolves');
  ok(TOOLS.every((x) => typeof x.open === 'function') && ACTIONS.every((x) => typeof x.run === 'function' && !x.open), 'tools open panels; actions run');
  ok(groupOf('crop') === 'canvas' && groupOf('frame') === 'canvas' && groupOf('cutout') === 'refine' && groupOf('aigen') === 'aitools' && groupOf('layers') === 'layers' && groupOf('nope') === null, 'groupOf');
  const labels = [...GROUPS, ...TOOLS, ...ACTIONS].map((x) => x.label());
  ok(labels.every((l) => typeof l === 'string' && l.length > 0 && l.length <= 8), 'labels are short non-empty strings (fit the bar)', labels.join('|'));
  ok(GROUPS.map((g) => g.label()).join() === '캔버스,보정,다듬기,꾸미기,AI 도구,레이어', 'Korean group names as approved');
  ok(GROUPS.every((g) => g.label().length <= 8), 'group labels ≤ 8 characters (six per row at 320px)');
  ok(TOOL_BY_ID.ai.label() === '영역 수정' && TOOL_BY_ID.ai.title() === 'AI 영역 수정', 'AI tool: short label in the sub-list, full title on the panel');
  const icons = [...GROUPS, ...TOOLS, ...ACTIONS].map((x) => x.icon);
  ok(icons.every((i) => ICONS[i]), 'all icons exist', icons.filter((i) => !ICONS[i]).join());
  ok(new Set(GROUPS.map((g) => g.icon)).size === GROUPS.length, 'group icons are distinct');
}

console.log('▶ 여권 사진 가이드');
{
  const G = GUIDES.passport;
  ok(G && G.wmm === 35 && G.hmm === 45 && G.faceMin === 32 && G.faceMax === 36, 'passport: 35×45 mm, face 32–36 mm');
  near(G.faceMin / G.hmm, 0.711, 0.001, 'min face = 71% of the height');
  near(G.faceMax / G.hmm, 0.800, 0.001, 'max face = 80% of the height');
  const L = guideLayout(G, 100, 50, 450, 500); // 350 × 450 (= 35×45 mm × 10)
  near(L.w, 350, 1e-9, 'frame width'); near(L.h, 450, 1e-9, 'frame height'); near(L.cx, 275, 1e-9, 'center x');
  near(L.yTop, 50 + 30, 1e-9, 'crown line at 3 mm');
  near(L.yMin, 50 + 350, 1e-9, 'chin band starts at crown + 32 mm');
  near(L.yMax, 50 + 390, 1e-9, 'chin band ends at crown + 36 mm');
  near(L.yMin - L.yTop, 320, 1e-9, 'min face length 32 mm → 320 px'); near(L.yMax - L.yTop, 360, 1e-9, 'max face length 36 mm → 360 px');
  ok(L.yTop > L.y0 && L.yMax < L.y1 && L.yTop < L.yMin && L.yMin < L.yMax, 'ordered inside the frame');
  ok(L.ell.cy - L.ell.ry === L.yTop && L.ell.rx < L.w / 2 && L.ell.ry > 0, 'face oval starts at the crown line and fits the frame width');
  const L2 = guideLayout(G, 0, 0, 175, 225); // 절반 크기여도 같은 비율
  near((L2.yMin - L2.y0) / L2.h, (L.yMin - L.y0) / L.h, 1e-12, 'chin band start keeps its relative position when the frame scales');
  near((L2.yTop - L2.y0) / L2.h, 3 / 45, 1e-12, 'crown line is 3/45 of the height at any size');
  near((L2.yMax - L2.yTop) / L2.h, 36 / 45, 1e-9, 'max face length is 80% of the frame height at any size');
  ok(typeof G.short() === 'string' && /초록 띠/.test(G.short()) && /3\.2~3\.6cm/.test(G.long()) && /71~80%/.test(G.long()), 'notes mention the band and the official numbers');
}

console.log(`\nTools unit tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
