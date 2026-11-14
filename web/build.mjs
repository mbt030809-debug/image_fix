// 웹 번들 빌드: src → ../app/src/main/assets/www  (esbuild)
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../app/src/main/assets/www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const minify = !process.env.NO_MINIFY;
const common = { bundle: true, minify, target: ['chrome90'], legalComments: 'none', logLevel: 'warning', charset: 'utf8' };

await build({ ...common, entryPoints: [path.join(here, 'src/main.js')], outfile: path.join(out, 'app.js'), format: 'iife' });
await build({ ...common, entryPoints: [path.join(here, 'src/engine/worker.js')], outfile: path.join(out, 'worker.js'), format: 'iife' });
await build({ ...common, entryPoints: [path.join(here, 'css/app.css')], outfile: path.join(out, 'app.css'), loader: { '.woff2': 'file' } });

// 정적 파일 (index.html, fonts, 아이콘 등)
function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
copyDir(path.join(here, 'public'), out);

let total = 0;
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else total += fs.statSync(p).size; } })(out);
console.log(`[web] ${(total / 1024).toFixed(0)} KB → ${path.relative(process.cwd(), out)}`);
