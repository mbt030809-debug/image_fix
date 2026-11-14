// @fontsource(SIL OFL 1.1) 에서 텍스트 도구용 폰트만 골라 web/public/fonts 로 복사하고 fonts.css 생성
// (woff2 만, 라틴/한글 서브셋만; 한글 폰트는 unicode-range 로 필요한 조각만 로드)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const nm = path.join(here, '../node_modules/@fontsource');
const out = path.join(here, '../public/fonts');
const FONTS = [
  ['black-han-sans', 'Black Han Sans'], ['jua', 'Jua'], ['nanum-pen-script', 'Nanum Pen Script'],
  ['pacifico', 'Pacifico'], ['bebas-neue', 'Bebas Neue'], ['dancing-script', 'Dancing Script'],
  ['permanent-marker', 'Permanent Marker'], ['playfair-display', 'Playfair Display'],
];
const SKIP = /cyrillic|vietnamese|greek|hebrew|arabic|thai|devanagari|math|symbols/;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
let css = '/* 자동 생성: tools/gen-fonts.mjs — @fontsource (SIL OFL 1.1) */\n';
let total = 0;
for (const [pkg, family] of FONTS) {
  const dir = path.join(nm, pkg), dst = path.join(out, pkg);
  if (!fs.existsSync(dir)) { console.warn('missing', pkg); continue; }
  fs.mkdirSync(dst, { recursive: true });
  const src = fs.readFileSync(path.join(dir, '400.css'), 'utf8');
  const blocks = src.match(/@font-face\s*{[^}]*}/g) || [];
  let n = 0;
  for (const b of blocks) {
    const m = b.match(/url\(\.\/files\/([^)]+?\.woff2)\)/);
    if (!m || SKIP.test(m[1]) || /italic/.test(b)) continue;
    const file = m[1];
    fs.copyFileSync(path.join(dir, 'files', file), path.join(dst, file));
    total += fs.statSync(path.join(dst, file)).size;
    const ur = (b.match(/unicode-range:[^;]+;/) || [''])[0];
    css += `@font-face{font-family:'${family}';font-style:normal;font-weight:400;font-display:swap;src:url(./${pkg}/${file}) format('woff2');${ur}}\n`;
    n++;
  }
  const lic = path.join(dir, 'LICENSE');
  if (fs.existsSync(lic)) fs.copyFileSync(lic, path.join(dst, 'LICENSE'));
  console.log(`${family}: ${n} files`);
}
fs.writeFileSync(path.join(out, 'fonts.css'), css);
console.log(`fonts total ${(total / 1048576).toFixed(1)} MB`);
