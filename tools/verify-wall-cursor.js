/* tools/verify-wall-cursor.js — no pointer on the wall; normal pointers elsewhere.
 *
 * Joshua, 13 Oct 2026: "how can we hide the pointer when the kiosk is open?
 * I don't want to see an arrow or a hand when the kiosk is open."
 *
 * The wall Mac reports a fine, hovering pointer (Touch Up drives the system
 * mouse; a trackpad is paired), so the old capability query showed the cursor
 * on the wall itself. Now the studio server marks the page `kiosk-wall` on
 * localhost only. This boots THIS repo's studio server on a spare port with a
 * throwaway data folder (no Supabase sync), opens it in headless Chrome with
 * a fine pointer, and reads the computed cursor of every element:
 *
 *   wall    http://127.0.0.1:<port>/     every element `none` — on the splash,
 *           after taps, in the grid, the lightbox, the screensaver, and after
 *           a tap wakes it
 *   tunnel  the same server under another hostname   normal cursors
 *   public  the repo files as Vercel serves them (no injection)   normal cursors
 *
 *   PUPPETEER_PATH=<dir>/node_modules node tools/verify-wall-cursor.js
 *   VERIFY_WALL_CURSOR_SABOTAGE=1   (negative control: drops the class; must fail)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-cursor-'));
process.env.KT_DATA_DIR = DATA;
process.env.KT_MEDIA_DIR = path.join(DATA, 'media');
// The screensaver asks the server to sync; point that at nothing, so the test
// never talks to Supabase (a failed sync changes nothing, by design).
process.env.KT_SUPABASE_URL = 'http://127.0.0.1:9';
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.env.PUPPETEER_PATH || ROOT] }));
const db = require('../server/db');
const storage = require('../server/storage');
const { makeServer } = require('../server/server');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
setTimeout(() => { console.error('verify-wall-cursor.js: timed out'); process.exit(2); }, 90000).unref();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

/* Every element's computed cursor, grouped: { none: n, pointer: n, ... } plus
 * a sample of the offenders. Pseudo-elements too: a ::before can carry one. */
const census = () => {
  const out = { counts: {}, bad: [] };
  for (const e of document.querySelectorAll('*')) {
    for (const pseudo of [null, '::before', '::after']) {
      const c = getComputedStyle(e, pseudo).cursor;
      out.counts[c] = (out.counts[c] || 0) + 1;
      if (c !== 'none' && out.bad.length < 5) out.bad.push(`${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}${pseudo || ''}=${c}`);
    }
  }
  out.total = Object.values(out.counts).reduce((a, b) => a + b, 0);
  out.wall = document.documentElement.classList.contains('kiosk-wall');
  return out;
};
/* What the pointer is over right now, and its cursor. */
const under = (x, y) => { const e = document.elementFromPoint(x, y);
  return e ? { el: `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 30)}`, cursor: getComputedStyle(e).cursor } : null; };

