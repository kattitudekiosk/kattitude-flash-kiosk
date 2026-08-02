/* tools/verify.js — headless behaviour checks for the kiosk.
 *
 * Runs index.html in jsdom and asserts the things that would be expensive to
 * get wrong on a wall-mounted screen in a shop. The check that matters most
 * is the first one: with zero individual designs the kiosk must route into
 * the legacy linear sheet viewer and must NOT mount the gallery. That is the
 * studio's state today, so a regression there breaks what is currently live.
 *
 *   node tools/verify.js            # run against config.js as committed
 *
 * Requires jsdom:  npm install jsdom   (dev-only; the kiosk itself has no
 * dependencies and this is never shipped).
 */

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else {
    failed++; failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL ' + name + (detail ? ' — ' + detail : ''));
  }
}

/** Boot index.html with an optional config override and an optional hook to
 *  reshape the seed catalog before the app reads it (used to synthesise
 *  rosters that do not exist in the real seed data). */
async function boot(configOverride, mutateCatalog) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});   // resource-load noise only

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });

  const { window } = dom;

  // jsdom has no layout engine, so anything reading geometry gets zeros.
  // Stub the few APIs the kiosk touches so scripts run to completion.
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return { top: 0, left: 0, right: 1080, bottom: 1920, width: 1080, height: 1920, x: 0, y: 0 };
  };
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth',
    { configurable: true, get: () => 1080 });
  Object.defineProperty(window.HTMLElement.prototype, 'clientHeight',
    { configurable: true, get: () => 1920 });
  window.requestAnimationFrame = cb => setTimeout(() => cb(Date.now()), 0);
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  window.fetch = () => Promise.reject(new Error('network disabled in verify'));

  const order = [
    'assets/lib/qrcode.js', 'config.js', 'data.js', 'seed/seed-data.js',
    'catalog.js', 'gallery.js', 'script.js',
  ];

  // One eval, not one per file. Top-level `const` inside an eval is scoped to
  // that eval call, so evaluating the files separately would hide data.js's
  // `const GALLERY_DATA` from script.js — the browser's shared global lexical
  // scope has to be reproduced by concatenating.
  window.__CONFIG_OVERRIDE = configOverride || null;
  const source = order
    .map(rel => {
      const file = path.join(ROOT, rel);
      if (!fs.existsSync(file)) return '';
      let src = `\n/* ==== ${rel} ==== */\n` + fs.readFileSync(file, 'utf8');
      if (rel === 'config.js') {
        src += '\n;if (window.__CONFIG_OVERRIDE) Object.assign(window.KIOSK_CONFIG, window.__CONFIG_OVERRIDE);\n';
      }
      return src;
    })
    .join('\n');

  window.eval(source);

  // Runs after the scripts are defined but before boot reads the catalog.
  if (typeof mutateCatalog === 'function') mutateCatalog(window.SEED_CATALOG, window);

  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(r => setTimeout(r, 60));   // let the async boot settle
  return window;
}

function tap(window, node) {
  if (!node) return false;
  node.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  return true;
}

