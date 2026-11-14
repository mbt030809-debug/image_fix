// lucide-static(ISC 라이선스)에서 필요한 아이콘만 뽑아 src/icons.js 생성
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '../node_modules/lucide-static/icons');
const names = `crop rotate-cw rotate-ccw flip-horizontal flip-vertical sliders-horizontal sun sun-medium contrast palette droplets droplet
wand-sparkles sparkles sparkle type smile brush pen-line eraser undo-2 redo-2 eye eye-off download share-2 x check image camera layers frame
maximize-2 scan zoom-in zoom-out move circle square triangle star heart arrow-up-right minus plus trash-2 copy lock lock-open align-left align-center align-right
bold italic underline aperture focus grid-3x3 scissors bandage stamp pipette paint-bucket settings house folder-open info chevron-left chevron-right chevron-down
chevron-up ellipsis history ratio blend thermometer mountain cloud-fog waves spline hand scan-face layout-grid image-plus save layers-2 arrow-up arrow-down arrow-left
arrow-right crosshair target shapes sticker message-square pencil highlighter spray-can zap flame snowflake leaf swatch-book rainbow eclipse glasses wand
scan-line link unlink clipboard-paste upload scale ruler square-pen case-sensitive strikethrough refresh-cw languages moon sun-moon bookmark rotate-3d
flip-horizontal-2 expand shrink repeat panel-top columns-2 rows-2 circle-dashed square-dashed badge-check list-restart combine image-down file-image
move-diagonal-2 bring-to-front send-to-back copy-plus eye-closed hexagon pentagon octagon cloud triangle-right diamond ellipsis-vertical grip-vertical
layers-3 monitor-smartphone shield-check heart-handshake glass-water flashlight lightbulb notebook-pen text-cursor circle-user sticker pizza coffee
cat dog flower-2 music gift cake party-popper rocket crown gem skull ghost angry laugh frown meh annoyed`.split(/\s+/).filter(Boolean);
const out = {}; const missing = [];
for (const n of new Set(names)) {
  const f = path.join(dir, n + '.svg');
  if (!fs.existsSync(f)) { missing.push(n); continue; }
  const s = fs.readFileSync(f, 'utf8');
  const m = s.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
  out[n] = m[1].replace(/\s*\n\s*/g, '').trim();
}
const js = `// 자동 생성: tools/gen-icons.mjs (lucide-static, ISC License)\nexport const ICONS = ${JSON.stringify(out)};\n`;
fs.writeFileSync(path.join(here, '../src/icons.js'), js);
console.log('icons:', Object.keys(out).length, 'missing:', missing.join(' ') || '-');
