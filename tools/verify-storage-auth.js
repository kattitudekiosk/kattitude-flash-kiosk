/* tools/verify-storage-auth.js — does a signed-in artist's upload carry THEIR
 * token, or the public key?
 *
 * 3 Oct 2026: every upload on the hosted dashboard reached Supabase Storage as
 * role anon and was refused by RLS, while the same session's database calls
 * ran as the artist. This loads the real dashboard page in headless Chrome
 * (the real supabase-js from the CDN, exactly as index.html names it) with a
 * signed-in session planted in localStorage, and records the Authorization
 * header every client sends to /storage/v1/object and /rest/v1.
 *
 * NOTHING REACHES SUPABASE. Every request to *.supabase.co is answered here
 * from stubs; no file is stored, no row written, no email sent.
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-storage-auth.js
 *   KT_SUPABASE_JS=2.45.4   (override the version index.html loads; control)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));
const puppeteer = from('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
setTimeout(() => { console.error('verify-storage-auth.js: timed out'); process.exit(2); }, 90000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = '00000000-0000-4000-8000-0000000000aa';          // a stand-in artist login
const ARTIST = '9e767f86-c114-47b4-b7e4-78f780bbdc4f';      // Naomi's card id (public)
/* KT_EXPIRED=1: the planted session's access token has already expired, as
 * it has for anybody who signed in more than an hour ago. Refresh tokens
 * rotate exactly as Supabase rotates them: each works ONCE. */
const EXPIRED = process.env.KT_EXPIRED === '1';
const now = Math.floor(Date.now() / 1000);
const jwt = (exp, n) => b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, role: 'authenticated',
  aud: 'authenticated', exp, iat: exp - 3600, email: 'artist@example.invalid', n }) + '.c2lnbmF0dXJl';
const exp = EXPIRED ? now - 60 : now + 3600;
const USER_JWT = jwt(exp, 0);
const isUserToken = a => { try { const p = JSON.parse(Buffer.from(a.replace(/^Bearer /, '').split('.')[1], 'base64url'));
  return p.sub === UID && p.role === 'authenticated'; } catch (e) { return false; } };

