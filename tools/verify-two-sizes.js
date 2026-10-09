/* tools/verify-two-sizes.js — the dashboard's two sizes, end to end.
 *
 * Joshua, 3 Oct 2026: "supposed to be two different sizes" … "Square sheets
 * can be both". SQUARE 2048×2048 (single design OR flash sheet, the artist
 * picks; default flash sheet) and TALL 2160×3840 (always a flash sheet).
 *
 * The real dashboard in headless Chrome, signed in as an artist, with every
 * *.supabase.co request answered here: nothing is stored, nothing reaches
 * Kat's project, no email. Real image files of each shape go through the
 * real file input; the toggles are clicked; "Publish all" is pressed; what
 * each designs row WOULD be saved as is recorded and checked. Then a square
 * design is switched between single and sheet in My Designs.
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-two-sizes.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));
const puppeteer = from('puppeteer-core');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
setTimeout(() => { console.error('verify-two-sizes.js: timed out'); process.exit(2); }, 120000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// Real images of each shape, made from the studio logo with sips.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-two-sizes-'));
const LOGO = path.join(ROOT, 'assets/brand/kattitude-logo-2026.png');
function make(name, w, h) {
  const out = path.join(TMP, name + '.png');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(h), String(w), LOGO, '--out', out], { stdio: 'ignore' });
  return out;
}
const FILES = {
  'square-big': make('square-big', 3000, 3000),     // → 2048×2048, artist picks
  'square-exact': make('square-exact', 2048, 2048), // as uploaded
  'tall-exact': make('tall-exact', 2160, 3840),     // sheet, as uploaded
  'scan': make('scan', 2550, 3300),                 // → 2160×2795 sheet
  'wide': make('wide', 4000, 3000),                 // → 2160×1620 sheet
  'square-small': make('square-small', 1500, 1500), // refused: needs 2048×2048
  'tall-small': make('tall-small', 1320, 1615),     // refused: needs 2160 wide / 3840 tall
};

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const UID = '00000000-0000-4000-8000-0000000000aa';
const ME = '9e767f86-c114-47b4-b7e4-78f780bbdc4f';
const exp = Math.floor(Date.now() / 1000) + 3600;
const JWT = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: UID, role: 'authenticated', aud: 'authenticated', exp }) + '.c2ln';

(async () => {
  const cfgSrc = fs.readFileSync(path.join(ROOT, 'dashboard/config.js'), 'utf8');
  const ref = new URL(cfgSrc.match(/supabaseUrl:\s*'([^']+)'/)[1]).hostname.split('.')[0];
  const inserts = [], patches = [];
  let myDesigns = [];

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kt-two-sizes-chrome-')), args: ['--no-first-run'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 430, height: 1400 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    const u = new URL(req.url());
    if (u.host === 'dash.test') {
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '') || 'index.html';
      const f = path.join(ROOT, 'dashboard', rel);
      if (!fs.existsSync(f)) return req.respond({ status: 404, body: '' });
      return req.respond({ status: 200, body: fs.readFileSync(f),
        contentType: rel.endsWith('.css') ? 'text/css' : rel.endsWith('.html') ? 'text/html' : 'text/javascript' });
    }
    if (!u.host.endsWith('.supabase.co')) return req.continue();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    const json = (o, s) => req.respond({ status: s || 200, contentType: 'application/json', headers: cors, body: JSON.stringify(o) });
    if (u.pathname.startsWith('/auth/v1/token')) return json({ access_token: JWT, refresh_token: 'r2', token_type: 'bearer',
      expires_in: 3600, expires_at: exp, user: { id: UID, aud: 'authenticated', role: 'authenticated' } });
    if (u.pathname.startsWith('/auth/v1/user')) return json({ id: UID, aud: 'authenticated', role: 'authenticated' });
    if (u.pathname.startsWith('/auth/v1/')) return json({});
    if (u.pathname.startsWith('/storage/v1/object')) return json({ Key: 'x' });
    if (u.pathname === '/rest/v1/designs' && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      inserts.push(body);
      return json(Object.assign({ id: 'new-' + inserts.length }, body), 201);
    }
    if (u.pathname === '/rest/v1/designs' && req.method() === 'PATCH') {
      patches.push({ q: u.search, body: JSON.parse(req.postData() || '{}') });
      return json([]);
    }
    if (u.pathname === '/rest/v1/designs') return json(myDesigns);
    if (u.pathname.startsWith('/rest/v1/artists') && u.search.includes('auth_user_id')) {
      return json({ id: ME, name: 'Naomi', role: 'artist', active: true, kiosk_visible: true, auth_user_id: UID,
                    tutorial_seen: [], tutorial_snoozed: [], tutorial_seen_at: new Date().toISOString() });
    }
    return json([]);
  });
  await page.evaluateOnNewDocument((ref, jwt, uid, exp) => {
    localStorage.setItem('sb-' + ref + '-auth-token', JSON.stringify({ access_token: jwt, refresh_token: 'r',
      token_type: 'bearer', expires_in: 3600, expires_at: exp, user: { id: uid, aud: 'authenticated', role: 'authenticated' } }));
  }, ref, JWT, UID, exp);

  await page.goto('http://dash.test/index.html', { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 1500));

  console.log('the rules');
  const plans = await page.evaluate(() => {
    const p = window.DashHelpers.plan, f = window.DashHelpers.fittedSize;
    return [[3000, 3000], [2048, 2048], [2049, 2040], [2160, 3840], [2550, 3300], [4000, 3000], [1500, 1500], [1320, 1615], [1500, 3840]]
      .map(([w, h]) => ({ w, h, ...p(w, h), out: f(w, h) }));
  });
  const P = (w, h) => plans.find(x => x.w === w && x.h === h);
  check('3000×3000 → square, default flash sheet, resized to 2048×2048',
    P(3000, 3000).shape === 'square' && P(3000, 3000).type === 'sheet' && P(3000, 3000).out.w === 2048 && P(3000, 3000).out.h === 2048);
  check('2049×2040 counts as square (within 1%) and fits inside 2048×2048',
    P(2049, 2040).shape === 'square' && P(2049, 2040).out.w <= 2048 && P(2049, 2040).out.h <= 2048);
  check('2160×3840 → flash sheet, as uploaded', P(2160, 3840).type === 'sheet' && P(2160, 3840).out.w === 2160 && P(2160, 3840).out.h === 3840);
  check('2550×3300 scan → flash sheet fitted inside 2160×3840 (2160×2795), shape kept',
    P(2550, 3300).type === 'sheet' && P(2550, 3300).out.w === 2160 && P(2550, 3300).out.h === 2795);
  check('4000×3000 wide → flash sheet 2160×1620', P(4000, 3000).out.w === 2160 && P(4000, 3000).out.h === 1620);
  check('1500×3840 narrow but full height → accepted (reaches the box), never enlarged',
    !P(1500, 3840).error && P(1500, 3840).out.w === 1500 && P(1500, 3840).out.h === 3840);
  check('1500×1500 refused, naming 2048×2048', /2048×2048/.test(P(1500, 1500).error || ''), P(1500, 1500).error);
  check('1320×1615 refused, naming 2160×3840', /2160×3840/.test(P(1320, 1615).error || ''), P(1320, 1615).error);

  console.log('\nstaging, toggles, upload');
  await page.click('.tab[data-view="upload"]').catch(() => {});
  const input = await page.$('#view-upload input[type="file"]');
  await input.uploadFile(...Object.values(FILES));
  await page.waitForFunction(n => document.querySelectorAll('#queue .card.item').length === n, { timeout: 20000 }, Object.keys(FILES).length);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#queue .card.item')].map(c => ({
    title: c.dataset.file.replace(/\.png$/, ''), name: c.querySelector('input.input').value,
    placeholder: c.querySelector('input.input').placeholder, bad: c.classList.contains('is-bad'),
    error: (c.querySelector('.error') || {}).textContent || null,
    toggle: !!c.querySelector('.type-toggle'), on: (c.querySelector('.type-opt.is-on') || {}).textContent || null,
    size: (c.querySelector('.size-note') || {}).textContent || null })));
  const card = t => cards.find(c => c.title === t) || {};
  // 9 Oct 2026: a file name is not a name. The field starts empty.
  check('every name field starts EMPTY (no title made from the file name), placeholder "Name (optional)"',
    cards.every(c => c.name === '' && c.placeholder === 'Name (optional)'), JSON.stringify(cards.map(c => [c.name, c.placeholder])));
  check('squares get the Single design / Flash sheet toggle, set to Flash sheet',
    card('square-big').toggle && card('square-big').on === 'Flash sheet' && card('square-exact').toggle);
  check('tall and other shapes get no toggle (always a flash sheet)',
    !card('tall-exact').toggle && !card('scan').toggle && !card('wide').toggle);
  check('the staged card says what it will be resized to', /3000×3000 → resized to 2048×2048/.test(card('square-big').size || ''), card('square-big').size);
  check('a too-small square is refused on its card, naming 2048×2048',
    card('square-small').bad && /2048×2048/.test(card('square-small').error || ''), card('square-small').error);
  check('a too-small tall file is refused on its card', card('tall-small').bad, card('tall-small').error);
  const setAll = await page.$('#queue .set-all');
  check('a "set all squares" control appears', !!setAll);

  // Set ALL squares to single, then put the exact square back to a sheet.
  await page.evaluate(() => document.querySelector('#queue .set-all .type-opt[data-type="design"]').click());
  const afterAll = await page.evaluate(() => [...document.querySelectorAll('#queue .card.item')]
    .filter(c => c.querySelector('.type-toggle')).map(c => (c.querySelector('.type-opt.is-on') || {}).textContent));
  check('"set all" makes every square a single design', afterAll.length === 2 && afterAll.every(t => t === 'Single design'), afterAll.join());
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#queue .card.item')].find(x => x.dataset.file === 'square-exact.png');
    c.querySelector('.type-opt[data-type="sheet"]').click();
  });
  // The artist names ONE file; the rest stay unnamed.
  await page.evaluate(() => {
    const inp = [...document.querySelectorAll('#queue .card.item')].find(x => x.dataset.file === 'square-big.png').querySelector('input.input');
    inp.value = '  Rose sheet  '; inp.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // What My Designs will list when the dashboard reloads it after this upload.
  myDesigns = [
    { id: 'sq-1', artist_id: ME, title: 'Square sheet', type: 'sheet', width: 2048, height: 2048, published: true, approved: true, display_order: 0, design_categories: [] },
    { id: 'tall-1', artist_id: ME, title: 'Tall sheet', type: 'sheet', width: 2160, height: 3840, published: true, approved: true, display_order: 0, design_categories: [] },
  ];
  const pub = await page.evaluateHandle(() => [...document.querySelectorAll('#queue button')].find(b => b.textContent === 'Publish all'));
  await pub.click();
  await page.waitForFunction(() => !document.querySelector('#queue .card.item:not(.is-bad)'), { timeout: 30000 }).catch(() => {});
  // Found by what was saved, not by title: only one design has a name now.
  const ins = t => ({
    'square big': inserts.find(i => i.title === 'Rose sheet'),
    'square exact': inserts.find(i => i.width === 2048 && i.type === 'sheet'),
    'tall exact': inserts.find(i => i.height === 3840),
    'scan': inserts.find(i => i.height === 2795),
    'wide': inserts.find(i => i.height === 1620),
  }[t] || {});
  check('only the name the artist typed is saved (trimmed); every other design is saved with NO title',
    inserts.filter(i => i.title).map(i => i.title).join() === 'Rose sheet' && inserts.filter(i => i.title === null).length === 4,
    JSON.stringify(inserts.map(i => i.title)));
  check('5 good files uploaded, the 2 small ones not', inserts.length === 5, inserts.map(i => i.title).join(', '));
  check('square-big saved as a SINGLE design, 2048×2048',
    ins('square big').type === 'design' && ins('square big').width === 2048 && ins('square big').height === 2048, JSON.stringify(ins('square big')));
  check('square-exact saved as a flash SHEET, 2048×2048 (square sheets exist)',
    ins('square exact').type === 'sheet' && ins('square exact').width === 2048, JSON.stringify(ins('square exact')));
  check('tall-exact saved as a sheet, 2160×3840', ins('tall exact').type === 'sheet' && ins('tall exact').height === 3840);
  check('scan saved as a sheet, 2160×2795', ins('scan').type === 'sheet' && ins('scan').width === 2160 && ins('scan').height === 2795, JSON.stringify(ins('scan')));
  check('wide saved as a sheet, 2160×1620', ins('wide').type === 'sheet' && ins('wide').width === 2160 && ins('wide').height === 1620, JSON.stringify(ins('wide')));

  console.log('\nMy Designs: switch a square afterwards');
  await page.click('.tab[data-view="designs"]');
  await new Promise(r => setTimeout(r, 1200));
  const dcards = await page.evaluate(() => [...document.querySelectorAll('#view-designs .card.design')].map(c => ({
    title: c.querySelector('.design-title').textContent, toggle: !!c.querySelector('.type-toggle') })));
  check('a square design has the Single/Sheet switch; a tall one does not',
    (dcards.find(c => c.title === 'Square sheet') || {}).toggle === true && (dcards.find(c => c.title === 'Tall sheet') || {}).toggle === false,
    JSON.stringify(dcards));
  await page.evaluate(() => {
    const c = [...document.querySelectorAll('#view-designs .card.design')].find(x => /Square sheet/.test(x.textContent));
    c.querySelector('.type-opt[data-type="design"]').click();
  });
  await new Promise(r => setTimeout(r, 800));
  check('switching it saves type = design for that design only',
    patches.length === 1 && patches[0].body.type === 'design' && /id=eq\.sq-1/.test(patches[0].q), JSON.stringify(patches));

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
