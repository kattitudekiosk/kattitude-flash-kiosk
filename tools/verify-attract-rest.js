/* tools/verify-attract-rest.js — 3 passes, then the splash, 3 minutes' rest,
 * then the screensaver again.
 *
 * Joshua, 17 Oct 2026: "after 3 cycles of flash sheets it goes back to the
 * home screen so people can know they can interact with it. let it rest there
 * for three minutes before it goes back to the screensaver" — 3 FULL passes
 * through the whole playlist.
 *
 * Boots index.html's scripts in jsdom on a FAKE CLOCK (every setTimeout,
 * setInterval and Date.now is ours), so 3 passes and 3 minutes take
 * milliseconds and every boundary is checked to the step: just before it,
 * nothing has happened; just after, it has.
 *
 *   JSDOM_PATH=<dir>/node_modules/jsdom node tools/verify-attract-rest.js
 *   VERIFY_ATTRACT_PASSES=0   (negative control: loops forever; must fail)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(__dirname, '..');
setTimeout(() => { console.error('verify-attract-rest.js: timed out'); process.exit(2); }, 60000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window, d = w.document;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1080, bottom: 1920, width: 1080, height: 1920, x: 0, y: 0 });

  /* ── the fake clock ── */
  let now = Date.UTC(2026, 9, 17, 12), seq = 1;
  const q = [];
  w.setTimeout = (fn, ms, ...a) => { q.push({ id: seq, at: now + (+ms || 0), fn, a }); return seq++; };
  w.setInterval = (fn, ms) => { q.push({ id: seq, at: now + ms, fn, a: [], every: ms }); return seq++; };
  w.clearTimeout = w.clearInterval = id => { const k = q.findIndex(t => t.id === id); if (k >= 0) q.splice(k, 1); };
  w.requestAnimationFrame = cb => w.setTimeout(() => cb(now), 16);
  w.Date.now = () => now;
  // Images "load" on the next tick of the fake clock (jsdom fetches none).
  w.Image = function () { const o = {}; Object.defineProperty(o, 'src', { set() { w.setTimeout(() => o.onload && o.onload(), 0); } }); return o; };
  const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setImmediate(r)); };
  const advance = async ms => {
    const end = now + ms;
    for (;;) {
      await flush();
      q.sort((x, y) => x.at - y.at || x.id - y.id);
      const t = q[0];
      if (!t || t.at > end) break;
      now = t.at;
      if (t.every) t.at += t.every; else q.shift();
      t.fn(...t.a);
    }
    now = end;
    await flush();
  };
  /* Step the clock until pred() holds; returns the fake time it first held,
   * or null after maxMs. 50 ms resolution — every boundary below is checked
   * 100 ms either side of where it must fall. */
  const advanceUntil = async (pred, maxMs) => {
    const end = now + maxMs;
    while (now < end) { if (pred()) return now; await advance(50); }
    return pred() ? now : null;
  };

  const order = ['assets/lib/qrcode.js', 'config.js', 'data.js', 'catalog.js', 'gallery.js', 'screensaver.js', 'script.js'];
  const passesOverride = process.env.VERIFY_ATTRACT_PASSES;
  w.eval(order.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8') +
      (f === 'config.js' ? '\n;window.KIOSK_CONFIG.catalogSource = "sheets-only";' +
        (passesOverride != null ? `window.KIOSK_CONFIG.screensaver.passes = ${+passesOverride};` : '') + '\n' : '')).join('\n'));
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await advance(50);

  const C = w.KIOSK_CONFIG.screensaver, STILL = C.stillMs, REST = C.splashRestMs, IDLE = 120000;
  const splash = d.getElementById('splash');
  const onSplash = () => !splash.classList.contains('hidden');
  const saver = () => d.body.classList.contains('screensaver');
  const tap = target => {
    const e = new w.Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    (target || d.body).dispatchEvent(e);
  };
  const S = w.Screensaver;
  const N = S.playlistLength();
  const savedPos = () => JSON.parse(w.localStorage.getItem('kt-attract-v1') || '{}').pos;
  const T = [];   // the timeline, for the report
  const at0 = now; const stamp = label => T.push(`${((now - at0) / 1000).toFixed(1).padStart(7)}s  ${label}`);

  console.log(`config: passes ${C.passes}, splashRestMs ${REST}, stillMs ${STILL}; playlist ${N} items`);
  check('the numbers are config values (passes 3, splashRestMs 180000)', passesOverride != null || (C.passes === 3 && REST === 180000));
  check('there is a playlist to play', N > 1, String(N));

  console.log('\nboot: the splash rests 3 minutes, then the screensaver');
  check('boot shows the splash', onSplash() && !saver()); stamp('boot: splash');
  await advance(REST - 100);
  check('...still the splash 0.1s before 3 minutes', onSplash() && !saver());
  await advance(200);
  check('...the screensaver at 3 minutes', saver() && S.isActive()); stamp('screensaver starts (from the splash)');

  console.log('\na tap on the screensaver: straight to the splash, no fall-through');
  tap(); await advance(10);
  check('the tap shows the splash and ends the screensaver', onSplash() && !saver() && !S.isActive()); stamp('tap → splash');
  tap(splash); await advance(10);
  check('a second event from the same touch does not walk past the splash', onSplash());
  await advance(600); tap(splash); await advance(10);
  check('a real tap on the splash enters', !onSplash()); stamp('tap → enters the gallery');

  console.log('\nbrowsing: 2 minutes idle → screensaver; then 3 full passes → the splash');
  const entered = now;
  await advance(IDLE - 100);
  check('in the gallery, no screensaver 0.1s before 2 minutes idle (the splash rest is not armed in the gallery)', !saver() && !onSplash());
  const runStart = await advanceUntil(saver, 1000);
  check('2 minutes idle in the gallery starts the screensaver', runStart != null && runStart - entered <= IDLE + 100,
    runStart == null ? 'never' : `${(runStart - entered) / 1000}s`);
  stamp('idle 2 min → screensaver');
  // The first item is on screen and the position already saved one past it:
  // the run resumed from the one before.
  const startPos = (savedPos() - 1 + N) % N;
  const runMs = 3 * N * STILL;
  await advance(runStart + runMs - 100 - now);
  check(`still playing 0.1s before the end of pass 3 (${(runMs / 1000).toFixed(0)}s = 3 × ${N} × ${STILL / 1000}s)`, saver() && S.isActive(),
    `advanced ${S._advanced()}`);
  check('...having shown exactly 3 × the playlist', S._advanced() === 3 * N, `${S._advanced()} vs ${3 * N}`);
  await advance(200);
  check('after 3 full passes: the "tap anywhere to enter" splash', onSplash() && !saver() && !S.isActive()); stamp(`3 passes done (${3 * N} items) → splash`);
  check('...the start page, not the gallery behind it', onSplash() && !d.body.classList.contains('screensaver'));
  check('...and the saved position is where the run began (3 whole passes)', savedPos() === startPos, `${savedPos()} vs ${startPos}`);
  const splashAt = runStart + runMs;

  console.log('\nthe rest: 3 minutes on the splash, then the screensaver resumes');
  await advance(splashAt + REST - 100 - now);
  check('still the splash 0.1s before 3 minutes', onSplash() && !saver());
  await advance(200);
  check('the screensaver again at 3 minutes', saver() && S.isActive()); stamp('rest 3 min → screensaver resumes');
  check('...resuming at the saved position, not reshuffled', S._loop().pos === startPos || savedPos() === (startPos + 1) % N,
    `saved ${savedPos()}, started at ${startPos}`);

  console.log('\nany interaction resets the pass count');
  await advance(Math.round(1.5 * N) * STILL);                     // half way through pass 2
  check(`mid-run: ${S._advanced()} items in`, S._advanced() > N);
  tap(); await advance(10); stamp('tap mid-run (1.5 passes) → splash');
  check('the tap goes to the splash', onSplash() && !saver());
  const tappedAt = now;
  const run2 = await advanceUntil(saver, REST + 500);
  check('after a 3-minute rest the screensaver starts again', run2 != null && Math.abs(run2 - tappedAt - REST) <= 100,
    run2 == null ? 'never' : `${(run2 - tappedAt) / 1000}s`);
  stamp('rest 3 min → screensaver');
  await advance(3 * N * STILL - (now - run2) - 100);
  check('it plays 3 FULL passes again — the earlier 1.5 did not count', saver() && S._advanced() === 3 * N, `advanced ${S._advanced()}`);
  await advance(200);
  check('...then the splash', onSplash() && !saver()); stamp('3 passes → splash');

  console.log('\na reshuffle (designs added or removed) resets the pass count');
  const run3 = await advanceUntil(saver, REST + 500);
  await advance(2 * N * STILL);                                   // two passes in
  const realQuery = w.Catalog.query.bind(w.Catalog);
  w.Catalog.query = opts => realQuery(opts).concat([{ image: 'assets/new-sheet.jpg', title: '', artistId: 'new-artist', type: 'sheet' }]);
  const N2 = S.playlistLength();
  check(`a new design changes the playlist (${N} → ${N2})`, N2 === N + 1 || N2 > N, `${N2}`);
  await advance(STILL + 50);                                       // the next step sees the new fingerprint
  const reshuffledAt = now; stamp(`new design → reshuffle (${N2} items), count back to 0`);
  check('the loop reshuffled and restarted at the top, even though playlistLength() saw the change first',
    S._advanced() <= 1 && S._pos() <= 1, `advanced ${S._advanced()}, pos ${S._pos()}`);
  check('...and is still playing (2 old passes do not count towards the new 3)', saver());
  await advance(3 * N2 * STILL - (now - reshuffledAt) - 400);
  check('still playing 3 passes of the NEW playlist later, just before the end', saver(), `advanced ${S._advanced()} of ${3 * N2}`);
  await advance(STILL + 500);
  check('...then the splash', onSplash() && !saver()); stamp('3 passes of the new playlist → splash');
  void run3;

  console.log('\n' + T.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
