/* tools/verify-kiosk-layout.js — the kiosk as it is actually PAINTED.
 *
 * 9 Oct 2026, Joshua: "move the back button to the bottom of the screen" and
 * "increase the profile photos display size on the kiosk by 33%".
 *
 * Loads the real kiosk in headless Chrome at 1080×1920 and 390×844 (the live
 * catalog, read-only; one square shown as a single so the lightbox appears —
 * in this test browser only). On every page with Back — Artists, All flash,
 * an artist page, the single-design lightbox, the sheet viewer — checks that
 * Back is at the bottom-right, overlaps no QR code, page dot or arrow, and is
 * really PAINTED pink: a pixel read from a screenshot, because the two bugs
 * this caught while being built were a button that was correctly placed and
 * correctly styled and covered by something with pointer-events: none.
 * Also: avatar sizes (×1.33), the last grid row clear of Back, and the artist
 * cards free of overflow and photo/QR overlap.
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-kiosk-layout.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));
const puppeteer = from('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
setTimeout(() => { console.error('verify-kiosk-layout.js: timed out'); process.exit(2); }, 180000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.JPEG': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

/* The colour of one pixel from a 1×1 PNG screenshot. With a single pixel
 * every PNG row filter predicts from zero, so the raw bytes are the colour. */
function pixel(png) {
  let i = 8; const idat = [];
  while (i < png.length) {
    const len = png.readUInt32BE(i), type = png.toString('ascii', i + 4, i + 8);
    if (type === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}
const isPink = ([r, g, b]) => r > 180 && g < 90 && b > 100;

async function run(W, H) {
  console.log(`\n${W}×${H}`);
  const scale = W / 1080;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kt-layout-')), args: ['--no-first-run'] });
  const p = await browser.newPage();
  await p.setViewport({ width: W, height: H });
  await p.setRequestInterception(true);
  p.on('request', async req => {
    const u = new URL(req.url());
    if (u.host === 'kiosk.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.join(ROOT, rel);
      if (!fs.existsSync(f)) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
    }
    if (u.host.endsWith('.supabase.co') && u.pathname === '/rest/v1/kiosk_catalog') {
      if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' } });
      const h = req.headers();
      const r = await fetch(req.url(), { headers: { apikey: h.apikey, authorization: h.authorization } });
      const rows = await r.json();
      // Test browser only: show the first square as a single, so the lightbox is reachable.
      const sq = rows.find(x => x.width && x.width === x.height);
      // ...and only ONE design has a name (9 Oct 2026: no names made from file names).
      const named = rows.find(x => !(sq && x.id === sq.id));
      const out = rows.map(x => Object.assign({}, x, sq && x.id === sq.id ? { type: 'design' } : {},
                                              { title: named && x.id === named.id ? 'Named For Test' : null }));
      return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(out) });
    }
    req.continue();
  });

  const backCheck = async (page) => {
    await wait(900);
    const b = await p.evaluate(() => {
      const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
      const bk = [...document.querySelectorAll('.g-back, #sheetBackBtn')].find(vis);
      if (!bk) return null;
      const a = bk.getBoundingClientRect();
      const hits = [...document.querySelectorAll('.qr-badge, .g-card-qr, .dot, #qrBadge, #qrCaption, .nav-btn')].filter(vis)
        .filter(o => { const c = o.getBoundingClientRect(); return a.left < c.right && a.right > c.left && a.top < c.bottom && a.bottom > c.top; })
        .map(o => (o.id || o.className).toString().slice(0, 30));
      return { x: a.left, y: a.top, w: a.width, h: a.height, hits };
    });
    if (!b) { check(`${page}: Back is on the page`, false); return; }
    /* The WHOLE button, not one spot: five points — four corners and the
     * middle of the bottom edge. The tray bug (9 Oct 2026) covered only the
     * lower half, and a single mid-height sample passed straight over it.
     * At each point: painted pink (catches coverings that ignore taps) and
     * the topmost element is the button (catches anything that takes the tap). */
    const inset = 8 * scale;
    const pts = [[b.x + inset, b.y + inset], [b.x + b.w - inset, b.y + inset], [b.x + inset, b.y + b.h - inset],
                 [b.x + b.w - inset, b.y + b.h - inset], [b.x + b.w / 2, b.y + b.h - inset]];
    const bad = [];
    for (const [x, y] of pts) {
      const rgb = pixel(Buffer.from(await p.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })));
      const top = await p.evaluate((x, y) => {
        const bk = [...document.querySelectorAll('.g-back, #sheetBackBtn')].find(e => e.getBoundingClientRect().height > 0);
        const t = document.elementFromPoint(x, y);
        return bk && t && (bk === t || bk.contains(t)) ? null : (t ? (t.id || t.className || t.tagName).toString().slice(0, 40) : 'nothing');
      }, x, y);
      if (!isPink(rgb) || top) bad.push(`(${Math.round(x)},${Math.round(y)}) rgb(${rgb})${top ? ' under ' + top : ''}`);
    }
    check(`${page}: Back at the bottom-right, fully visible and tappable (5 points), overlapping no QR/dots/arrows`,
      b.x + b.w > W * 0.75 && b.y + b.h > H * 0.9 && !bad.length && !b.hits.length,
      `at (${Math.round(b.x)},${Math.round(b.y)}) ${bad.join('; ')} ${b.hits.length ? 'hits ' + b.hits.join(',') : ''}`);
  };

  await p.goto('http://kiosk.test/index.html', { waitUntil: 'networkidle2' });
  await wait(1500);
  await p.mouse.click(W / 2, H * 0.68);
  await wait(1200);

  const cover = await p.evaluate(() => [...document.querySelectorAll('.g-covergrid .g-card-mode')].map(c => c.querySelector('.g-card-all-title').textContent));
  check('the cover offers View All and Browse by Artist — no Full Flash Sheets', !cover.some(t => /sheet/i.test(t)) && cover.includes('View All') && cover.includes('Browse by Artist'), cover.join(' | '));
  await p.evaluate(() => window.KIOSK_ROUTER.renderArtists());
  await backCheck('Artists');
  const cards = await p.evaluate(() => [...document.querySelectorAll('.g-card-artist')].map(c => {
    const pt = c.querySelector('.g-card-portrait'), q = c.querySelector('.g-card-qr');
    const pr = pt && pt.getBoundingClientRect(), qr = q && q.getBoundingClientRect();
    return { qr: !!q, portrait: pr ? pr.width : 0, overlap: !!(pr && qr && pr.right > qr.left && pr.left < qr.right && pr.bottom > qr.top && pr.top < qr.bottom),
             overflow: c.scrollWidth > c.clientWidth + 1 || c.scrollHeight > c.clientHeight + 1 };
  }));
  const want = cards.some(c => c.qr) ? 112 : 138;
  check(`artist-card photos are ${want}px on the 1080 canvas (×1.33)`,
    cards.length > 0 && cards.every(c => Math.abs(c.portrait / scale - want) < 1.5), cards.map(c => Math.round(c.portrait / scale)).join(','));
  check('artist cards: no overflow, photo and QR never overlap', cards.every(c => !c.overflow && !c.overlap));
  await wait(600);   // fonts settle; the fit re-runs
  const text = await p.evaluate(() => [...document.querySelectorAll('.g-card-artist')].flatMap(c => {
    const q = c.querySelector('.g-card-qr'); const qr = q && q.getBoundingClientRect();
    return [...c.querySelectorAll('.g-card-name, .g-card-handle')].map(l => {
      const r = l.getBoundingClientRect();
      // The line's own content width, not the box: text that runs on past the box is what slid under the QR.
      const k = r.width / (l.offsetWidth || 1);   // canvas scale: screen px per layout px
      return { t: l.textContent, underQr: !!(qr && r.left + l.scrollWidth * k > qr.left + 1),
               clipped: l.scrollWidth > l.parentElement.clientWidth + 1, size: parseFloat(getComputedStyle(l).fontSize) };
    });
  }));
  const bad = text.filter(x => x.underQr || x.clipped);
  check('no artist name or handle runs under the QR box or is cut off', bad.length === 0,
    bad.map(x => `${x.t} (${x.size}px${x.underQr ? ', under QR' : ''}${x.clipped ? ', cut off' : ''})`).join('; '));
  check('handles stay readable (never shrunk below 12px on the canvas)', text.every(x => x.size / scale >= 11.5),
    text.map(x => x.t + ' ' + Math.round(x.size / scale) + 'px').join(', '));

  await p.evaluate(() => { window.KIOSK_ROUTER.goHome(); });
  await wait(400);
  await p.evaluate(() => document.querySelector('.g-mode-all').dispatchEvent(new Event('click', { bubbles: true })));
  await backCheck('All flash');
  const last = await p.evaluate(() => {
    const sc = [...document.querySelectorAll('#gallery, #gallery *')].find(e => e.scrollHeight > e.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    if (sc) sc.scrollTop = sc.scrollHeight;
    const tiles = [...document.querySelectorAll('.g-tile')], t = tiles[tiles.length - 1];
    const bk = [...document.querySelectorAll('#gallery .g-back')].find(e => e.getBoundingClientRect().height > 0);
    return t && bk ? { tile: t.getBoundingClientRect().bottom, back: bk.getBoundingClientRect().top } : null;
  });
  check('scrolled to the end, the last row sits above Back (never hidden behind it)', last && last.tile <= last.back, JSON.stringify(last));
  const caps = await p.evaluate(() => [...document.querySelectorAll('.g-tile')].map(t => ({
    title: (t.querySelector('.g-tile-title') || {}).textContent || null, artist: (t.querySelector('.g-tile-artist') || {}).textContent || null })));
  check('View All: a title line only where the artist gave a name — never a file name or "Untitled"',
    caps.filter(c => c.title).map(c => c.title).join() === 'Named For Test' && caps.every(c => c.artist),
    JSON.stringify(caps.slice(0, 4)));

  await p.evaluate(() => window.KIOSK_ROUTER.renderArtists());
  await wait(500);
  const opened = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.g-card-artist')].find(x => /sheet|design/.test(x.innerText) && x.querySelector('.g-card-portrait img'))
           || [...document.querySelectorAll('.g-card-artist')].find(x => /sheet|design/.test(x.innerText));
    if (!c) return false; c.dispatchEvent(new Event('click', { bubbles: true })); return true;
  });
  if (opened) {
    await backCheck('Artist page');
    const face = await p.evaluate(() => { const f = document.querySelector('.g-artistinfo-face'); return f ? f.getBoundingClientRect().width : 0; });
    if (face) check('Follow-panel photo is 213px on the 1080 canvas (×1.33)', Math.abs(face / scale - 213) < 1.5, String(Math.round(face / scale)));
  }

  // The single-design lightbox and the sheet viewer, from All flash.
  await p.evaluate(() => { window.KIOSK_ROUTER.goHome(); });
  await wait(400);
  await p.evaluate(() => document.querySelector('.g-mode-all').dispatchEvent(new Event('click', { bubbles: true })));
  await wait(800);
  if (await p.evaluate(() => { const t = document.querySelector('.g-tile-design'); if (t) t.dispatchEvent(new Event('click', { bubbles: true })); return !!t; })) {
    await backCheck('Single-design lightbox');
    const meta = await p.evaluate(() => ({ title: (document.querySelector('.g-detail-title') || {}).textContent || null,
      sub: (document.querySelector('.g-detail-sub') || {}).textContent || null }));
    check('lightbox: an unnamed design shows the artist and no title line', meta.title === null && !!meta.sub, JSON.stringify(meta));
  }
  await p.evaluate(() => { window.KIOSK_ROUTER.goHome(); });
  await wait(400);
  await p.evaluate(() => document.querySelector('.g-mode-all').dispatchEvent(new Event('click', { bubbles: true })));
  await wait(800);
  if (await p.evaluate(() => { const t = document.querySelector('.g-tile-sheet'); if (t) t.dispatchEvent(new Event('click', { bubbles: true })); return !!t; })) {
    await wait(1200);
    await backCheck('Sheet viewer');
    const lum = await p.evaluate(() => { const c = getComputedStyle(document.getElementById('sheetLabel')).color.match(/\d+/g).map(Number);
      const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); });
    check('the SHEET n / N counter is dark type (readable on the light header), not yellow', lum < 0.05, 'luminance ' + lum.toFixed(3));
  }
  await browser.close();
}

(async () => {
  await run(1080, 1920);
  await run(390, 844);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