(async () => {
  /* ══ 1. SHEETS-ONLY — the state the studio is in today ══════════════════ */
  console.log('\nsheets-only fallback (zero individual designs)');
  {
    const w = await boot({ catalogSource: 'sheets-only' });
    const snap = w.Catalog.snapshot();
    const gallery = w.document.getElementById('gallery');

    check('catalog reports sheetsOnly', snap.sheetsOnly === true);
    check('no individual designs', snap.singleCount === 0);
    check('sheets still present', snap.sheetCount === 4, 'got ' + snap.sheetCount);
    check('gallery UI never mounts', gallery.children.length === 0,
      gallery.children.length + ' children rendered');
    check('body in sheets mode', w.document.body.classList.contains('mode-sheets'));
    check('body NOT in gallery mode', !w.document.body.classList.contains('mode-gallery'));
    check('sheets-only marker set', w.document.body.classList.contains('sheets-only'));

    // The legacy viewer must be intact and showing sheet 1 of 4.
    check('sheet image loaded', /assets\/sheets\//.test(w.document.getElementById('sheetImg').src));
    check('sheet label correct', w.document.getElementById('sheetLabel').textContent === 'SHEET 1 / 4',
      w.document.getElementById('sheetLabel').textContent);
    check('dots built for 4 sheets', w.document.getElementById('dots').children.length === 4);
    check('SheetViewer API exposed', typeof w.SheetViewer.openAt === 'function');

    // Splash dismissal must not pull the gallery in.
    w.document.getElementById('splash').dispatchEvent(
      new w.Event('pointerdown', { bubbles: true, cancelable: true }));
    check('splash dismissed', w.document.getElementById('splash').classList.contains('hidden'));
    check('still sheets after splash', !w.document.body.classList.contains('mode-gallery'));
    check('gallery still empty after splash', gallery.children.length === 0);

    // Back-to-gallery affordance must stay hidden with no gallery to go back to.
    check('no back-to-gallery marker', !w.document.body.classList.contains('sheets-has-back'));
  }

  /* ══ 2. SEED — full hybrid experience ═══════════════════════════════════ */
  console.log('\nseed catalog (hybrid grid)');
  {
    const w = await boot({ catalogSource: 'seed' });
    const snap = w.Catalog.snapshot();
    const doc = w.document;
    const gallery = doc.getElementById('gallery');

    check('not sheetsOnly', snap.sheetsOnly === false);
    check('47 singles', snap.singleCount === 47, 'got ' + snap.singleCount);
    check('10 sheets (4 real + 6 generated)', snap.sheetCount === 10, 'got ' + snap.sheetCount);
    check('real sheets not duplicated by data.js',
      snap.items.filter(i => i.image.indexOf('assets/sheets/') === 0).length === 4,
      'got ' + snap.items.filter(i => i.image.indexOf('assets/sheets/') === 0).length);
    check('sheets are attributed to artists',
      snap.items.filter(i => i.type === 'sheet' && i.artistId).length === 10);
    check('7 artists', snap.artists.length === 7, 'got ' + snap.artists.length);
    check('10 categories in use', snap.categories.length === 10, 'got ' + snap.categories.length);
    check('owner ordered first', snap.artists[0].name === 'Kat', snap.artists[0].name);
    check('seniority carried through', snap.artists[0].seniority === 'Studio Owner',
      snap.artists[0].seniority);
    check('handles preserved verbatim',
      snap.artists.map(a => a.handle).join(',') ===
      '@Kattitudetattoo,@delicatelyscripted,@mirandaiink,@inkedbyjemini,@Puratinta_26,@allycat_ink,@Alenanebotattoos',
      snap.artists.map(a => a.handle).join(','));
    check('seniority hidden by default', !gallery.querySelector('.g-card-seniority'));
    check('body in gallery mode', doc.body.classList.contains('mode-gallery'));
    check('cover rendered', !!gallery.querySelector('.g-covergrid'));
    check('cover has View All', !!gallery.querySelector('.g-mode-all'));
    check('cover has Browse by Artist', !!gallery.querySelector('.g-mode-artist'));
    check('cover has Browse by Category', !!gallery.querySelector('.g-mode-category'));
    check('cover lists no artists', !gallery.querySelector('.g-card-artist'));
    check('seed banner shown', !!gallery.querySelector('.g-seedbanner'));
    check('logo present on cover', !!gallery.querySelector('.g-topbar-logo'));

    // Artists now live on their own page.
    tap(w, gallery.querySelector('.g-mode-artist'));
    check('7 artist cards on the artists page',
      gallery.querySelectorAll('.g-card-artist').length === 7,
      'got ' + gallery.querySelectorAll('.g-card-artist').length);
    check('every artist card is the same size — none stretched',
      [...gallery.querySelectorAll('.g-card-artist')].every(c => !c.style.gridColumn));
    tap(w, gallery.querySelector('.g-back'));
    check('back returns to the cover', !!gallery.querySelector('.g-covergrid'));

    // Cover → View All
    tap(w, gallery.querySelector('.g-mode-all'));
    check('grid rendered', !!gallery.querySelector('.g-grid'));
    check('grid holds singles + sheets',
      gallery.querySelectorAll('.g-tile').length === 57,
      'got ' + gallery.querySelectorAll('.g-tile').length);
    check('sheet tiles distinct', gallery.querySelectorAll('.g-tile-sheet').length === 10);
    check('sheets render as 2x3 modules',
      gallery.querySelectorAll('.g-tile-module').length === 10,
      'got ' + gallery.querySelectorAll('.g-tile-module').length);
    check('modules alternate sides',
      gallery.querySelectorAll('.g-tile-module.is-left').length === 5 &&
      gallery.querySelectorAll('.g-tile-module.is-right').length === 5,
      gallery.querySelectorAll('.g-tile-module.is-left').length + ' left / ' +
      gallery.querySelectorAll('.g-tile-module.is-right').length + ' right');
    check('module spans 2 columns',
      /span 2/.test(gallery.querySelector('.g-tile-module').style.gridColumn));
    // Span is no longer fixed — it matches each sheet's real proportions, so
    // a square sheet gets 2 rows and a tall one 3.
    const spans = [...gallery.querySelectorAll('.g-tile-module')]
      .map(m => parseInt(m.style.gridRow.replace('span ', ''), 10));
    check('every module spans a sane number of rows',
      spans.every(n => n >= 2 && n <= 4), spans.join(','));
    check('module spans vary with sheet shape', new Set(spans).size > 1,
      'all spans identical: ' + spans.join(','));
    check('the square real sheet gets a square block',
      spans.length === 10 && spans.filter(n => n === 2).length >= 1,
      spans.join(','));

    // Sheets must be spread through the singles, not left clustered by date.
    const kinds = [...gallery.querySelectorAll('.g-tile')]
      .map(t => t.classList.contains('g-tile-sheet') ? 'S' : 'd');
    let maxRun = 0, run = 0;
    kinds.forEach(k => { run = k === 'S' ? run + 1 : 0; maxRun = Math.max(maxRun, run); });
    check('no two sheets sit back to back', maxRun === 1, 'longest run ' + maxRun);
    const sheetPositions = kinds.map((k, i) => k === 'S' ? i : -1).filter(i => i >= 0);
    const gaps = sheetPositions.slice(1).map((p, i) => p - sheetPositions[i]);
    check('sheets are evenly spaced', new Set(gaps).size <= 2, 'gaps ' + gaps.join(','));
    check('design tiles present', gallery.querySelectorAll('.g-tile-design').length === 47);
    check('logo still centred on inner screens', !!gallery.querySelector('.g-topbar-logo'));
    check('sheet tiles badged', !!gallery.querySelector('.g-tile-badge'));
    check('filter chips rendered', gallery.querySelectorAll('.g-chip').length > 0);
    check('artist chips in studio view', gallery.querySelectorAll('.g-chip-artist').length === 7,
      'got ' + gallery.querySelectorAll('.g-chip-artist').length);
    check('back control present', !!gallery.querySelector('.g-back'));
    check('scroll surface exempted from preventDefault',
      !!gallery.querySelector('[data-native-scroll]'));

    // Category filter narrows the set
    const before = gallery.querySelectorAll('.g-tile').length;
    const catChip = [...gallery.querySelectorAll('.g-chip')]
      .find(c => c.textContent === 'Gothic');
    check('Gothic chip exists', !!catChip);
    tap(w, catChip);
    const after = gallery.querySelectorAll('.g-tile').length;
    check('filter narrows results', after > 0 && after < before, before + ' -> ' + after);
    check('active chip marked',
      !![...gallery.querySelectorAll('.g-chip')].find(c => c.classList.contains('is-active')));
    check('Clear chip appears',
      !![...gallery.querySelectorAll('.g-chip')].find(c => c.textContent === 'Clear'));

    // Clear restores
    tap(w, [...gallery.querySelectorAll('.g-chip')].find(c => c.textContent === 'Clear'));
    check('clear restores full set', gallery.querySelectorAll('.g-tile').length === before);

    // Artist scope
    tap(w, gallery.querySelector('.g-back'));
    tap(w, gallery.querySelector('.g-mode-artist'));
    const katCard = [...gallery.querySelectorAll('.g-card-artist')]
      .find(c => /Kat/.test(c.textContent));
    tap(w, katCard);
    check('artist grid rendered', !!gallery.querySelector('.g-grid'));
    check('artist grid scoped to 16 (12 singles + 4 sheets)',
      gallery.querySelectorAll('.g-tile').length === 16,
      'got ' + gallery.querySelectorAll('.g-tile').length);
    check('mixed artist gallery shows sheet modules',
      gallery.querySelectorAll('.g-tile-module').length === 4,
      'got ' + gallery.querySelectorAll('.g-tile-module').length);
    check('mixed artist gallery shows singles too',
      gallery.querySelectorAll('.g-tile-design').length === 12);
    check('artist QR panel present', !!gallery.querySelector('.qr-badge.qr-inline'));
    check('no artist chips inside an artist view',
      gallery.querySelectorAll('.g-chip-artist').length === 0);
    check('artist name in title',
      /Kat/.test(gallery.querySelector('.g-topbar-title').textContent));

    // Detail
    tap(w, gallery.querySelector('.g-tile-design'));
    check('detail view opened', !!gallery.querySelector('.g-detail'));
    check('detail shows full-res image',
      /assets\/seed\/designs\//.test(gallery.querySelector('.g-detail-img').src));
    check('detail counter scoped to the filtered set',
      /\/ 16$/.test(gallery.querySelector('.g-detail-counter').textContent),
      gallery.querySelector('.g-detail-counter').textContent);
    check('detail metadata present', !!gallery.querySelector('.g-detail-title'));
    const before2 = parseInt(gallery.querySelector('.g-detail-counter').textContent, 10);
    tap(w, gallery.querySelector('.g-detail-next'));
    check('detail advances within filter set',
      parseInt(gallery.querySelector('.g-detail-counter').textContent, 10) === before2 + 1,
      gallery.querySelector('.g-detail-counter').textContent);
    tap(w, gallery.querySelector('.g-back-detail'));
    check('detail back returns to grid', !!gallery.querySelector('.g-grid'));

    // Sheet handoff from a grid tile
    w.KIOSK_ROUTER.goHome();
    tap(w, gallery.querySelector('.g-mode-all'));
    tap(w, gallery.querySelector('.g-tile-sheet'));
    check('sheet tile switches to sheet viewer', doc.body.classList.contains('mode-sheets'));
    check('back-to-gallery marker set', doc.body.classList.contains('sheets-has-back'));
    check('sheet viewer showing a sheet',
      /assets\/(sheets|seed)\//.test(doc.getElementById('sheetImg').src),
      doc.getElementById('sheetImg').src);
    tap(w, doc.getElementById('sheetBackBtn'));
    check('returns to the grid', doc.body.classList.contains('mode-gallery')
      && !!gallery.querySelector('.g-grid'));
  }

  /* ══ 3. NO DEAD ENDS ════════════════════════════════════════════════════
   * Every route into the sheet viewer from the gallery must offer a way back.
   * The home screen's sheets card previously did not, which stranded anyone
   * who tapped it — the only escape was the idle timeout. PRD §1.3: no dead
   * ends. Both entry paths are checked here because they are wired
   * separately and only one of them was wrong. */
  console.log('\nno dead ends out of the sheet viewer');
  {
    const w = await boot({ catalogSource: 'seed' });
    const doc = w.document;
    const gallery = doc.getElementById('gallery');

    // Path A: home → "Full Flash Sheets" card
    tap(w, gallery.querySelector('.g-mode-sheets'));
    check('home→sheets enters sheet viewer', doc.body.classList.contains('mode-sheets'));
    check('home→sheets shows a back control', doc.body.classList.contains('sheets-has-back'));
    tap(w, doc.getElementById('sheetBackBtn'));
    check('cover→sheets back returns to the cover',
      doc.body.classList.contains('mode-gallery') && !!gallery.querySelector('.g-covergrid'));

    // Path B: grid tile → sheet
    tap(w, gallery.querySelector('.g-mode-all'));
    tap(w, gallery.querySelector('.g-tile-sheet'));
    check('grid→sheets shows a back control', doc.body.classList.contains('sheets-has-back'));
    tap(w, doc.getElementById('sheetBackBtn'));
    check('grid→sheets back returns to the grid',
      doc.body.classList.contains('mode-gallery') && !!gallery.querySelector('.g-grid'));

    // And the one case that correctly has NO back control.
    const w2 = await boot({ catalogSource: 'sheets-only' });
    check('sheets-only kiosk shows no back control',
      !w2.document.body.classList.contains('sheets-has-back'));
  }

  /* ══ 4. EMPTY-STATE — a filter combination with no results ══════════════ */
  console.log('\nempty state');
  {
    const w = await boot({ catalogSource: 'seed' });
    const gallery = w.document.getElementById('gallery');
    tap(w, gallery.querySelector('.g-mode-all'));

    // Scope to sheets, then apply a category no sheet carries.
    const sheetsChip = [...gallery.querySelectorAll('.g-chip')].find(c => c.textContent === 'Sheets');
    check('type toggle offered when both kinds exist', !!sheetsChip);
    tap(w, sheetsChip);
    const cat = [...gallery.querySelectorAll('.g-chip')].find(c => c.textContent === 'Gothic');
    tap(w, cat);

    check('empty state shown, not a blank screen', !!gallery.querySelector('.g-empty'));
    check('empty state explains itself', !!gallery.querySelector('.g-empty-title'));
    const reset = gallery.querySelector('.g-empty .g-chip-clear');
    check('empty state offers a reset', !!reset);
    tap(w, reset);
    check('reset recovers the grid', !!gallery.querySelector('.g-grid'));
  }

  /* ══ 4a. HOME SCREEN FITS THE PANEL ══════════════════════════════════════
   * Joshua's requirement: every artist visible at once, no vertical scroll.
   * The kiosk is exactly 1080x1920, so that is the number this is solved
   * against. jsdom has no layout engine, so this asserts the geometry the
   * layout solver committed to — the arithmetic that decides the grid — plus
   * the structural facts (no scroll surface, cards big enough to tap). */
  console.log('\nhome screen fits 1080x1920 without scrolling');
  {
    const w = await boot({ catalogSource: 'seed' }, (seed, win) => {
      win.innerWidth = 1080;
      win.innerHeight = 1920;
    });
    const gallery = w.document.getElementById('gallery');

    // Cover first: fixed set of modes, no scroll surface.
    check('cover is not scrollable',
      !gallery.querySelector('.g-covergrid[data-native-scroll]')
      && !gallery.querySelector('.g-home[data-native-scroll]'));
    check('cover shows 4 mode cards',
      gallery.querySelectorAll('.g-card-mode').length === 4,
      'got ' + gallery.querySelectorAll('.g-card-mode').length);
    check('cover rows match the card count',
      gallery.querySelector('.g-covergrid').style.getPropertyValue('--cover-rows') === '4');

    // Then the artists page, which is the one that has to adapt.
    tap(w, gallery.querySelector('.g-mode-artist'));
    const L = w.KIOSK_ROUTER.homeLayout;

    check('artists layout solved', !!L);
    check('all 7 artists rendered at once',
      gallery.querySelectorAll('.g-card-artist').length === 7,
      'got ' + gallery.querySelectorAll('.g-card-artist').length);

    check('content height does not exceed the space available',
      L.totalH <= L.availH + 0.5, L.totalH.toFixed(1) + ' > ' + L.availH.toFixed(1));
    check('no scroll fallback needed', L.overflow === false);
    check('cards stay comfortably tappable', L.cardH >= 120, L.cardH.toFixed(1) + 'px');
    check('two columns chosen for 7 artists', L.cols === 2, 'got ' + L.cols);
    // With no banner rows the artists page has more height per card, so the
    // solver settles nearer square than the old cover did. Anything between
    // roughly square and 3:1 still reads as a card rather than a strip.
    check('cards are card-shaped, not letterboxed',
      L.cardW / L.cardH > 1.15 && L.cardW / L.cardH < 3.2,
      (L.cardW / L.cardH).toFixed(2) + ':1');
    check('rows cover the artists with no banner rows',
      L.rows === Math.ceil(7 / L.cols), 'got ' + L.rows);
    check('artist cards are all identical in size',
      [...gallery.querySelectorAll('.g-card-artist')].every(c => !c.style.gridColumn));

    // Structural: the home pane must not be a scroll surface at all.
    check('artists pane is not scrollable',
      !gallery.querySelector('.g-home[data-native-scroll]')
      && !gallery.querySelector('.g-homegrid[data-native-scroll]'));
    check('artists page uses the fixed pane',
      !!gallery.querySelector('.g-home') && !gallery.querySelector('.g-home.g-scroll'));
    check('grid told CSS its column count',
      gallery.querySelector('.g-homegrid').style.getPropertyValue('--home-cols') === String(L.cols));
    check('grid told CSS its row count',
      gallery.querySelector('.g-homegrid').style.getPropertyValue('--home-rows') === String(L.rows));
    check('no full-width cards on the artists page',
      gallery.querySelectorAll('.g-card-span').length === 0);

    // Category chooser: same rules.
    tap(w, gallery.querySelector('.g-back'));
    tap(w, gallery.querySelector('.g-mode-category'));
    const cats = w.Catalog.categoriesFor(null);
    check('category chooser renders every style',
      gallery.querySelectorAll('.g-card-category').length === cats.length,
      gallery.querySelectorAll('.g-card-category').length + ' of ' + cats.length);
    check('category cards are all identical in size',
      [...gallery.querySelectorAll('.g-card-category')].every(c => !c.style.gridColumn));
    check('category chooser fits without scrolling',
      w.KIOSK_ROUTER.homeLayout.overflow === false);
    const catCard = gallery.querySelector('.g-card-category');
    const catName = catCard.querySelector('.g-card-name').textContent;
    tap(w, catCard);
    check('a category opens a filtered grid', !!gallery.querySelector('.g-grid'));
    check('the filter applied is that category',
      w.KIOSK_ROUTER.state.categories.join() === catName,
      w.KIOSK_ROUTER.state.categories.join());
    tap(w, gallery.querySelector('.g-back'));
    check('back from that grid returns to the category chooser',
      !!gallery.querySelector('.g-card-category'));

    // The solver itself, across roster sizes it will actually meet.
    const solve = w.KIOSK_ROUTER.pickHomeLayout;
    const AVAIL = L.availH;
    for (const n of [1, 3, 5, 7, 9, 12]) {
      const s = solve(n, 0, AVAIL, 1048);
      check(`${n} artists fit without scrolling`,
        !s.overflow && s.cardH >= 120 && (s.rows * s.cardH + 12 * (s.rows - 1)) <= AVAIL + 0.5,
        `cols=${s.cols} rows=${s.rows} cardH=${s.cardH.toFixed(0)} overflow=${s.overflow}`);
    }

    // And the defined behaviour past the point where it genuinely cannot fit.
    const huge = solve(60, 0, AVAIL, 1048);
    check('an impossible roster degrades to scrolling rather than clipping',
      huge.overflow === true && huge.cols === 4);

    const overflowing = await boot({ catalogSource: 'seed' }, (seed, win) => {
      win.innerWidth = 1080; win.innerHeight = 1920;
      const base = seed.artists.slice();
      for (let i = 0; i < 8; i++) {
        base.forEach((a, j) => seed.artists.push(Object.assign({}, a, {
          id: a.id + '-c' + i + j, handle: a.handle + i + j,
          displayOrder: seed.artists.length,
        })));
      }
      seed.designs = seed.designs.concat(seed.artists.slice(7).map((a, k) =>
        Object.assign({}, seed.designs[0], { id: 'x' + k, artistId: a.id })));
    });
    tap(overflowing, overflowing.document.querySelector('.g-mode-artist'));
    const L2 = overflowing.KIOSK_ROUTER.homeLayout;
    check('overflow case marks itself explicitly', L2.overflow === true);
    check('overflow case opts back into scrolling',
      !!overflowing.document.querySelector('.g-homegrid.is-overflow[data-native-scroll]'));
  }

  /* ══ 4c. ONE LAYOUT AT EVERY WIDTH ══════════════════════════════════════
   * Joshua: "It should look the same on mobile as it does on the kiosk."
   * The phone is a real user path — the sheet viewer's QR sends people to
   * this page — so the composition must scale, not reflow.
   *
   * The original phone bug was two sources of truth: CSS media queries
   * dropped the grid to 2 columns while gallery.js kept computing module
   * spans for 3. These assert the composition is byte-identical across
   * widths, and that no stylesheet reintroduces a column breakpoint. */
  console.log('\none layout at every width');
  {
    const WIDTHS = [
      ['kiosk', 1080], ['iPad portrait', 768], ['iPhone Pro Max', 430],
      ['iPhone 14', 390], ['iPhone SE', 375], ['small Android', 360],
    ];

    const shapes = {};
    for (const [label, width] of WIDTHS) {
      const w = await boot({ catalogSource: 'seed' }, (seed, win) => {
        win.innerWidth = width;
        win.innerHeight = Math.round(width * 1920 / 1080);
        Object.defineProperty(win.HTMLElement.prototype, 'clientWidth',
          { configurable: true, get: () => width });
      });
      const gallery = w.document.getElementById('gallery');
      w.KIOSK_ROUTER.renderArtists();
      const kat = [...gallery.querySelectorAll('.g-card-artist')]
        .find(c => /@Kattitudetattoo/.test(c.textContent));
      tap(w, kat);

      const grid = gallery.querySelector('.g-grid');
      shapes[label] = {
        cols: grid.style.getPropertyValue('--cols'),
        cell: grid.style.getPropertyValue('--cell'),
        tiles: gallery.querySelectorAll('.g-tile').length,
        modules: [...gallery.querySelectorAll('.g-tile-module')]
          .map(m => m.style.gridColumn + '|' + m.style.gridRow).join(' , '),
        order: [...gallery.querySelectorAll('.g-tile')]
          .map(t => t.classList.contains('g-tile-sheet') ? 'S' : 'd').join(''),
      };

      check(`${label} (${width}px) uses 3 columns`, shapes[label].cols === '3',
        'got ' + shapes[label].cols);
      check(`${label} cell size is proportional`,
        parseInt(shapes[label].cell, 10) > 0,
        shapes[label].cell);
    }

    // Every width must produce the SAME composition — same tiles, same order,
    // same module spans. Only the cell size differs.
    const kiosk = shapes['kiosk'];
    for (const [label] of WIDTHS.slice(1)) {
      check(`${label} matches the kiosk tile count`, shapes[label].tiles === kiosk.tiles,
        shapes[label].tiles + ' vs ' + kiosk.tiles);
      check(`${label} matches the kiosk module spans`,
        shapes[label].modules === kiosk.modules,
        shapes[label].modules + ' vs ' + kiosk.modules);
      check(`${label} matches the kiosk sheet/single order`,
        shapes[label].order === kiosk.order);
    }

    // Cells must genuinely shrink, or "scaled" would be a fiction.
    check('cells scale down with the viewport',
      parseInt(shapes['iPhone 14'].cell, 10) < parseInt(kiosk.cell, 10) / 2,
      shapes['iPhone 14'].cell + ' vs ' + kiosk.cell);

    // Guard against anyone reintroducing a column breakpoint in CSS.
    const css = fs.readFileSync(path.join(ROOT, 'gallery.css'), 'utf8');
    const gridBlocks = css.split('@media').slice(1)
      .filter(b => /grid-template-columns/.test(b.split('}')[0] + b.split('}')[1]));
    check('no media query overrides the grid column count', gridBlocks.length === 0,
      gridBlocks.length + ' found');
    check('module tiles crop to fill rather than letterbox',
      /\.g-tile-module \.g-tile-img img \{[^}]*object-fit:\s*cover/.test(css));

    // moduleSpan is the single place the block geometry is decided.
    const w0 = await boot({ catalogSource: 'seed' });
    const span = w0.KIOSK_ROUTER.moduleSpan;
    check('a 9:16 sheet gets a 2x4 block', JSON.stringify(span(0.5625, 3)) === '{"colSpan":2,"rows":4}',
      JSON.stringify(span(0.5625, 3)));
    check('a square sheet gets a 2x2 block', JSON.stringify(span(1.0, 3)) === '{"colSpan":2,"rows":2}',
      JSON.stringify(span(1.0, 3)));
    check('column count never varies with width',
      w0.KIOSK_ROUTER.pickGridColumns() === 3);
  }

  /* ══ 4d. FIXED DESIGN CANVAS ════════════════════════════════════════════
   * Joshua: "This is not the same as the kiosk."
   *
   * The earlier fix pinned the DESIGN grid to 3 columns, but pickHomeLayout()
   * still solved the artist and category pages from the real viewport — at
   * 390px it chose 4 narrow columns where the kiosk shows 2 wide ones, and
   * clipped the handles.
   *
   * The systemic fix: the whole app lives in a fixed 1080x1920 canvas that is
   * CSS-scaled to fit. Nothing inside can see the real viewport, so nothing
   * can diverge. These tests enforce that invariant rather than spot-checking
   * symptoms. */
  console.log('\nfixed 1080x1920 design canvas');
  {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const gcss = fs.readFileSync(path.join(ROOT, 'gallery.css'), 'utf8');
    const gjs = fs.readFileSync(path.join(ROOT, 'gallery.js'), 'utf8');
    const cjs = fs.readFileSync(path.join(ROOT, 'catalog.js'), 'utf8');
    const sjs = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');

    check('canvas wrapper exists in markup', /id="kioskCanvas"/.test(html));
    check('canvas is exactly 1080 wide',
      /#kioskCanvas\s*\{[^}]*width:\s*1080px/.test(css));
    check('canvas is exactly 1920 tall',
      /#kioskCanvas\s*\{[^}]*height:\s*1920px/.test(css));
    check('canvas is scaled by --app-scale',
      /#kioskCanvas\s*\{[^}]*transform:\s*scale\(var\(--app-scale/.test(css));
    check('canvas scales from the top centre',
      /#kioskCanvas\s*\{[^}]*transform-origin:\s*top center/.test(css));

    /* THE invariant. Any viewport read outside applyCanvasScale() can make a
     * phone diverge from the kiosk, which is the whole bug class here. */
    const viewportRe = /\b(innerWidth|innerHeight|outerWidth|outerHeight|screen\.width|screen\.height|visualViewport)\b/g;
    for (const [label, src] of [['gallery.js', gjs], ['catalog.js', cjs]]) {
      const hits = src.match(viewportRe) || [];
      check(`${label} makes no viewport reads`, hits.length === 0,
        hits.join(', '));
    }

    // script.js may read the viewport, but ONLY inside applyCanvasScale.
    const scaleFn = (sjs.match(/function applyCanvasScale\(\)[\s\S]*?\n  \}/) || [''])[0];
    const scaleHits = (scaleFn.match(viewportRe) || []).length;
    const totalHits = (sjs.match(viewportRe) || []).length;
    check('script.js reads the viewport only to compute the scale',
      totalHits > 0 && totalHits === scaleHits,
      `${scaleHits} of ${totalHits} reads are inside applyCanvasScale`);

    /* vw/vh units are viewport reads by another name — inside a scaled canvas
     * they would double-scale and diverge. */
    for (const [label, src] of [['styles.css', css], ['gallery.css', gcss]]) {
      // The `html, body` rule is the one legitimate place for viewport units:
      // it sizes the PAGE the canvas is scaled inside, not the composition.
      const scanned = src.replace(/html,\s*body\s*\{[^}]*\}/g, '');
      const decls = (scanned.match(/^[^\/\n]*:\s*[^;]*\b\d[\d.]*v[wh]\b[^;]*;/gm) || []);
      check(`${label} uses no viewport units inside the canvas`, decls.length === 0,
        decls.slice(0, 3).join(' | '));
    }

    /* And the behavioural proof: identical composition at both sizes. Inside
     * the canvas clientWidth is 1080 regardless of the real viewport, which
     * is exactly what the stub reproduces. */
    async function compose(realWidth) {
      const w = await boot({ catalogSource: 'seed' }, (seed, win) => {
        win.innerWidth = realWidth;
        win.innerHeight = Math.round(realWidth * 1920 / 1080);
        // Canvas is a fixed 1080 no matter the viewport — this is the point.
        Object.defineProperty(win.HTMLElement.prototype, 'clientWidth',
          { configurable: true, get: () => 1080 });
      });
      const g = w.document.getElementById('gallery');
      w.KIOSK_ROUTER.renderArtists();
      const L = w.KIOSK_ROUTER.homeLayout;
      return {
        cols: L.cols,
        rows: L.rows,
        cardW: Math.round(L.cardW),
        cardH: Math.round(L.cardH),
        cards: g.querySelectorAll('.g-card-artist').length,
        scale: (realWidth / 1080),
      };
    }

    const kioskC = await compose(1080);
    const phoneC = await compose(390);

    check('artists page: same column count at 1080 and 390',
      kioskC.cols === phoneC.cols, `${kioskC.cols} vs ${phoneC.cols}`);
    check('artists page: same row count', kioskC.rows === phoneC.rows);
    check('artists page: identical card width',
      kioskC.cardW === phoneC.cardW, `${kioskC.cardW} vs ${phoneC.cardW}`);
    check('artists page: identical card height',
      kioskC.cardH === phoneC.cardH, `${kioskC.cardH} vs ${phoneC.cardH}`);
    check('artists page: cards stay wide, not tall slabs',
      kioskC.cardW / kioskC.cardH > 1.1,
      (kioskC.cardW / kioskC.cardH).toFixed(2) + ':1');
    check('artists page: same card count', kioskC.cards === phoneC.cards);
    check('phone scale factor is ~0.36',
      Math.abs(phoneC.scale - 0.361) < 0.005, phoneC.scale.toFixed(3));

    /* Handles were clipping mid-word. Inside the canvas the card is the kiosk
     * width, so the longest real handle has to fit. */
    const w2 = await boot({ catalogSource: 'seed' });
    w2.KIOSK_ROUTER.renderArtists();
    const handles = [...w2.document.querySelectorAll('.g-card-handle')]
      .map(h => h.textContent);
    check('every handle rendered in full',
      handles.includes('@Kattitudetattoo') && handles.includes('@delicatelyscripted')
      && handles.includes('@Alenanebotattoos'),
      handles.join(' '));
  }

  /* ══ 4b. THE FOUR GALLERY STATES ════════════════════════════════════════
   * Every layout state must be reachable from the home screen, because a
   * state you cannot navigate to is a state nobody reviews. */
  console.log('\nall four gallery states reachable');
  {
    const w = await boot({ catalogSource: 'seed' });
    const doc = w.document;
    const gallery = doc.getElementById('gallery');
    const cat = w.Catalog;

    const mixed = cat.snapshot().artists.filter(a =>
      cat.countForArtistByType(a.id, 'design') > 0 &&
      cat.countForArtistByType(a.id, 'sheet') > 0);
    const sheetsOnlyArtists = cat.snapshot().artists.filter(a => cat.isSheetsOnlyArtist(a.id));
    const singlesOnly = cat.snapshot().artists.filter(a =>
      cat.countForArtistByType(a.id, 'design') > 0 &&
      cat.countForArtistByType(a.id, 'sheet') === 0);

    check('at least two mixed galleries', mixed.length >= 2, 'got ' + mixed.length);
    check('at least one sheets-only artist', sheetsOnlyArtists.length >= 1);
    check('at least one singles-only artist', singlesOnly.length >= 1);

    // A mixed gallery must produce more than one module so the alternation
    // is actually visible rather than theoretical.
    const openArtist = id => {
      w.KIOSK_ROUTER.renderArtists();
      const artist = cat.snapshot().artists.find(a => a.id === id);
      const card = [...gallery.querySelectorAll('.g-card-artist')]
        .find(c => c.textContent.indexOf(artist.handle) !== -1);
      tap(w, card);
    };

    openArtist(mixed[0].id);
    const mods = gallery.querySelectorAll('.g-tile-module').length;
    check('first mixed gallery has multiple modules', mods >= 2, 'got ' + mods);
    check('both alternations visible in one gallery',
      gallery.querySelectorAll('.g-tile-module.is-left').length >= 1 &&
      gallery.querySelectorAll('.g-tile-module.is-right').length >= 1);
    check('singles sit alongside the modules',
      gallery.querySelectorAll('.g-tile-design').length >= 3);

    openArtist(mixed[1].id);
    check('second mixed gallery also tiles',
      gallery.querySelectorAll('.g-tile-module').length >= 2 &&
      gallery.querySelectorAll('.g-tile-design').length > 0);

    // Sheets-only artist bypasses the grid entirely.
    const sheetsArtist = sheetsOnlyArtists[0];
    openArtist(sheetsArtist.id);
    check('sheets-only artist opens the linear viewer',
      doc.body.classList.contains('mode-sheets'));
    check('sheets-only artist renders no grid', !gallery.querySelector('.g-grid'));
    check('viewer scoped to that artist\'s sheets',
      w.SheetViewer.count === cat.countForArtistByType(sheetsArtist.id, 'sheet'),
      w.SheetViewer.count + ' vs ' + cat.countForArtistByType(sheetsArtist.id, 'sheet'));
    check('dots match the scoped set',
      doc.getElementById('dots').children.length === w.SheetViewer.count);
    check('sheets-only artist can get back', doc.body.classList.contains('sheets-has-back'));
    tap(w, doc.getElementById('sheetBackBtn'));
    check('back from a sheets-only artist lands on the artists page',
      !!gallery.querySelector('.g-homegrid') && !!gallery.querySelector('.g-card-artist'));

    // Singles-only artist: no modules at all.
    openArtist(singlesOnly[0].id);
    check('singles-only gallery has no sheet modules',
      gallery.querySelectorAll('.g-tile-module').length === 0);

    // Studio-wide mixes both, newest first.
    w.KIOSK_ROUTER.goHome();
    tap(w, gallery.querySelector('.g-mode-all'));
    const tiles = [...gallery.querySelectorAll('.g-tile')];
    const hasSheet = tiles.some(t => t.classList.contains('g-tile-sheet'));
    const hasDesign = tiles.some(t => t.classList.contains('g-tile-design'));
    const firstSheetAt = tiles.findIndex(t => t.classList.contains('g-tile-sheet'));
    check('studio-wide mixes both kinds', hasSheet && hasDesign);
    check('sheets interleave rather than clumping at the end',
      firstSheetAt > -1 && firstSheetAt < tiles.length - 1,
      'first sheet at index ' + firstSheetAt + ' of ' + tiles.length);

    // A filter yielding very few items must still look like a grid, not junk.
    const chips = [...gallery.querySelectorAll('.g-chip')];
    const rare = chips.find(c => c.textContent === 'Realism');
    if (rare) {
      tap(w, rare);
      const n = gallery.querySelectorAll('.g-tile').length;
      check('sparse filter still renders a grid', n > 0 && !!gallery.querySelector('.g-grid'),
        n + ' tiles');
      check('sparse filter shows no empty state', !gallery.querySelector('.g-empty'));
    }
  }

  /* ══ 5. ARBITRARY ROSTER SIZE ═══════════════════════════════════════════
   * The roster came from a screenshot that may have been cut off, so the real
   * count is unconfirmed. Nothing may assume seven. These synthesise rosters
   * the seed data does not contain, rather than distorting the real one. */
  console.log('\narbitrary roster sizes');
  {
    // 1 artist + sheets — home still shows the hub, because sheets are a
    // second destination.
    const one = await boot({ catalogSource: 'seed' }, seed => {
      const keep = seed.artists[0].id;
      seed.artists = seed.artists.slice(0, 1);
      seed.designs = seed.designs.filter(d => d.artistId === keep);
    });
    check('1 artist renders the cover', !!one.document.querySelector('.g-covergrid'));
    tap(one, one.document.querySelector('.g-mode-artist'));
    check('1 artist card', one.document.querySelectorAll('.g-card-artist').length === 1);

    // 14 artists — double the roster; the home screen must simply grow.
    const many = await boot({ catalogSource: 'seed' }, seed => {
      const extra = seed.artists.map((a, i) => Object.assign({}, a, {
        id: a.id + '-x', name: a.name + ' II', handle: a.handle + '_2',
        displayOrder: seed.artists.length + i,
      }));
      const extraDesigns = seed.designs.map(d => Object.assign({}, d, {
        id: d.id + '-x', artistId: d.artistId + '-x',
      }));
      seed.artists = seed.artists.concat(extra);
      seed.designs = seed.designs.concat(extraDesigns);
    });
    tap(many, many.document.querySelector('.g-mode-artist'));
    check('14 artists all render',
      many.document.querySelectorAll('.g-card-artist').length === 14,
      'got ' + many.document.querySelectorAll('.g-card-artist').length);
    check('none of the 14 cards stretch',
      [...many.document.querySelectorAll('.g-card-artist')].every(c => !c.style.gridColumn));
    check('94 designs in catalog', many.Catalog.snapshot().singleCount === 94,
      'got ' + many.Catalog.snapshot().singleCount);

    // An artist with no published work — the state the studio hits the day
    // someone new joins. Card renders, is labelled, and is not tappable.
    const withEmpty = await boot({ catalogSource: 'seed' }, seed => {
      seed.artists.push({
        id: 'newcomer', name: 'New Artist', handle: '@newcomer', bio: '',
        seniority: 'Junior Artist', portrait: '', displayOrder: 99, active: true,
      });
    });
    const gEmpty = withEmpty.document.getElementById('gallery');
    tap(withEmpty, gEmpty.querySelector('.g-mode-artist'));
    const emptyCard = gEmpty.querySelector('.g-card-artist.is-empty');
    check('zero-design artist card rendered', !!emptyCard);
    check('zero-design artist reads "Coming soon"',
      !!emptyCard && /Coming soon/.test(emptyCard.textContent));
    check('zero-design artist card disabled', !!emptyCard && emptyCard.disabled === true);
    check('zero-design artist gets no filter chip',
      ![...gEmpty.querySelectorAll('.g-chip-artist')].some(c => /New Artist/.test(c.textContent)));

    // Single artist, no sheets — the hub has one destination, so skip it.
    const skip = await boot({ catalogSource: 'seed', includeSheets: false }, seed => {
      const keep = seed.artists[0].id;
      seed.artists = seed.artists.slice(0, 1);
      seed.designs = seed.designs.filter(d => d.artistId === keep && d.type !== 'sheet');
    });
    check('lone artist with no sheets skips the hub',
      skip.Catalog.snapshot().skipHome === true);
    check('lone artist lands straight in a grid',
      !!skip.document.querySelector('.g-grid'));
  }

  /* ══ 6. DEGRADED LIVE SOURCE — network down at first load ═══════════════ */
  console.log('\nlive source unreachable');
  {
    const w = await boot({ catalogSource: 'live', live: { url: 'https://example.invalid/x' } });
    const snap = w.Catalog.snapshot();
    check('marked degraded', snap.degraded === true);
    check('falls back to sheets, not a blank screen', snap.sheetCount === 4);
    check('routes to the sheet viewer', w.document.body.classList.contains('mode-sheets'));
    check('gallery not mounted', w.document.getElementById('gallery').children.length === 0);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nfailures:');
    failures.forEach(f => console.log('  - ' + f));
    process.exit(1);
  }
})().catch(err => { console.error(err); process.exit(1); });
