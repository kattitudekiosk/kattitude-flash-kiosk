/* tools/verify-qr.js — dump every QR the kiosk renders, as a bitmap matrix.
 *
 * Boots the kiosk in jsdom, walks to each artist's view, and writes the QR
 * module matrix the page actually produced to stdout as JSON. A separate
 * decoder (tools/verify-qr.py) reads that and decodes it with an independent
 * QR implementation, so the check is genuinely end-to-end: what the kiosk
 * drew, not what we intended it to draw.
 *
 *   node tools/verify-qr.js | python3 tools/verify-qr.py
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(__dirname, '..');

// jsdom keeps timers alive, so a stuck page would hang this forever. Never let it.
const HARD_TIMEOUT_MS = 30000;
setTimeout(() => {
  console.error(`verify-qr.js: timed out after ${HARD_TIMEOUT_MS / 1000}s`);
  process.exit(2);
}, HARD_TIMEOUT_MS).unref();

/* The "Browse on your phone" code drawn by script.js alone — the linear sheet
 * viewer a roster with no artists falls back to, before gallery.js exists. */
async function bareViewerQr(html) {
  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const w = dom.window;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  w.eval(['assets/lib/qrcode.js', 'config.js', 'data.js', 'script.js']
    .map(rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')).join('\n'));
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 50));
  const svg = w.document.querySelector('#qrBadge svg');
  const galleryUrl = w.KIOSK_CONFIG.galleryUrl;
  w.close();
  return svg ? { svg: svg.outerHTML, galleryUrl } : { error: 'no QR rendered', galleryUrl };
}

