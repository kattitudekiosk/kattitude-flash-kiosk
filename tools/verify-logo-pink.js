/* tools/verify-logo-pink.js — one pink, the logo's.
 *
 * Joshua, 17 Oct 2026: "everything needs to use the logo's pink". The logo
 * (assets/brand/kattitude-logo-2026.svg) is drawn in exactly two colours:
 * #FC258D and #FFE448. This test holds the kiosk (wall + phone page) and the
 * dashboard to that.
 *
 *  1. STATIC. Every shipped CSS / JS / HTML / SVG file, comments stripped:
 *     any colour in the pink hue band (290°–352°) must be #FC258D, or an
 *     rgba() of 252,37,141, or one of the named light tints of it below.
 *     Reds (the dashboard's error colour, ~4°) are outside the band.
 *  2. RENDERED. Headless Chrome on the kiosk (cover, Artists, View All, the
 *     sheet viewer; 1080×1920 and 390×844) and the dashboard (sign-in, and
 *     signed in on Upload, against a stub — nothing reaches Supabase): every
 *     visible piece of text drawn IN the pink or ON the pink must reach
 *     4.5:1, or be large text (≥24px, or bold ≥18.66px) at 3:1. White on
 *     #FC258D is 3.63:1, so small white-on-pink text fails here.
 *     Kiosk sizes are measured on the 1080 canvas (the wall's real size).
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-logo-pink.js
 *   VERIFY_PINK_PLANT=1   negative control: plants #E91E8C in a copy of
 *                         styles.css (in memory); the static check must FAIL.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
setTimeout(() => { console.error('verify-logo-pink.js: timed out'); process.exit(2); }, 240000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const LOGO_PINK = [252, 37, 141];
// Light tints of the logo pink for light grounds (mixes with white).
const TINTS = new Set(['#ffe9f4', '#febedd']);

/* ── 1. Static ─────────────────────────────────────────────────────────── */
function hue([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { h: 0, s: 0, l: (mx + mn) / 2 };
  const l = (mx + mn) / 2, s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60; if (h < 0) h += 360;
  return { h, s, l };
}
function stripComments(src, ext) {
  let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (ext === '.html' || ext === '.svg') s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  if (ext === '.js' || ext === '.cjs' || ext === '.html') s = s.replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  return s;
}
const files = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).split('\n')
  .filter(f => /\.(css|js|cjs|html|svg)$/.test(f))
  .filter(f => !/^(tools|db|seed)\//.test(f) && !/^assets\/lib\//.test(f) && !/^\.claude\//.test(f));
const offenders = [];
for (const f of files) {
  const ext = path.extname(f);
  let src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (process.env.VERIFY_PINK_PLANT === '1' && f === 'styles.css') src += '\n.planted { color: #E91E8C; }\n';
  const s = stripComments(src, ext);
  const re = /#([0-9a-f]{6}|[0-9a-f]{3})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi;
  let m;
  while ((m = re.exec(s))) {
    let c;
    if (m[1]) { let h = m[1]; if (h.length === 3) h = h.replace(/./g, x => x + x); c = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); }
    else c = [+m[2], +m[3], +m[4]];
    const { h, s: sat, l } = hue(c);
    if (!(h >= 290 && h <= 352 && sat > 0.25 && l > 0.15 && l < 0.97)) continue;
    const isLogo = c.join() === LOGO_PINK.join();
    const isTint = m[1] && TINTS.has('#' + m[1].toLowerCase());
    if (!isLogo && !isTint) offenders.push(`${f}: ${m[0]}`);
  }
}
console.log('static: ' + files.length + ' shipped files');
check('every pink in shipped CSS/JS/HTML/SVG is the logo’s #FC258D (or a named tint of it)', offenders.length === 0, offenders.join('; '));
const logo = fs.readFileSync(path.join(ROOT, 'assets/brand/kattitude-logo-2026.svg'), 'utf8').toLowerCase();
check('the logo itself is #FC258D + #FFE448 (the reference this test enforces)', logo.includes('#fc258d') && logo.includes('#ffe448'));
const tokens = ['styles.css', 'dashboard/dashboard.css'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8'));
check('the pink tokens are #FC258D and the yellow tokens #FFE448',
  tokens.every(t => /--pink:\s*#FC258D/i.test(t) && /--yellow:\s*#FFE448/i.test(t)) && /--pink-card:\s*#FC258D/i.test(tokens[0]) && /--pink-deep:\s*#FC258D/i.test(tokens[1]));

if (process.env.VERIFY_PINK_PLANT === '1') {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

/* ── 2. Rendered ───────────────────────────────────────────────────────── */
const puppeteer = from('puppeteer-core');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const wait = ms => new Promise(r => setTimeout(r, ms));
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-pink-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });

/* In the page: every visible text node's colour and effective background;
 * report pairs that involve the logo pink and fall short. */
function audit(canvasScale) {
  const PINK = [252, 37, 141];
  const parse = c => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 }; };
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 3);
  const bgOf = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0.5) return c.rgb;
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && /gradient/.test(cs.backgroundImage)) {
        const m = cs.backgroundImage.match(/rgba?\([^)]+\)/); if (m) return parse(m[0]).rgb;
      }
    }
    return [255, 255, 255];
  };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || seen.has(el) || !n.textContent.trim()) continue;
    seen.add(el);
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || +cs.opacity === 0) continue;
    if (el.closest('[hidden]') || el.closest('svg')) continue;
    const fg = parse(cs.color); if (!fg || fg.a < 0.5) continue;
    const bg = bgOf(el);
    const pinkFg = near(fg.rgb, PINK), pinkBg = near(bg, PINK);
    if (!pinkFg && !pinkBg) continue;
    const px = parseFloat(cs.fontSize) / (canvasScale || 1) * (canvasScale ? canvasScale : 1);
    const size = parseFloat(cs.fontSize), bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const cr = ratio(fg.rgb, bg);
    if (cr < 4.5 && !(large && cr >= 3)) {
      out.push({ text: n.textContent.trim().slice(0, 30), sel: (el.id ? '#' + el.id : '') + '.' + String(el.className).split(' ').slice(0, 2).join('.'),
        fg: fg.rgb.join(','), bg: bg.join(','), ratio: +cr.toFixed(2), size, weight: cs.fontWeight });
    }
    void px;
  }
  return out;
}