(async () => {
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8');
  const SB = cfgSrc.match(/supabaseUrl:\s*'([^']+)'/)[1];
  const KEY = cfgSrc.match(/supabaseAnonKey:\s*'([^']+)'/)[1];
  const ref = new URL(SB).hostname.split('.')[0];
  let html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
  const version = (html.match(/supabase-js@([\d.]+)/) || [])[1];
  if (process.env.KT_SUPABASE_JS) html = html.replace(/supabase-js@[\d.]+/, 'supabase-js@' + process.env.KT_SUPABASE_JS);
  console.log(`supabase-js ${process.env.KT_SUPABASE_JS || version} (index.html names ${version}), key ${KEY.slice(0, 15)}…` +
    (EXPIRED ? ', session access token EXPIRED (refresh tokens rotate)' : ''));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kt-storage-auth-')), args: ['--no-first-run'] });
  const page = await browser.newPage();
  const seen = [], refreshes = [], usedRefresh = new Set();
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.host === 'dash.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const body = rel === 'index.html' ? html : (fs.existsSync(path.join(ROOT, 'dashboard', rel)) ? fs.readFileSync(path.join(ROOT, 'dashboard', rel)) : null);
      if (body === null) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.html') ? 'text/html' : 'text/javascript', body });
    }
    if (!u.host.endsWith('.supabase.co')) return req.continue();      // the CDN, fonts
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: {
      'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const h = req.headers();
    seen.push({ path: u.pathname, method: req.method(), auth: h.authorization || '', apikey: h.apikey || '' });
    const json = (o, s) => req.respond({ status: s || 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: UID, aud: 'authenticated', role: 'authenticated', email: 'artist@example.invalid' });
    if (u.pathname.startsWith('/auth/v1/token')) {
      const rt = (JSON.parse(req.postData() || '{}').refresh_token) || '';
      refreshes.push(rt);
      if (usedRefresh.has(rt)) return json({ error: 'invalid_grant', error_code: 'refresh_token_already_used',
        error_description: 'Invalid Refresh Token: Already Used' }, 400);
      usedRefresh.add(rt);
      const n = refreshes.length, e2 = Math.floor(Date.now() / 1000) + 3600;
      return json({ access_token: jwt(e2, n), refresh_token: 'r' + n, token_type: 'bearer', expires_in: 3600, expires_at: e2,
        user: { id: UID, aud: 'authenticated', role: 'authenticated', email: 'artist@example.invalid' } });
    }
    if (u.pathname.startsWith('/auth/v1/')) return json({});
    if (u.pathname.startsWith('/storage/v1/object')) return json({ Key: 'flash/x', Id: 'x' });
    if (u.pathname.startsWith('/rest/v1/artists') && u.search.includes('auth_user_id')) {
      return json({ id: ARTIST, name: 'Naomi', role: 'artist', active: true, kiosk_visible: true, auth_user_id: UID,
                    tutorial_seen: [], tutorial_snoozed: [], tutorial_seen_at: new Date().toISOString() });
    }
    return json([]);
  });
  // A signed-in session, as supabase-js stores it after a magic link; and a
  // hook that keeps every client the page creates.
  if (process.env.KT_RACE === '1') await page.evaluateOnNewDocument(() => { window.__ktRace = true; });
  await page.evaluateOnNewDocument((ref, jwt, uid, exp) => {
    localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify({
      access_token: jwt, refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: exp,
      user: { id: uid, aud: 'authenticated', role: 'authenticated', email: 'artist@example.invalid' } }));
    window.__clients = [];
    let real;
    Object.defineProperty(window, 'supabase', { configurable: true,
      get() { return real; },
      set(v) { real = v; const cc = v.createClient;
        v.createClient = function () { const c = cc.apply(this, arguments); window.__clients.push(c); return c; }; } });
    // KT_RACE=1: DashClient adopts the (expired) session the moment the page
    // boots, alongside app.js — as an early tour/view-as call on a slow phone does.
    if (window.__ktRace) document.addEventListener('DOMContentLoaded', () => {
      if (window.DashClient) window.DashClient.client();
    }, { capture: true });
  }, ref, USER_JWT, UID, exp);

  await page.goto('http://dash.test/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 4000));   // let view-as, the tour and the menu adopt the session too
  const who = await page.evaluate(() => (document.getElementById('whoName') || {}).textContent + ' · ' +
                                        (document.getElementById('whoRole') || {}).textContent);
  check('the dashboard signs in as the artist (stubbed session)', /Naomi · Artist/.test(who), who);

  // Exercise exactly what the dashboard calls: app.js's client (uploads,
  // flash-sales) and DashClient's (avatar upload, list, remove).
  await page.evaluate(async (artist) => {
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    window.__results = [];
    for (const [i, c] of window.__clients.entries()) {
      await c.from('artists').select('*').eq('auth_user_id', 'x').maybeSingle();
      await c.storage.from('flash').upload(`${artist}/probe-${i}/original.png`, blob, { upsert: false });
    }
    window.__clientCount = window.__clients.length;
    window.__freshOk = window.DashClient.fresh ? !!(await window.DashClient.fresh()) : null;
    if (window.__freshOk) {   // the write path: a token issued just now
      await (await window.DashClient.fresh()).storage.from('flash').upload(`${artist}/after-fresh/original.png`, blob, { upsert: false });
    }
    const dc = await window.DashClient.client();
    if (dc) {
      await dc.storage.from('avatars').upload(`${artist}/avatar-probe.webp`, blob, { upsert: true });
      await dc.storage.from('avatars').list(artist, { limit: 100 });
      await dc.storage.from('avatars').remove([`${artist}/old.webp`]);
    }
  }, ARTIST);
  const clientCount = await page.evaluate(() => window.__clientCount);
  const freshOk = await page.evaluate(() => window.__freshOk);
  await browser.close();

  const userAuth = null;
  const storage = seen.filter(s => s.path.startsWith('/storage/v1/object'));
  const rest = seen.filter(s => s.path.startsWith('/rest/v1/'));
  const label = a => isUserToken(a) ? "the artist's token" : a === 'Bearer ' + KEY ? 'the PUBLIC KEY (anon)' : (a ? a.slice(0, 22) + '…' : 'none');
  if (refreshes.length) console.log(`     refresh-token uses: ${refreshes.map(r => r || '(none)').join(', ')}` +
    `  (${refreshes.length - usedRefresh.size} refused as already used)`);
  storage.forEach(s => console.log(`     ${s.method} ${s.path.replace(ARTIST, '<artist>')} → ${label(s.auth)}`));
  check('database calls carry the artist\'s token', rest.length > 0 && rest.every(s => isUserToken(s.auth)),
    [...new Set(rest.map(s => label(s.auth)))].join(', '));
  check('every storage request was seen (uploads, avatar upload, list, remove)', storage.length >= 5, storage.length + ' seen');
  check('EVERY storage request carries the artist\'s token, never the public key',
    storage.length > 0 && storage.every(s => isUserToken(s.auth)),
    storage.filter(s => !isUserToken(s.auth)).map(s => s.method + ' ' + s.path.replace(ARTIST, '<artist>') + ' → ' + label(s.auth)).join('; '));

  check('ONE auth client on the page (no second client racing for the refresh token)', clientCount === 1,
    clientCount + ' clients');
  check('no refresh token was ever refused as already used', refreshes.length === usedRefresh.size,
    refreshes.join(', '));
  check('DashClient.fresh() gets a newly issued token before writes', freshOk === true, String(freshOk));
  const afterFresh = storage.find(x => x.path.includes('/after-fresh/'));
  const nOf = a => { try { return JSON.parse(Buffer.from(a.replace(/^Bearer /, '').split('.')[1], 'base64url')).n; } catch (e) { return null; } };
  check('...and the upload after it carries that NEW token', !!afterFresh && isUserToken(afterFresh.auth) && nOf(afterFresh.auth) > 0,
    afterFresh ? 'token #' + nOf(afterFresh.auth) : 'no upload seen');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