(async () => {
  const conn = db.open(path.join(DATA, 'kattitude.db'));
  storage.init(DATA, { artistName: id => (db.getByKey(conn, 'artists', [id]) || {}).name });
  // Something to browse: one artist on the wall, two of the studio's sheets.
  const art = db.insertRow(conn, 'artists', { name: 'Test Artist', display_order: 1, active: true, kiosk_visible: true });
  for (const f of ['IMG_1705.JPEG', 'Untitled_Artwork.jpg'])
    db.insertRow(conn, 'designs', { artist_id: art.id, image_url: '/assets/sheets/2160/' + f, type: 'sheet', published: true });
  const server = makeServer(conn);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kt-cursor-chrome-')),
    args: [`--host-resolver-rules=MAP studio-tunnel.test 127.0.0.1`],
  });
  const open = async (url, { compressIdle = false, raw = false } = {}) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1080, height: 1920 });
    // Desktop Chrome reports a fine, hovering pointer, as the wall Mac does
    // (Touch Up + a paired trackpad); checked below rather than assumed.
    if (compressIdle) await p.evaluateOnNewDocument(() => {
      const st = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...a) => st(fn, ms >= 60000 && window.__ktFastIdle ? 1500 : ms, ...a);
    });
    if (process.env.VERIFY_WALL_CURSOR_SABOTAGE === '1' && new URL(url).hostname === '127.0.0.1') {
      // Negative control: the override without the line that marks the wall.
      await p.setRequestInterception(true);
      p.on('request', async req => {
        if (!req.url().endsWith('/studio-server.js')) return req.continue();
        const js = await (await fetch(req.url())).text();
        req.respond({ status: 200, contentType: 'text/javascript',
          body: js.replace(/document\.documentElement\.classList\.add\('kiosk-wall'\)/, 'void 0') });
      });
    }
    if (raw) {
      await p.setRequestInterception(true);
      p.on('request', req => {
        const u = new URL(req.url());
        if (u.host !== 'public.test') return req.continue();
        const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
        const f = path.join(ROOT, rel);
        if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return req.respond({ status: 404, body: '' });
        req.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
      });
    }
    await p.goto(url, { waitUntil: 'networkidle2' });
    await wait(1200);
    return p;
  };
  const allNone = (c) => c.total > 50 && Object.keys(c.counts).join() === 'none';

  console.log(`wall — http://127.0.0.1:${PORT}/ (the studio server, as the kiosk Chrome loads it)`);
  const wall = await open(`http://127.0.0.1:${PORT}/`, { compressIdle: true });
  const pointerMatches = await wall.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches);
  check('this browser reports a fine hovering pointer, like the wall Mac (else the test proves nothing)', pointerMatches);
  let c = await wall.evaluate(census);
  check('the page is marked as the wall', c.wall);
  check(`splash: every element and pseudo-element has cursor none (${c.total})`, allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  await wall.mouse.move(540, 1300);
  check('splash: the pointer sits over a none cursor', (await wall.evaluate(under, 540, 1300)).cursor === 'none');

  await wall.mouse.click(540, 1300); await wait(1200);              // a Touch Up tap: mouse down/up
  c = await wall.evaluate(census);
  check(`cover after a tap: all cursor none (${c.total})`, allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  const tiles = await wall.evaluate(() => [...document.querySelectorAll('.g-mode, button, a')].filter(e => e.getBoundingClientRect().width > 0).length);
  check(`...including the ${tiles} visible buttons, links and cover tiles`, tiles > 0 && allNone(c));

  await wall.evaluate(() => document.querySelector('.g-mode-all').dispatchEvent(new Event('click', { bubbles: true }))); await wait(1200);
  c = await wall.evaluate(census);
  check(`All Flash grid: all cursor none (${c.total})`, allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  await wall.evaluate(() => window.KIOSK_ROUTER.renderArtists()); await wait(1000);
  c = await wall.evaluate(census);
  check(`Artists page: all cursor none (${c.total})`, allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  const back = await wall.evaluate(() => { const b = [...document.querySelectorAll('.g-back')].find(e => e.getBoundingClientRect().width > 0);
    if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  if (back) { await wall.mouse.move(back[0], back[1]); check('hovering the pink Back button: none, not a hand', (await wall.evaluate(under, back[0], back[1])).cursor === 'none'); }
  else check('hovering the pink Back button: none, not a hand', false, 'no Back button found');

  await wall.evaluate(() => { const t = document.querySelector('.g-tile'); if (t) t.dispatchEvent(new Event('click', { bubbles: true })); }); await wait(1500);
  c = await wall.evaluate(census);
  check(`a sheet or lightbox opened from the grid: all cursor none (${c.total})`, allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  await wall.screenshot({ path: path.join(DATA, 'wall-open.png') });

  // Idle → screensaver: from here on the 2-minute idle timer is 1.5s, re-armed
  // by an ordinary touch (pointerdown, as Touch Up sends) on empty page.
  await wall.evaluate(() => { window.__ktFastIdle = true;
    document.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'mouse', bubbles: true })); });
  await wait(4000);
  const ss = await wall.evaluate(() => document.body.classList.contains('screensaver'));
  c = await wall.evaluate(census);
  check('the screensaver started', ss);
  check(`screensaver: all cursor none (${c.total})`, ss && allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  await wall.mouse.click(540, 960); await wait(1200);               // the tap that wakes it
  c = await wall.evaluate(census);
  const woke = await wall.evaluate(() => !document.body.classList.contains('screensaver'));
  check('a tap woke the screensaver', woke);
  check(`after waking: all cursor none (${c.total})`, woke && allNone(c), JSON.stringify(c.counts) + ' ' + c.bad.join(' '));
  check('...and the pointer is still over a none cursor', (await wall.evaluate(under, 540, 960)).cursor === 'none');

  console.log('\ntunnel — the same studio server under another hostname');
  const tun = await open(`http://studio-tunnel.test:${PORT}/`);
  c = await tun.evaluate(census);
  check('not marked as the wall', !c.wall);
  check('normal cursors (auto) on the page', (c.counts.auto || 0) > 50, JSON.stringify(c.counts));

  console.log('\npublic — the repo files as Vercel serves them (no studio-server.js)');
  const pub = await open('http://public.test/index.html', { raw: true });
  c = await pub.evaluate(census);
  check('not marked as the wall', !c.wall);
  await pub.mouse.click(540, 1300); await wait(1200);
  const pubCur = await pub.evaluate(() => {
    const m = [...document.querySelectorAll('.g-mode, button, a')].find(e => e.getBoundingClientRect().width > 0);
    return { button: m && getComputedStyle(m).cursor, body: getComputedStyle(document.body).cursor };
  });
  check('a desktop visitor gets a hand on buttons and an arrow elsewhere', pubCur.button === 'pointer' && pubCur.body === 'auto', JSON.stringify(pubCur));

  if (process.env.SHOT_DIR) fs.copyFileSync(path.join(DATA, 'wall-open.png'), path.join(process.env.SHOT_DIR, 'wall-cursor-open.png'));
  await browser.close(); server.close(); try { conn.close(); } catch (e) {}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
