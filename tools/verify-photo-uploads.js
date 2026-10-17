/* tools/verify-photo-uploads.js — camera-roll photos, on a phone-sized screen.
 *
 * 17 Oct 2026. Miranda (iPhone, Chrome) picked a profile photo from her
 * camera roll: the sheet showed nothing and Supabase saw no request at all.
 * A photo she took with the camera worked. The cause was a 4 MB cap on the
 * PICKED file, reported in a toast drawn underneath the sheet.
 *
 * The real dashboard, signed in as an artist, at 390×844, in real Chrome AND
 * in WebKit (Playwright's build, which decodes HEIC with macOS's ImageIO like
 * Safari does). Every *.supabase.co request is answered here: nothing is
 * stored, nothing reaches Kat's project, no email. The files are real:
 *
 *   camera-roll.jpg   4032×3024 JPEG, over 4 MB — what iOS hands over
 *   camera-roll.heic  3024×4032 HEIC encoded by Apple's own encoder (sips)
 *   icloud.jpg        0 bytes — a photo still in iCloud
 *   notes.jpg         text with a .jpg name
 *
 * Checks the profile photo sheet (opening, uploading + spinner + disabled
 * button, saved + the new photo shown, every failure visible and persistent,
 * no silent close) and design uploads (staged, uploading, published, failed),
 * what was uploaded (type matches bytes, under the bucket limit), and saves
 * a screenshot of every state to $SHOTS (default: a temp dir).
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-photo-uploads.js
 *     (<dir> has playwright; WebKit via `npx playwright install webkit`)
 *   ENGINES=chrome            only one engine
 *   VERIFY_PHOTO_OLD=1        NEGATIVE CONTROL: serve origin/main's dashboard
 *                             (before this fix). It must FAIL.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));
const { chromium, webkit } = from('playwright');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OLD = process.env.VERIFY_PHOTO_OLD === '1';
const ENGINES = (process.env.ENGINES || 'chrome,webkit').split(',');
const SHOTS = process.env.SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-photo-shots-'));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-photo-'));
fs.mkdirSync(SHOTS, { recursive: true });

// Nothing in here may hang: the whole run has a hard limit.
setTimeout(() => { console.error('verify-photo-uploads.js: timed out'); process.exit(2); }, 240000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

/* The dashboard files to serve: this tree, or origin/main's for the control. */
function dashFile(rel) {
  if (OLD) {
    try { return execFileSync('git', ['-C', ROOT, 'show', 'origin/main:dashboard/' + rel], { maxBuffer: 1 << 26 }); }
    catch (e) { return null; }
  }
  const f = path.join(ROOT, 'dashboard', rel);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = '00000000-0000-4000-8000-0000000000aa';
const ME = 'ad5ed37b-0000-4000-8000-00000000test';
const exp = Math.floor(Date.now() / 1000) + 3600;
const JWT = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, role: 'authenticated', aud: 'authenticated', exp }) + '.c2ln';
const cfgSrc = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8');
const REF = new URL(cfgSrc.match(/supabaseUrl:\s*'([^']+)'/)[1]).hostname.split('.')[0];

function magic(buf) {
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.slice(4, 12).toString().startsWith('ftyp')) return 'image/heic';
  return 'unknown';
}

/* Playwright does not hand over Blob/File request bodies (WebKit gives none,
 * Chrome none for a File), so the page reports each storage upload's real
 * bytes itself, from inside fetch, before it goes out. */
function captureUploads() {
  const real = window.fetch;
  window.fetch = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input.url;
      const m = init && /\/storage\/v1\/object\/(?!public|list)/.test(url) && /POST|PUT/i.test(init.method || '');
      if (m) {
        let blob = init.body;
        if (blob instanceof FormData) blob = [...blob.values()].find(v => v instanceof Blob);
        if (blob instanceof Blob) {
          const buf = new Uint8Array(await blob.arrayBuffer());
          let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          const key = new URL(url).pathname.replace(/^.*\/storage\/v1\/object\//, '');
          await window.__ktUpload(key, btoa(bin));
        }
      }
    } catch (e) { console.error('capture', e); }
    return real.apply(this, arguments);
  };
}

