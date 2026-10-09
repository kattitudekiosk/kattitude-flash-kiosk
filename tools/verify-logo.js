/* tools/verify-logo.js — the 2026 studio logo is the one in use, everywhere.
 *
 * Joshua, 9 Oct 2026: "this is the new logo for the studio … please update
 * and add to the kiosk" (Kattitude Tattoo Studio Bold.pdf, Adobe Illustrator,
 * pure vector). No dependencies.
 *
 *   node tools/verify-logo.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pngSize = f => { const b = fs.readFileSync(path.join(ROOT, f)); return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
  .filter(f => /\.(html|js|css)$/.test(f) && !f.startsWith('tools/') && f !== 'dashboard/standalone.html');

console.log('the old logo is retired');
const oldRefs = tracked.filter(f => /kattitude-logo\.png/.test(read(f)));
check('no page, script or stylesheet uses the old kattitude-logo.png', oldRefs.length === 0, oldRefs.join(', '));
check('...and the old file is gone from the tree (it stays in git history)', !fs.existsSync(path.join(ROOT, 'assets/brand/kattitude-logo.png')));

console.log('\nthe new logo is used everywhere the old one was, and in the dashboard');
const where = {
  'kiosk splash': ['index.html', /class="splash-logo" src="assets\/brand\/kattitude-logo-2026\.svg"/],
  'sheet viewer header': ['index.html', /class="header-logo" src="assets\/brand\/kattitude-logo-2026\.svg"/],
  'gallery page headers': ['gallery.js', /logo\.src = 'assets\/brand\/kattitude-logo-2026\.svg'/],
  'dashboard header': ['dashboard/index.html', /class="brand-logo" src="\.\.\/assets\/brand\/kattitude-logo-2026\.svg"/],
  'dashboard sign-in card': ['dashboard/index.html', /class="signin-logo" src="\.\.\/assets\/brand\/kattitude-logo-2026\.svg"/],
};
for (const [label, [f, re]] of Object.entries(where)) check(label, re.test(read(f)), f);

console.log('\nevery logo or icon a page names exists');
const refs = [];
for (const f of tracked) {
  for (const m of read(f).matchAll(/(?:src|href)\s*=\s*["']([^"']*assets\/brand\/[^"']+)["']|logo\.src = '([^']+)'/g)) {
    const rel = (m[1] || m[2]).replace(/^\.\.\//, '');
    refs.push([f, rel]);
  }
}
const missing = refs.filter(([, rel]) => !fs.existsSync(path.join(ROOT, rel)));
check(`all ${refs.length} references resolve to a file`, refs.length >= 9 && missing.length === 0, missing.map(x => x.join(' → ')).join('; '));

console.log('\nthe artwork is the artwork');
const svg = read('assets/brand/kattitude-logo-2026.svg');
const fills = [...new Set([...svg.matchAll(/(?:fill|stroke)="(#[0-9a-fA-F]{6})"/g)].map(m => m[1].toLowerCase()))].sort();
check('the SVG is vector and uses exactly the logo\'s two colours (#fc258d pink, #ffe448 yellow)',
  !/<image\b/.test(svg) && fills.join() === '#fc258d,#ffe448', fills.join());
check('the SVG scales with CSS (viewBox, no fixed width/height)', /viewBox="0 0 [\d.]+ [\d.]+"/.test(svg) && !/<svg[^>]*\swidth="/.test(svg));
const vb = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/).map(Number);
check('trimmed to the artwork: about 2.35:1, not the 1:1 page', Math.abs(vb[1] / vb[2] - 2.35) < 0.05, (vb[1] / vb[2]).toFixed(3));
const [pw, ph] = pngSize('assets/brand/kattitude-logo-2026.png') || [];
check('high-res transparent PNG alongside it (2400px wide, same shape)', pw === 2400 && Math.abs(pw / ph - vb[1] / vb[2]) < 0.01, `${pw}×${ph}`);

console.log('\nicons');
for (const [f, n] of [['assets/brand/icon-32.png', 32], ['assets/brand/icon-192.png', 192], ['assets/brand/icon-512.png', 512], ['assets/brand/apple-touch-icon.png', 180]]) {
  const s = pngSize(f);
  check(`${f} is ${n}×${n}`, s && s[0] === n && s[1] === n, s && s.join('×'));
}
check('kiosk and dashboard both link a favicon and an apple-touch icon',
  /rel="icon"[^>]*icon-32\.png/.test(read('index.html')) && /rel="apple-touch-icon"/.test(read('index.html')) &&
  /rel="icon"[^>]*icon-32\.png/.test(read('dashboard/index.html')) && /rel="apple-touch-icon"/.test(read('dashboard/index.html')));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
