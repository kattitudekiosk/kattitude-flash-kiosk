/* tools/verify-dashboard.js — the hosted dashboard's sign-in and admin view.
 *
 * Runs dashboard/index.html's own scripts in jsdom against a STUB Supabase
 * client. Nothing goes over the network and nothing can ask for an email:
 * the stub's signInWithOtp records the call and answers with the error the
 * sign-in gate (db/kat-project/08) produces.
 *
 *   JSDOM_PATH=<dir>/node_modules/jsdom node tools/verify-dashboard.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(__dirname, '..');
setTimeout(() => { console.error('verify-dashboard.js: timed out'); process.exit(2); }, 30000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const UID = '872f6936-2509-43af-a605-0ca72d903f0a';
const KAT = { id: 'kat', name: 'Kat', role: 'admin', active: true, kiosk_visible: true, display_order: 0 };
const JEN = { id: 'jen', name: 'Jen', role: 'artist', active: true, kiosk_visible: true, display_order: 3 };

/* signedIn: the card the session resolves to, or null for the sign-in screen.
 * otpError: what signInWithOtp answers. */
async function boot({ card, otpError }) {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'https://kattitude-flash-kiosk.vercel.app/dashboard/',
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window;
  const otp = [];
  const roster = card ? [KAT, JEN, card] : [];
  const q = (table) => {
    const f = {}, s = {};
    ['select', 'order', 'in', 'is', 'limit', 'neq', 'gte', 'lte', 'range', 'filter', 'update', 'insert', 'delete']
      .forEach(m => { s[m] = () => s; });
    s.eq = (k, v) => { f[k] = v; return s; };
    s.maybeSingle = s.single = () => ({ then: ok => Promise.resolve({
      data: card && f.auth_user_id === UID ? card : null, error: null }).then(ok) });
    s.then = ok => Promise.resolve({ data: table === 'artists' ? roster : [], error: null }).then(ok);
    return s;
  };
  const session = card ? { access_token: 't', user: { id: UID, email: 'test@example.invalid' } } : null;
  w.supabase = { createClient: () => ({
    from: q, rpc: async () => ({ data: null, error: null }),
    channel: () => { const c = { on: () => c, subscribe: () => c }; return c; }, removeChannel() {},
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), getPublicUrl: () => ({ data: { publicUrl: '' } }) }) },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session && session.user }, error: null }),
      onAuthStateChange: cb => { if (session) setTimeout(() => cb('SIGNED_IN', session), 0);
                                 return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async a => { otp.push(a.email); return { data: null, error: otpError ? { message: otpError } : null }; },
      signOut: async () => ({ error: null }),
    },
  }) };
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]).filter(s => !/^https?:/.test(s));
  const errors = [];
  for (const f of scripts) {
    try { w.eval(fs.readFileSync(path.join(ROOT, 'dashboard', f), 'utf8')); } catch (e) { errors.push(f + ': ' + e.message); }
  }
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 800));
  return { w, d: w.document, otp, errors };
}

(async () => {
  console.log('admin view');
  const hidden = { id: 'joshua', name: 'Joshua', role: 'admin', active: true, kiosk_visible: false,
                   display_order: 999, auth_user_id: UID, tutorial_seen: [], tutorial_seen_at: '2026-10-03T21:45:00Z' };
  {
    const { d, errors } = await boot({ card: hidden });
    check('scripts load without errors', errors.length === 0, errors.join('; '));
    check('a hidden admin card signs in as Admin', d.getElementById('whoRole').textContent === 'Admin',
      d.getElementById('whoRole').textContent);
    const tabs = [...d.querySelectorAll('.tab.admin-only')].filter(t => !t.hidden).map(t => t.textContent);
    check('...with every admin tab', tabs.join(',') === 'Artists,Categories,Flash Sales,Review', tabs.join(','));
  }
  {
    const { d } = await boot({ card: Object.assign({}, hidden, { role: 'artist' }) });
    check('the same card as an artist gets no admin tabs (control)',
      d.getElementById('whoRole').textContent === 'Artist' &&
      [...d.querySelectorAll('.tab.admin-only')].every(t => t.hidden));
  }

  console.log('\nwhose card an upload is credited to');
  {
    const { w } = await boot({ card: hidden });
    const pick = w.DashHelpers && w.DashHelpers.defaultUploadArtist;
    check('helper is exposed', typeof pick === 'function');
    if (pick) {
      check('hidden admin → the first artist on the wall (Kat), never the hidden card',
        pick(hidden, [JEN, hidden, KAT], true) === 'kat');
      check('admin on the wall → their own card', pick(KAT, [KAT, JEN, hidden], true) === 'kat' &&
        pick(Object.assign({}, KAT, { id: 'k2', display_order: 5 }), [KAT, JEN], true) === 'k2');
      check('artist → always their own card', pick(JEN, [KAT, JEN], false) === 'jen');
      check('an inactive artist is never the default', pick(hidden,
        [Object.assign({}, KAT, { active: false }), JEN, hidden], true) === 'jen');
    }
  }

  console.log('\nsign-in gate message');
  for (const [err, want] of [
    ['Database error saving new user', /paused while Joshua tests/],
    ['Email rate limit exceeded', /^Email rate limit exceeded$/],
  ]) {
    const { d, otp } = await boot({ card: null, otpError: err });
    d.getElementById('email').value = 'someone@example.invalid';
    d.getElementById('sendLink').click();
    await new Promise(r => setTimeout(r, 300));
    const shown = d.getElementById('signinMsg').textContent;
    check(`"${err}" → ${want}`, otp.length === 1 && want.test(shown), shown);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