/* supabase-js sends a Blob as multipart: pull out the file part. */
function filePart(req) {
  const body = req.postDataBuffer() || Buffer.alloc(0);
  const ct = req.headers()['content-type'] || '';
  const m = ct.match(/boundary=(.+)$/);
  if (!m) return { type: ct, bytes: body };
  const sep = Buffer.from('--' + m[1]);
  let i = 0; const parts = [];
  while ((i = body.indexOf(sep, i)) !== -1) {
    const j = body.indexOf(sep, i + sep.length);
    if (j === -1) break;
    parts.push(body.slice(i + sep.length + 2, j - 2)); i = j;
  }
  for (const p of parts) {
    const h = p.indexOf('\r\n\r\n');
    const head = p.slice(0, h).toString();
    const t = (head.match(/Content-Type:\s*([^\r\n]+)/i) || [])[1];
    if (t && t !== 'text/plain') return { type: t.trim(), bytes: p.slice(h + 4) };
  }
  return { type: ct, bytes: body };
}

/* ── Real files ─────────────────────────────────────────────────────────── */
async function makeFiles(browser) {
  const page = await browser.newPage();
  // A photograph-like picture: gradients, shapes and sensor-like noise, so it
  // compresses like a photo (big), not like a flat logo (tiny).
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 4032; c.height = 3024;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 4032, 3024);
    g.addColorStop(0, '#f2c9a0'); g.addColorStop(0.5, '#6b8fb3'); g.addColorStop(1, '#2b2b3a');
    x.fillStyle = g; x.fillRect(0, 0, 4032, 3024);
    x.fillStyle = '#e8b48a'; x.beginPath(); x.ellipse(2016, 1400, 700, 900, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#E91E8C'; x.fillRect(300, 2300, 1200, 500);
    const d = x.getImageData(0, 0, 4032, 3024), a = d.data;
    let s = 7;
    for (let i = 0; i < a.length; i += 4) {
      s = (s * 1103515245 + 12345) & 0x7fffffff; const n = (s % 61) - 30;
      a[i] += n; a[i + 1] += n; a[i + 2] += n;
    }
    x.putImageData(d, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.close();
  const src = path.join(TMP, 'src.png');
  fs.writeFileSync(src, Buffer.from(png, 'base64'));
  const jpg = path.join(TMP, 'camera-roll.jpg');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '100', src, '--out', jpg], { stdio: 'ignore' });
  // Portrait, as a phone photo usually is: 3024×4032, wide enough for a sheet.
  const rot = path.join(TMP, 'portrait.png');
  execFileSync('/usr/bin/sips', ['-r', '90', src, '--out', rot], { stdio: 'ignore' });
  const heic = path.join(TMP, 'camera-roll.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', rot, '--out', heic], { stdio: 'ignore' });
  const empty = path.join(TMP, 'icloud.jpg'); fs.writeFileSync(empty, '');
  const text = path.join(TMP, 'notes.jpg'); fs.writeFileSync(text, 'not a picture\n');
  return { jpg, heic, empty, text };
}

