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

  process.stdout.write(JSON.stringify({
    codes: out,
    scoping: { homeHasQr: homeQr, studioGridHasQr: allQr, tilesHaveQr: tileQr },
  }));
})().catch(e => { console.error(e); process.exit(1); });
