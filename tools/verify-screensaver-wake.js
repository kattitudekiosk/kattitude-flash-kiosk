/* tools/verify-screensaver-wake.js — a tap on the screensaver goes straight to
 * the splash, with nothing in between, and stops there.
 *
 * Joshua, 3 Oct 2026: "when i click on the screensaver the screen briefly
 * goes back to the kiosk screen instead of straight to the start page".
 *
 * Boots index.html in jsdom with the 2-minute idle timer compressed, lets the
 * screensaver start, wakes it with a mouse-style tap (the wall's Touch Up
 * driver sends mouse events), and records the ORDER of what changed. The
 * splash must be fully shown — not hidden, no fade-in — before the
 * screensaver comes down underneath it. A second tap straight after must not
 * walk past the splash; a tap after the guard window must enter normally.
 *
 *   JSDOM_PATH=<dir>/node_modules/jsdom node tools/verify-screensaver-wake.js
 *   KT_SCRIPT=<path to another script.js>   (negative control)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(__dirname, '..');
setTimeout(() => { console.error('verify-screensaver-wake.js: timed out'); process.exit(2); }, 30000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const w = dom.window, d = w.document;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  w.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1080, bottom: 1920, width: 1080, height: 1920, x: 0, y: 0 });

  // The idle timeout is two minutes; compress anything that long to 30ms.
  const realSetTimeout = w.setTimeout.bind(w);
  w.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, ms >= 60000 ? 30 : ms, ...a);

  const scriptJs = process.env.KT_SCRIPT || path.join(ROOT, 'script.js');
  // One eval, as the page has one global scope: data.js's top-level const
  // must be visible to the scripts after it.
  const order = ['assets/lib/qrcode.js', 'config.js', 'data.js', 'catalog.js', 'gallery.js', 'screensaver.js'];
  w.eval(order.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8') +
      (f === 'config.js' ? '\n;window.KIOSK_CONFIG.catalogSource = "sheets-only";\n' : '')).join('\n') +
    '\n' + fs.readFileSync(scriptJs, 'utf8'));
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await wait(80);

  const splash = d.getElementById('splash');
  const tap = (target) => {
    const e = new w.Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'pointerType', { value: 'mouse' });
    target.dispatchEvent(e);
  };

  check('the kiosk opens on the splash', !splash.classList.contains('hidden'));
  tap(splash);
  check('a tap on the splash enters', splash.classList.contains('hidden'));

  await wait(200);   // idle (compressed) → screensaver
  check('after idle the screensaver is running', d.body.classList.contains('screensaver'));

  /* Record, in order, every class change on the splash and the body, plus
   * the moment the reel is stopped, during the wake tap. */
  const log = [];
  const shown = () => !splash.classList.contains('hidden');
  const instant = () => splash.classList.contains('instant');
  const mo = new w.MutationObserver(recs => recs.forEach(r => log.push(
    (r.target === splash ? 'splash' : 'body') + ':' + r.target.className)));
  mo.observe(splash, { attributes: true, attributeFilter: ['class'] });
  mo.observe(d.body, { attributes: true, attributeFilter: ['class'] });
  let splashAtBodyChange = null;
  const origRemove = w.DOMTokenList.prototype.remove;
  w.DOMTokenList.prototype.remove = function (...tokens) {
    if (this === d.body.classList && tokens.includes('screensaver') && splashAtBodyChange === null) {
      splashAtBodyChange = { shown: shown(), instant: instant() };
    }
    return origRemove.apply(this, tokens);
  };

  tap(d.body);   // the wake tap
  w.DOMTokenList.prototype.remove = origRemove;
  await wait(0);
  mo.disconnect();

  check('the wake tap ends the screensaver', !d.body.classList.contains('screensaver'));
  check('the splash is showing straight after the wake tap', shown());
  check('the splash was ALREADY showing when the screensaver came down underneath it',
    splashAtBodyChange && splashAtBodyChange.shown, JSON.stringify(splashAtBodyChange) + ' order: ' + log.join(' → '));
  check('...with its fade-in switched off (no see-through frames)',
    splashAtBodyChange && splashAtBodyChange.instant, JSON.stringify(splashAtBodyChange));
  check('the first change on screen is the splash appearing, not the kiosk',
    log.length > 0 && log[0].startsWith('splash:') && !/\bhidden\b/.test(log[0]), log.join(' → '));

  // The same physical tap arriving twice must not walk past the splash.
  tap(splash);
  check('a second event from the same tap does NOT enter past the splash', shown());

  await wait(120);
  check('the fade is switched back on afterwards', !instant());

  await wait(600);   // past the guard window: a real next tap
  tap(splash);
  check('a real tap after that enters the gallery as normal', !shown());

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