(async () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});

  const dom = new JSDOM(html, {
    url: 'http://localhost/', runScripts: 'outside-only',
    pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;

  window.HTMLElement.prototype.getBoundingClientRect = () =>
    ({ top: 0, left: 0, right: 1080, bottom: 1920, width: 1080, height: 1920, x: 0, y: 0 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { get: () => 1080 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight', { get: () => 1920 });
  window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  window.__KIOSK_TEST_ALLOW_SEED = true;   // harness only; pages never see seed

  const order = ['assets/lib/qrcode.js', 'config.js', 'data.js', 'seed/seed-data.js',
                 'catalog.js', 'gallery.js', 'script.js'];
  window.eval(order.map(rel => {
    const f = path.join(ROOT, rel);
    const src = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    // Harness only: placeholder roster so every artist has a code to decode.
    return rel === 'config.js' ? src + '\n;window.KIOSK_CONFIG.catalogSource = "seed";\n' : src;
  }).join('\n'));

  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 80));

  const doc = window.document;
  const gallery = doc.getElementById('gallery');
  const out = [];

  const artists = window.Catalog.snapshot().artists;
  for (const artist of artists) {
    if (window.Catalog.countForArtist(artist.id) === 0) continue;

    // Drive the real UI rather than calling the renderer directly — this has
    // to prove the code a customer sees, not a code we made in a test.
    // Artists now live one level in, behind the cover's "Browse by Artist".
    window.KIOSK_ROUTER.renderArtists();
    const card = [...gallery.querySelectorAll('.g-card-artist')]
      .find(c => c.textContent.indexOf(artist.name) !== -1
              && c.textContent.indexOf(artist.handle) !== -1);
    if (!card) { out.push({ artist: artist.name, error: 'card not found' }); continue; }
    card.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

    // A sheets-only artist skips the grid, so her code lives on the sheet
    // viewer's corner badge instead of an inline panel. Either is valid; what
    // matters is that every artist has a reachable, correct code.
    const badge = gallery.querySelector('.qr-badge.qr-inline')
      || (doc.body.classList.contains('mode-sheets') ? doc.getElementById('qrBadge') : null);
    if (!badge || !badge.querySelector('svg')) {
      out.push({ artist: artist.name, error: 'no QR rendered' });
      continue;
    }

    const svg = badge.querySelector('svg');
    const viewBox = svg.getAttribute('viewBox').split(' ');
    const n = parseInt(viewBox[2], 10);

    // The modules are rounded now, so the old trick of re-parsing
    // "M<x>,<y>h1v1h-1z" subpaths is dead — and it was never the right check
    // anyway. It reconstructed what we MEANT to draw. Ship the actual SVG
    // markup instead and let the Python side rasterise and decode it, so what
    // gets tested is the artwork a camera would see, rounded corners and all.
    const svgMarkup = svg.outerHTML;
    const modules = (svg.querySelector('path').getAttribute('d').match(/[Mm]/g) || []).length;

    out.push({
      artist: artist.name,
      handle: artist.handle,
      expected: artist.instagram,
      declared: badge.getAttribute('data-qr-url'),
      label: (gallery.querySelector('.g-artistinfo-handle')
              || doc.getElementById('qrCaption') || {}).textContent,
      size: n,
      darkModules: modules,
      svg: svgMarkup,
      // The real rendered box, so the raster is at true kiosk pixel scale.
      cssPx: badge.classList.contains('qr-inline') ? 260 : 138,
      padPx: badge.classList.contains('qr-inline') ? 28 : 15,
    });
  }

  // The cover, the artists page and the studio-wide grid must NOT carry an
  // artist QR — only an individual artist's own view does.
  window.KIOSK_ROUTER.goHome();
  const homeQr = !!gallery.querySelector('.qr-badge.qr-inline');
  gallery.querySelector('.g-mode-all')
    .dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  const allQr = !!gallery.querySelector('.qr-badge.qr-inline');
  const tileQr = !!gallery.querySelector('.g-tile .qr-badge');

  /* The studio-wide "Browse on your phone" codes. Both must open the phone
   * gallery named in config.js — never an artist, never an old address. */
  const galleryUrl = window.KIOSK_CONFIG.galleryUrl;
  const studio = [];
  const studioEntry = (surface, badge, caption, cssPx, padPx) => {
    const svg = badge && badge.querySelector('svg');
    if (!svg) return { artist: surface, error: 'no QR rendered' };
    return {
      artist: surface, studio: true, expected: galleryUrl,
      declared: badge.getAttribute('data-qr-url'), label: caption,
      size: parseInt(svg.getAttribute('viewBox').split(' ')[2], 10),
      svg: svg.outerHTML, cssPx, padPx,
    };
  };
  /* The Artists index: each card's own code must open that card's artist, and
   * no studio/follow badge may be stranded on the page. */
  window.KIOSK_ROUTER.renderArtists();
  const indexStrayBadge = !!gallery.querySelector('.qr-badge');
  const cards = [...gallery.querySelectorAll('.g-card-artist')].map(card => {
    const a = artists.find(x => card.textContent.indexOf(x.name) !== -1
                             && card.textContent.indexOf(x.handle) !== -1);
    const svg = card.querySelector('.g-card-qr svg');
    if (!a || !a.instagram) return null;
    if (!svg) return { artist: a.name + ' card', error: 'no card QR rendered' };
    return { artist: a.name + ' card', expected: a.instagram, svg: svg.outerHTML,
             size: parseInt(svg.getAttribute('viewBox').split(' ')[2], 10), cssPx: 180, padPx: 19 };
  }).filter(Boolean);

  window.KIOSK_ROUTER.goHome();
  gallery.querySelector('.g-mode-sheets')
    .dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 20));
  studio.push(studioEntry('Full Flash Sheets corner', doc.getElementById('qrBadge'),
    (doc.getElementById('qrCaption') || {}).textContent, 138, 15));

  const bare = await bareViewerQr(html);
  studio.push(bare.error ? { artist: 'no-artists sheet viewer', error: bare.error } : {
    artist: 'no-artists sheet viewer', studio: true, expected: bare.galleryUrl,
    label: 'Browse on your phone',
    size: parseInt(/viewBox="0 0 (\d+)/.exec(bare.svg)[1], 10), svg: bare.svg, cssPx: 138, padPx: 15,
  });

  process.stdout.write(JSON.stringify({
    codes: out,
    studio,
    cards,
    galleryUrl,
    scoping: { homeHasQr: homeQr, studioGridHasQr: allQr, tilesHaveQr: tileQr,
               artistsIndexHasStrayBadge: indexStrayBadge },
  }), () => process.exit(0));   // exit once flushed; jsdom's timers would keep node alive
})().catch(e => { console.error(e); process.exit(1); });