async function kiosk(browser, W, H) {
  const p = await browser.newPage();
  await p.setViewport({ width: W, height: H });
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = new URL(req.url());
    if (u.host === 'kiosk.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    }
    if (req.method() !== 'GET' && req.method() !== 'OPTIONS') return req.abort();   // read-only
    req.continue();
  });
  await p.goto('http://kiosk.test/index.html', { waitUntil: 'networkidle2' });
  await wait(1500);
  await p.mouse.click(W / 2, H * 0.68);
  await wait(1200);
  const pages = [
    ['cover', async () => {}],
    ['artists', async () => { await p.evaluate(() => window.KIOSK_ROUTER.renderArtists()); }],
    ['view-all', async () => { await p.evaluate(() => { window.KIOSK_ROUTER.goHome(); document.querySelector('.g-mode-all').dispatchEvent(new Event('click', { bubbles: true })); }); }],
    ['sheet-viewer', async () => { await p.evaluate(() => { const t = document.querySelector('.g-tile-sheet'); if (t) t.dispatchEvent(new Event('click', { bubbles: true })); }); }],
  ];
  for (const [name, go] of pages) {
    if (name === 'cover') await p.evaluate(() => window.KIOSK_ROUTER.goHome());
    await go();
    await wait(1300);
    const bad = await p.evaluate(audit, W / 1080);
    check(`kiosk ${W}×${H} ${name}: all text in/on the logo pink is readable`, bad.length === 0, bad.map(b => `${b.sel} "${b.text}" ${b.size}px/${b.weight} ${b.ratio}:1`).join(' | '));
    await p.screenshot({ path: path.join(SHOTS, `kiosk-${W}-${name}.png`) });
  }
  await p.close();
}

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
async function dashboard(browser, W, H, signedIn) {
  const UID = '00000000-0000-4000-8000-0000000000aa';
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const JWT = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, role: 'authenticated', aud: 'authenticated', exp }) + '.c2ln';
  const ref = new URL(fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8').match(/supabaseUrl:\s*'([^']+)'/)[1]).hostname.split('.')[0];
  // A fresh profile per run: a sign-in left in localStorage must not leak
  // into the next page (the "sign-in" screen would be signed in).
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  await p.setViewport({ width: W, height: H });
  await p.setRequestInterception(true);
  p.on('request', req => {
    const u = new URL(req.url());
    if (u.host === 'dash.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.join(ROOT, rel.startsWith('assets/') ? rel : path.join('dashboard', rel));
      if (!fs.existsSync(f)) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    }
    if (!u.host.endsWith('.supabase.co')) return req.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    const json = o => req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(o) });
    if (u.pathname.startsWith('/auth/v1/token')) return json({ access_token: JWT, refresh_token: 'r2', token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: UID } });
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: UID, aud: 'authenticated', role: 'authenticated' });
    if (u.pathname.startsWith('/rest/v1/artists') && u.search.includes('auth_user_id')) {
      return json({ id: 'a-1', name: 'Test Artist', handle: '@test', role: 'admin', active: true, kiosk_visible: true, auth_user_id: UID,
        tutorial_seen: [], tutorial_snoozed: [], tutorial_seen_at: new Date().toISOString() });
    }
    if (u.pathname.startsWith('/rest/v1/categories')) return json([{ id: 'c1', name: 'Traditional', kind: 'style' }, { id: 'c2', name: 'Floral', kind: 'subject' }]);
    return json([]);
  });
  if (signedIn) {
    await p.evaluateOnNewDocument((ref, jwt, uid, exp) => {
      localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'r', token_type: 'bearer',
        expires_in: 3600, expires_at: exp, user: { id: uid, aud: 'authenticated', role: 'authenticated' } }));
    }, ref, JWT, UID, exp);
  }
  await p.goto('http://dash.test/index.html', { waitUntil: 'networkidle2' });
  await wait(1500);
  const name = signedIn ? 'upload' : 'signin';
  if (signedIn) {
    await p.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Skip'); if (b) b.click(); });
    await p.evaluate(() => { const t = document.querySelector('.tab[data-view="upload"]'); if (t) t.click(); });
    await wait(600);
    // Stage a real square file and tag it, so the applied chip, the
    // single/sheet toggle and the upload status are on screen to audit.
    const sq = path.join(os.tmpdir(), 'kt-pink-square.png');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '2048', '2048', path.join(ROOT, 'assets/brand/kattitude-logo-2026.png'), '--out', sq], { stdio: 'ignore' });
    const input = await p.$('#view-upload input[type="file"]');
    if (input) await input.uploadFile(sq);
    await p.waitForFunction(() => document.querySelectorAll('#queue .card.item').length > 0, { timeout: 15000 }).catch(() => {});
    await p.evaluate(() => {
      const chip = [...document.querySelectorAll('#queue .item .chip, #queue .item button')].find(b => /traditional/i.test(b.textContent));
      if (chip) chip.click();
      const t = document.querySelector('.tagtoggle'); if (t) t.click();
    });
    await wait(600);
    const shown = await p.evaluate(() => ({ chips: document.querySelectorAll('.chip-applied, .chip.is-on').length,
      toggle: !!document.querySelector('.type-opt.is-on'), status: !!document.querySelector('#uploadStatus:not([hidden])') }));
    check(`dashboard ${W}×${H}: the audit sees a staged file with an applied tag, the type toggle and the upload status`,
      shown.chips > 0 && shown.toggle && shown.status, JSON.stringify(shown));
  }
  const bad = await p.evaluate(audit, 0);
  check(`dashboard ${W}×${H} ${name}: all text in/on the logo pink is readable`, bad.length === 0, bad.map(b => `${b.sel} "${b.text}" ${b.size}px/${b.weight} ${b.ratio}:1`).join(' | '));
  await p.screenshot({ path: path.join(SHOTS, `dashboard-${W}-${name}.png`), fullPage: false });
  await ctx.close();
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
  try {
    for (const [W, H] of [[1080, 1920], [390, 844]]) {
      console.log(`\nkiosk ${W}×${H}`);
      await kiosk(browser, W, H);
    }
    for (const [W, H] of [[1280, 900], [390, 844]]) {
      console.log(`\ndashboard ${W}×${H}`);
      await dashboard(browser, W, H, false);
      await dashboard(browser, W, H, true);
    }
  } finally { await browser.close(); }
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