/* ── One engine ─────────────────────────────────────────────────────────── */
async function run(engine, FILES) {
  console.log(`\n${engine}${OLD ? ' (NEGATIVE CONTROL: origin/main)' : ''}`);
  const browser = engine === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ executablePath: CHROME, args: ['--no-first-run'] });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true,
    isMobile: engine !== 'webkit' ? true : undefined,
    userAgent: engine === 'webkit'
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
      : 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/153.0 Mobile/15E148 Safari/604.1',
  });
  const S = { uploads: [], patches: [], inserts: [], stored: new Map(), bytes: new Map(), holdMs: 0, failStorage: null };
  await ctx.exposeBinding('__ktUpload', (src, key, b64) => { S.bytes.set(decodeURIComponent(key), Buffer.from(b64, 'base64')); });
  await ctx.addInitScript(captureUploads);

  await ctx.route('**/*', async route => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.host === 'dash.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const body = dashFile(rel);
      if (!body) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, body,
        contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.html') ? 'text/html' : 'text/javascript' });
    }
    if (!u.host.endsWith('.supabase.co')) return route.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (o, s) => route.fulfill({ status: s || 200, contentType: 'application/json', headers: cors, body: JSON.stringify(o) });
    if (u.pathname.startsWith('/auth/v1/token')) return json({ access_token: JWT, refresh_token: 'r2', token_type: 'bearer',
      expires_in: 3600, expires_at: exp, user: { id: UID, aud: 'authenticated', role: 'authenticated' } });
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: UID, aud: 'authenticated', role: 'authenticated' });
    if (u.pathname.startsWith('/auth/v1/')) return json({});
    if (u.pathname.startsWith('/storage/v1/object/public/')) {
      const key = decodeURIComponent(u.pathname.replace('/storage/v1/object/public/', ''));
      const f = S.stored.get(key);
      if (!f) return route.fulfill({ status: 404, headers: cors, body: '' });
      return route.fulfill({ status: 200, headers: cors, contentType: f.type, body: f.bytes });
    }
    if (u.pathname.startsWith('/storage/v1/object/list')) return json([]);
    if (u.pathname.startsWith('/storage/v1/object/') && (req.method() === 'POST' || req.method() === 'PUT')) {
      const key = decodeURIComponent(u.pathname.replace('/storage/v1/object/', ''));
      const part = filePart(req);
      if (S.bytes.has(key)) part.bytes = S.bytes.get(key);   // the real bytes, from the page
      S.uploads.push({ key, type: part.type, size: part.bytes.length, magic: magic(part.bytes) });
      if (S.holdMs) await new Promise(r => setTimeout(r, S.holdMs));
      if (S.failStorage) return json({ statusCode: '500', error: 'Internal', message: S.failStorage }, 500);
      S.stored.set(key, part);
      return json({ Key: key });
    }
    if (u.pathname.startsWith('/storage/v1/')) return json([]);
    if (u.pathname.startsWith('/rest/v1/artists') && req.method() === 'PATCH') {
      S.patches.push(JSON.parse(req.postData() || '{}'));
      return json([]);
    }
    if (u.pathname === '/rest/v1/designs' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      S.inserts.push(body);
      return json(Object.assign({ id: 'new-' + S.inserts.length }, body), 201);
    }
    if (u.pathname.startsWith('/rest/v1/artists') && u.search.includes('auth_user_id')) {
      return json({ id: ME, name: 'Miranda', role: 'artist', active: true, kiosk_visible: true, auth_user_id: UID,
                    portrait_url: null, portrait_thumb_url: null,
                    tutorial_seen: [], tutorial_snoozed: [], tutorial_seen_at: new Date().toISOString() });
    }
    return json([]);
  });
  await ctx.addInitScript(([ref, jwt, uid, exp]) => {
    localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'r',
      token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: uid, aud: 'authenticated', role: 'authenticated' } }));
  }, [REF, JWT, UID, exp]);

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://dash.test/index.html', { waitUntil: 'load' });
  await page.waitForSelector('#myAvatar:not([hidden])', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
  const shot = async name => {
    const f = path.join(SHOTS, `${engine}-${name}.png`);
    await page.screenshot({ path: f });
    return f;
  };
  const status = () => page.evaluate(() => {
    const s = document.querySelector('.sheet-card .upl-status');
    if (!s || s.hidden) return null;
    const r = s.getBoundingClientRect();
    return { state: s.dataset.state, text: s.textContent.trim(), spinner: !!s.querySelector('.spinner'),
      onScreen: r.top >= 0 && r.bottom <= innerHeight && r.height > 0 };
  });
  const sheetOpen = () => page.evaluate(() => !!document.querySelector('.sheet-backdrop'));
  const openSheet = async () => {
    if (!(await sheetOpen())) await page.click('#myAvatar');
    await page.waitForSelector('.sheet-card input[type=file]', { state: 'attached', timeout: 5000 });
  };
  const pick = async f => {
    const before = S.uploads.length;
    await page.setInputFiles('.sheet-card input[type=file]', f);
    return before;
  };
  const waitStatus = (state, ms) => page.waitForFunction(st => {
    const s = document.querySelector('.sheet-card .upl-status');
    return s && !s.hidden && s.dataset.state === st;
  }, state, { timeout: ms || 20000 }).then(() => true, () => false);
  const tap = sel => page.evaluate(s => {
    const b = [...document.querySelectorAll('.sheet-card button')].find(x => x.textContent.trim() === s);
    if (b) b.click(); return !!b;
  }, sel);
  const canHeic = engine === 'webkit';

  check('dashboard booted signed in as an artist, no script errors',
    await page.evaluate(() => !!document.querySelector('#myAvatar:not([hidden])')), errors.join(' | '));

  /* 1. A big camera-roll JPEG (> 4 MB): must open, upload, and say so. */
  console.log(' profile photo — camera-roll JPEG, ' + (fs.statSync(FILES.jpg).size / 1048576).toFixed(1) + ' MB');
  await openSheet();
  let before = await pick(FILES.jpg);
  const previewShown = await page.waitForFunction(() => {
    const p = document.querySelector('.sheet-card .crop'); return p && !p.hidden;
  }, null, { timeout: 20000 }).then(() => true, () => false);
  check('the crop preview opens for a >4 MB camera-roll photo (was refused, invisibly)', previewShown);
  check('the sheet is still open after picking', await sheetOpen());
  await shot('profile-1-chosen');

  S.holdMs = 2500;
  await tap('Use this photo');
  const busy = await waitStatus('busy', 5000);
  const st1 = await status();
  const saveBtn = await page.evaluate(() => {
    const b = document.querySelector('.sheet-card .btn-primary'); return b && { disabled: b.disabled, text: b.textContent };
  });
  check('while uploading: "Uploading your photo…" with a spinner, on screen',
    busy && st1 && /Uploading your photo/.test(st1.text) && st1.spinner && st1.onScreen, JSON.stringify(st1));
  check('while uploading: the button is disabled', saveBtn && saveBtn.disabled, JSON.stringify(saveBtn));
  await shot('profile-2-uploading');
  S.holdMs = 0;

  const ok = await waitStatus('ok', 20000);
  const st2 = await status();
  check('on success: "Photo saved — it’ll show on the wall within the hour", on screen',
    ok && st2 && /Photo saved — it’ll show on the wall within the hour/.test(st2.text) && st2.onScreen, JSON.stringify(st2));
  const saved = await page.waitForFunction(() => {
    const i = document.querySelector('.sheet-card .saved-img'); return i && i.complete && i.naturalWidth > 0;
  }, null, { timeout: 10000 }).then(() => true, () => false);
  const savedSrc = await page.evaluate(() => (document.querySelector('.sheet-card .saved-img') || {}).src || '');
  check('on success: the new photo is shown, loaded back from storage, cache-busted (?v=)', saved && /\?v=\d+/.test(savedSrc), savedSrc);
  const bar = await page.evaluate(() => (document.querySelector('#myAvatar img') || {}).src || '');
  check('the top-bar photo is the new one, immediately', !!bar && S.patches.length > 0 && bar === S.patches[S.patches.length - 1].portrait_thumb_url, bar);
  const ups = S.uploads.slice(before);
  check('two avatar files were uploaded (full + small)', ups.length === 2 && ups.every(u => u.key.startsWith('avatars/' + ME + '/')), JSON.stringify(ups));
  check('every upload IS the type it says, and its extension matches (no PNG named .webp)',
    ups.length && ups.every(u => u.magic === u.type && u.key.endsWith('.' + { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' }[u.type])),
    JSON.stringify(ups));
  check('every avatar upload is under the bucket’s 5 MB', ups.length && ups.every(u => u.size < 5 * 1024 * 1024), JSON.stringify(ups.map(u => u.size)));
  await shot('profile-3-saved');
  await tap('Done');
  check('Done closes the sheet', !(await sheetOpen()));

  /* 2. HEIC. WebKit decodes it; Chrome can't, and must say what to do. */
  console.log(' profile photo — HEIC from the camera roll');
  await openSheet();
  before = await pick(FILES.heic);
  if (canHeic) {
    const shown = await page.waitForFunction(() => {
      const p = document.querySelector('.sheet-card .crop'); return p && !p.hidden;
    }, null, { timeout: 20000 }).then(() => true, () => false);
    check('WebKit: the HEIC opens in the crop preview', shown, JSON.stringify(await status()));
    await shot('profile-4-heic-chosen');
    await tap('Use this photo');
    const okH = await waitStatus('ok', 20000);
    const upsH = S.uploads.slice(before);
    check('WebKit: the HEIC is saved, uploaded as a real ' + (upsH[0] || {}).type, okH && upsH.length === 2 && upsH.every(u => u.magic === u.type), JSON.stringify(upsH));
    await shot('profile-5-heic-saved');
    await tap('Done');
  } else {
    const err = await waitStatus('error', 20000);
    const st = await status();
    check('Chrome: the HEIC is refused IN THE SHEET, naming HEIC and saying JPEG or PNG',
      err && st && /HEIC/.test(st.text) && /JPEG or PNG/.test(st.text) && st.onScreen, JSON.stringify(st));
    check('Chrome: the sheet stays open and nothing was uploaded', await sheetOpen() && S.uploads.length === before);
    await shot('profile-4-heic-refused');
    await page.waitForTimeout(5000);
    const later = await status();
    check('the message is still there 5 s later (not a toast)', later && later.state === 'error', JSON.stringify(later));
  }

  /* 3. A photo still in iCloud (0 bytes), and a file that is not a picture. */
  console.log(' profile photo — iCloud placeholder, non-image');
  await openSheet();
  before = await pick(FILES.empty);
  await waitStatus('error', 10000);
  let st = await status();
  check('a 0-byte (iCloud) photo is refused in the sheet, mentioning iCloud', st && /iCloud/.test(st.text) && st.onScreen, JSON.stringify(st));
  await shot('profile-6-icloud');
  await pick(FILES.text);
  await page.waitForFunction(() => /couldn’t open/.test((document.querySelector('.sheet-card .upl-status') || {}).textContent || ''),
    null, { timeout: 10000 }).catch(() => {});
  st = await status();
  check('a non-image is refused in the sheet, saying JPEG or PNG', st && st.state === 'error' && /JPEG or PNG/.test(st.text), JSON.stringify(st));
  check('...and nothing was uploaded for either', S.uploads.length === before);

  /* 4. A tap on the dimmed backdrop must not close the sheet. */
  await page.mouse.click(195, 30);
  check('a tap on the backdrop does not close the sheet', await sheetOpen());

  /* 5. The upload itself fails: say so, keep the sheet, allow a retry. */
  console.log(' profile photo — upload fails');
  await pick(FILES.jpg);
  await page.waitForFunction(() => { const p = document.querySelector('.sheet-card .crop'); return p && !p.hidden; }, null, { timeout: 20000 }).catch(() => {});
  S.failStorage = 'Internal server error';
  await tap('Use this photo');
  await waitStatus('error', 20000);
  st = await status();
  const retry = await page.evaluate(() => { const b = document.querySelector('.sheet-card .btn-primary'); return b && !b.disabled && b.textContent; });
  check('a failed upload says "Your photo was not saved" and what to do, on screen',
    st && /Your photo was not saved/.test(st.text) && /try again|again/i.test(st.text) && st.onScreen, JSON.stringify(st));
  check('...the sheet stays open and "Use this photo" is enabled to retry', await sheetOpen() && retry === 'Use this photo', String(retry));
  await shot('profile-7-upload-failed');
  S.failStorage = null;
  await tap('Cancel');

  /* 6. Design uploads. */
  console.log(' design uploads');
  await page.evaluate(() => { const t = document.querySelector('.tab[data-view="upload"]'); if (t) t.click(); });
  await page.waitForSelector('#view-upload input[type=file]', { state: 'attached', timeout: 5000 });
  // The first-run tour, skipped the way an artist would (it never blocks).
  await page.waitForTimeout(600);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Skip'); if (b) b.click(); });
  // In the app the status scrolls itself into view; the check is that it
  // lands BELOW the sticky header, not under it.
  const underHeader = () => page.evaluate(() => {
    const s = document.querySelector('#uploadStatus'), h = document.querySelector('#tabs') || document.querySelector('#topbar');
    return s && h ? s.getBoundingClientRect().top < h.getBoundingClientRect().bottom - 1 : null;
  });
  const dstatus = () => page.evaluate(() => {
    const s = document.querySelector('#uploadStatus');
    if (!s || s.hidden) return null;
    const r = s.getBoundingClientRect();
    return { state: s.dataset.state, text: s.textContent.trim(), spinner: !!s.querySelector('.spinner'), visible: r.height > 0 };
  });
  const dwait = (state, ms) => page.waitForFunction(st => {
    const s = document.querySelector('#uploadStatus'); return s && !s.hidden && s.dataset.state === st;
  }, state, { timeout: ms || 30000 }).then(() => true, () => false);
  before = S.uploads.length;
  await page.setInputFiles('#view-upload input[type=file]', [FILES.jpg, FILES.heic, FILES.text]);
  await page.waitForFunction(() => document.querySelectorAll('#queue .card.item').length === 3, null, { timeout: 30000 }).catch(() => {});
  const cards = await page.evaluate(() => [...document.querySelectorAll('#queue .card.item')].map(c => ({
    file: c.dataset.file, bad: c.classList.contains('is-bad'), error: (c.querySelector('.error') || {}).textContent || '' })));
  const card = n => cards.find(c => c.file === n) || {};
  check('three cards staged: the JPEG ready, the non-image refused on its own card',
    cards.length === 3 && !card('camera-roll.jpg').bad && card('notes.jpg').bad && /JPEG or PNG/.test(card('notes.jpg').error), JSON.stringify(cards));
  check(canHeic ? 'WebKit: the HEIC is staged ready (3024×4032 → a flash sheet)' : 'Chrome: the HEIC is refused on its own card, naming HEIC',
    canHeic ? !card('camera-roll.heic').bad : (card('camera-roll.heic').bad && /HEIC/.test(card('camera-roll.heic').error)), JSON.stringify(card('camera-roll.heic')));
  let ds = await dstatus();
  check('the upload card says which files cannot be uploaded, by name', ds && ds.state === 'error' && /notes\.jpg/.test(ds.text), JSON.stringify(ds));
  await page.evaluate(() => document.querySelector('#uploadStatus').scrollIntoView({ block: 'start' }));
  check('the upload status is not hidden under the sticky header', (await underHeader()) === false);
  await shot('designs-1-staged');

  S.holdMs = 1500;
  await page.evaluate(() => [...document.querySelectorAll('#queue button')].find(b => /Publish all|Uploading/.test(b.textContent)).click());
  await dwait('busy', 5000);
  ds = await dstatus();
  const dis = await page.evaluate(() => {
    const bs = [...document.querySelectorAll('#queue .bulk > .row button')];
    return bs.length === 3 && bs.every(b => b.disabled);
  });
  check('while uploading: "Uploading…" (1 of N for several) with a spinner; Drafts / Publish / Clear disabled',
    ds && (canHeic ? /Uploading 1 of 2…/ : /Uploading…/).test(ds.text) && ds.spinner && dis, JSON.stringify(ds) + ' disabled=' + dis);
  await page.evaluate(() => document.querySelector('#uploadStatus').scrollIntoView({ block: 'start' }));
  check('the upload status is not hidden under the sticky header', (await underHeader()) === false);
  await shot('designs-2-uploading');
  S.holdMs = 0;
  await dwait('ok', 60000);
  ds = await dstatus();
  const nGood = canHeic ? 2 : 1;
  check(`on success: "${nGood} design${nGood > 1 ? 's' : ''} published … on the wall within the hour"`,
    ds && ds.state === 'ok' && new RegExp(nGood + ' designs? published').test(ds.text) && /within the hour/.test(ds.text), JSON.stringify(ds));
  const dups = S.uploads.slice(before);
  check('every design upload is an accepted type (JPEG/PNG/WebP), is what it says, under 50 MB',
    dups.length && dups.every(u => ['image/jpeg', 'image/png', 'image/webp'].includes(u.type) && u.magic === u.type && u.size < 50 * 1024 * 1024),
    JSON.stringify(dups));
  if (canHeic) {
    check('WebKit: the HEIC’s original is kept as a JPEG (the bucket refuses HEIC)',
      dups.some(u => /original\.jpg$/.test(u.key) && u.magic === 'image/jpeg') && !dups.some(u => u.magic === 'image/heic'), JSON.stringify(dups.map(u => u.key)));
  }
  await page.evaluate(() => document.querySelector('#uploadStatus').scrollIntoView({ block: 'start' }));
  check('the upload status is not hidden under the sticky header', (await underHeader()) === false);
  await shot('designs-3-published');

  // A failure: the file stays, the card and the status both say so.
  await page.evaluate(() => { const b = [...document.querySelectorAll('#queue button')].find(x => x.textContent === 'Clear'); if (b) b.click(); });
  await page.setInputFiles('#view-upload input[type=file]', [FILES.jpg]);
  await page.waitForFunction(() => document.querySelectorAll('#queue .card.item').length === 1, null, { timeout: 20000 }).catch(() => {});
  S.failStorage = 'Internal server error';
  await page.evaluate(() => [...document.querySelectorAll('#queue button')].find(b => b.textContent === 'Publish all').click());
  await dwait('error', 30000);
  ds = await dstatus();
  const failCard = await page.evaluate(() => (document.querySelector('#queue .item-failed') || {}).textContent || '');
  check('a failed design upload: the status says it did not upload and what to do',
    ds && /did not upload/.test(ds.text) && /Publish all again/.test(ds.text), JSON.stringify(ds));
  check('...and its card stays, saying "Not uploaded"', /Not uploaded/.test(failCard), failCard);
  await page.evaluate(() => document.querySelector('#uploadStatus').scrollIntoView({ block: 'start' }));
  check('the upload status is not hidden under the sticky header', (await underHeader()) === false);
  await shot('designs-4-failed');
  S.failStorage = null;

  check('no script errors on the page', errors.length === 0, errors.join(' | '));
  await browser.close();
}

(async () => {
  const maker = await chromium.launch({ executablePath: CHROME, args: ['--no-first-run'] });
  const FILES = await makeFiles(maker);
  await maker.close();
  console.log('files: ' + Object.entries(FILES).map(([k, f]) =>
    `${path.basename(f)} ${fs.statSync(f).size} B${k === 'heic' ? ' (' + magic(fs.readFileSync(f)) + ')' : ''}`).join(', '));
  check('the HEIC sample is a real HEIC (ftyp box)', magic(fs.readFileSync(FILES.heic)) === 'image/heic');
  check('the camera-roll JPEG is over 4 MB (the old cap)', fs.statSync(FILES.jpg).size > 4 * 1024 * 1024);
  for (const e of ENGINES) {
    try { await run(e, FILES); }
    catch (err) { failed++; console.log('  FAIL ' + e + ' crashed — ' + (err && err.message)); }
  }
  console.log(`\nscreenshots: ${SHOTS}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
