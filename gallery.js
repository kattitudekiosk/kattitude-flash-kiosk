/* Flash Gallery — browse UI + router (PRD §3.1–§3.4)
 *
 * Owns three views: home (artist hub), grid (filtered browse), detail
 * (full-screen single). Sheets are NOT reimplemented here — a sheet tile
 * hands off to the existing linear viewer in script.js, which is tuned for
 * the kiosk panel's touch quirks and stays authoritative for sheet browsing.
 *
 * ── The load-bearing decision in this file ──────────────────────────────
 * If the catalog has zero individual designs, this module renders NOTHING
 * and the kiosk boots straight into the legacy sheet viewer, exactly as it
 * behaves in the shop today. That is not a degraded mode to be tolerated —
 * with only 4 composed sheets it is the correct experience, and it is the
 * live one. Everything below is additive on top of a path that must keep
 * working untouched.
 */
window.KIOSK_ROUTER = (function () {
  'use strict';

  const cfg = window.KIOSK_CONFIG || {};
  const TAP_TOLERANCE = 10;
  const SWIPE_THRESHOLD = 70;
  const SWIPE_ANGLE_RATIO = 1.4;

  let snap = null;
  let root = null;
  let booted = false;
  let idleTimer = null;

  const view = {
    name: 'cover',       // 'cover' | 'artists' | 'categories' | 'grid' | 'detail' | 'sheets'
    artistId: null,      // null = studio-wide
    categories: [],
    types: null,         // null = all, or ['design'] / ['sheet']
    sort: (cfg.grid && cfg.grid.defaultSort) || 'newest',
    items: [],           // current filtered set — detail swipes within this
    index: 0,
    cameFromGrid: false, // sheet viewer entered from a grid tile
    cameFromCategories: false, // grid entered from the category chooser
  };

  /* ── Small DOM helpers ─────────────────────────────────────────────────── */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Buttons must respond to touch immediately. Binding click alone costs a
   * ~300ms delay on some kiosk browsers and feels broken on a wall panel. */
  function onTap(node, fn) {
    let sx = 0, sy = 0, moved = false;
    node.addEventListener('touchstart', e => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; moved = false;
      node.classList.add('pressed');
    }, { passive: true });
    node.addEventListener('touchmove', e => {
      const t = e.changedTouches[0];
      if (Math.hypot(t.clientX - sx, t.clientY - sy) > TAP_TOLERANCE) moved = true;
    }, { passive: true });
    node.addEventListener('touchend', e => {
      node.classList.remove('pressed');
      if (moved) return;
      e.preventDefault();
      e.stopPropagation();
      fn(e);
    }, { passive: false });
    node.addEventListener('touchcancel', () => node.classList.remove('pressed'), { passive: true });
    node.addEventListener('click', e => {
      // Suppress the synthetic click that follows a handled touchend.
      if (e.detail === 0 && e.pointerType === undefined) return;
      fn(e);
    });
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  /* ── Mode switching ────────────────────────────────────────────────────── */
  /* Exactly one of {gallery UI, legacy sheet viewer} is visible at a time.
   * body class drives it so CSS owns the layout and JS never fights it. */
  function setMode(mode) {
    document.body.classList.toggle('mode-gallery', mode === 'gallery');
    document.body.classList.toggle('mode-sheets', mode === 'sheets');
  }

  /* ── Idle reset (PRD §4.3) ─────────────────────────────────────────────── */
  function resetIdle() {
    clearTimeout(idleTimer);
    const ms = cfg.idleResetMs || 90000;
    if (!ms) return;
    idleTimer = setTimeout(() => {
      if (view.name !== 'cover') goHome();
    }, ms);
  }

  /* ── Header ────────────────────────────────────────────────────────────── */
  function buildHeader(title, onBack) {
    const bar = el('div', 'g-topbar');

    // Back control first in the DOM but positioned out of flow by CSS, so it
    // never shifts the logo off centre.
    if (onBack) {
      const back = el('button', 'g-back');
      back.setAttribute('aria-label', 'Back');
      back.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
        'stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
        '<span>Back</span>';
      onTap(back, onBack);
      bar.appendChild(back);
    }

    // The logo shows on every screen, not just home — it is the studio's
    // identity on a wall-mounted panel, and dropping it on inner screens made
    // them look like a different application.
    const logo = el('img', 'g-topbar-logo');
    logo.src = 'assets/brand/kattitude-logo.png';
    logo.alt = 'Kattitude Tattoo Studio';
    bar.appendChild(logo);

    if (title) bar.appendChild(el('div', 'g-topbar-title', title));
    return bar;
  }

  /* The placeholder banner is gone with the placeholder data (2 Oct 2026).
   * What remains is the honest one: when the live catalog cannot be reached,
   * say so, rather than show anything made up. */
  function seedBanner() {
    if (!snap.degraded) return null;
    return el('div', 'g-seedbanner',
      'Can\u2019t reach the studio catalog right now \u2014 showing what was last loaded.');
  }

  /* ── Home (PRD §3.1) ──────────────────────────────────────────────────────
   * The home screen does NOT scroll. Every artist has to be visible at once —
   * a customer standing at a kiosk for thirty seconds should not have to
   * discover that there is more below the fold. This overrides the PRD's
   * original "scrolls vertically" note and its 200px card minimum.
   *
   * The layout is therefore solved rather than authored: pickHomeLayout()
   * chooses a column count so that every card still clears a comfortable
   * touch target, and the grid divides the leftover height into equal rows.
   * Add or remove artists and it re-solves. */
  /* Where the sheet viewer's corner QR points when no artist is in scope.
   * Defaults to the online gallery. Joshua has never specified a destination,
   * so this is a chosen default, not a confirmed one — change galleryUrl in
   * config.js if it should be the studio site or the booking page. */
  const DEFAULT_QR_URL = (cfg.galleryUrl || 'https://kattitude-flash-kiosk.vercel.app');
  const DEFAULT_QR_LABEL = 'Browse on your phone';

  const GRID_GAP = 12;       // must match .g-grid gap in gallery.css

  /* The app is laid out inside a fixed 1080x1920 canvas (see #kioskCanvas in
   * styles.css), so these are what clientWidth/clientHeight report. They are
   * fallbacks only — never a viewport read. The single place allowed to look
   * at the real viewport is applyCanvasScale() in script.js. */
  const DESIGN_W = 1080;
  const DESIGN_H = 1920;

  const MIN_CARD_H = 120;   // below this a card stops being a comfortable target
  const MIN_CARD_W = 300;   // narrower than this and the name has nowhere to go
  const TARGET_CARD_ASPECT = 2.0;  // width:height a card reads best at
  const MAX_HOME_COLS = 4;
  const HOME_GAP = 12;

  /**
   * Solve for the column count.
   *   n            — artist cards
   *   bannerRows   — full-width cards (See All, and Full Flash Sheets)
   *   availH       — pixels available to the card grid
   * Returns { cols, rows, cardH, overflow }. `overflow` true means even the
   * densest layout cannot fit, and the home screen is allowed to scroll as a
   * last resort — a defined outcome rather than silent clipping.
   */
  function pickHomeLayout(n, bannerRows, availH, availW) {
    const W = availW || 1080;
    let best = null;
    let bestScore = Infinity;
    let densest = null;

    for (let cols = 1; cols <= MAX_HOME_COLS; cols++) {
      const rows = Math.ceil(n / cols) + bannerRows;
      const cardH = (availH - HOME_GAP * (rows - 1)) / rows;
      const cardW = (W - HOME_GAP * (cols - 1)) / cols;
      densest = { cols, rows, cardH, cardW, overflow: false };

      if (cardH < MIN_CARD_H || cardW < MIN_CARD_W) continue;

      // Fewest columns is NOT the goal — one column that fits still yields a
      // 1048x164 letterbox, which wastes the panel and looks nothing like a
      // card. Score by how close the resulting card is to the target shape
      // (a wide card holding a portrait beside a name), which naturally picks
      // 2 columns for a 7-artist roster and adds columns as the roster grows.
      const score = Math.abs(Math.log((cardW / cardH) / TARGET_CARD_ASPECT));
      if (score < bestScore) { bestScore = score; best = densest; }
    }

    if (best) return best;

    // Nothing satisfies both minimums — keep the densest packing and permit
    // scrolling. Defined degradation, not silent clipping.
    return Object.assign(densest || { cols: MAX_HOME_COLS, rows: 1, cardH: MIN_CARD_H, cardW: W },
                         { overflow: true });
  }

  /** Height left for the card grid once the fixed chrome is accounted for. */
  function availableHomeHeight(chromeNodes) {
    const viewportH = root.clientHeight || DESIGN_H;
    let chrome = 0;
    chromeNodes.forEach(node => {
      const h = node && node.getBoundingClientRect ? node.getBoundingClientRect().height : 0;
      // Guard against environments with no layout engine reporting the full
      // viewport for every element, which would drive availH negative.
      chrome += (h > 0 && h < viewportH) ? h : 0;
    });
    if (!chrome) chrome = Math.round(viewportH * 0.18); // header + copy estimate
    return Math.max(MIN_CARD_H, viewportH - chrome - HOME_GAP * 2);
  }

  /* ── Cover ────────────────────────────────────────────────────────────────
   * The cover is a set of navigation MODES, not a list of artists:
   *   View All          — the whole catalog, newest first
   *   Browse by Artist  — the artist cards, now on their own page
   *   Browse by Category— a category chooser, then a filtered grid
   * Three or four large targets read faster from across a room than a dozen
   * small ones, and it keeps the cover fixed regardless of roster size. */
  function renderCover() {
    /* Read the LIVE catalog every time the cover is drawn — the same source
     * the Artists page counts from. It used to draw from `snap`, the copy
     * taken at the last refresh callback, so a catalog reloaded any other way
     * left the cover a refresh behind the Artists page (Joshua, 2 Oct 2026:
     * "it's right on the artist page but the cover page is wrong"). */
    if (window.Catalog && window.Catalog.snapshot) snap = window.Catalog.snapshot();
    view.name = 'cover';
    view.artistId = null;
    view.categories = [];
    view.types = null;
    setMode('gallery');
    clear(root);

    const banner = seedBanner();
    if (banner) root.appendChild(banner);
    root.appendChild(buildHeader(null, null));

    const pane = el('div', 'g-home');
    pane.appendChild(el('h1', 'g-home-title', 'Browse our flash'));

    const help = el('p', 'g-home-help');
    help.innerHTML = 'Choose how you would like to look — everything at once, ' +
      'by artist, or by style.';
    pane.appendChild(help);

    const grid = el('div', 'g-covergrid');
    pane.appendChild(grid);
    root.appendChild(pane);

    const modes = [
      {
        cls: 'g-card-mode g-mode-all',
        title: 'View All',
        sub: describeTotal() + ' — newest first',
        go: () => { view.sort = 'newest'; openGrid(null); },
      },
      {
        cls: 'g-card-mode g-mode-artist',
        title: 'Browse by Artist',
        sub: snap.artists.length + (snap.artists.length === 1 ? ' artist' : ' artists'),
        go: () => renderArtists(),
      },
    ];

    const cats = window.Catalog.categoriesFor(null);
    if (cats.length) {
      modes.push({
        cls: 'g-card-mode g-mode-category',
        title: 'Browse by Category',
        sub: cats.length + ' styles',
        go: () => renderCategories(),
      });
    }

    // Sheets: a fourth mode card while it is still an open question whether
    // this belongs on the cover or folded into View All (it already appears
    // there as tiles). Flip coverSheetsCard in config.js to fold it in.
    if (snap.hasSheets && cfg.coverSheetsCard !== false) {
      modes.push({
        cls: 'g-card-mode g-mode-sheets',
        title: 'Full Flash Sheets',
        sub: snap.sheetCount + (snap.sheetCount === 1 ? ' sheet' : ' sheets'),
        go: () => { view.artistId = null; openSheetViewer(0, false, window.Catalog.sheets()); },
      });
    }

    modes.forEach(m => {
      const card = el('button', 'g-card ' + m.cls);
      card.appendChild(el('div', 'g-card-all-title', m.title));
      card.appendChild(el('div', 'g-card-all-sub', m.sub));
      onTap(card, m.go);
      grid.appendChild(card);
    });

    grid.style.setProperty('--cover-rows', String(modes.length));
    coverModeCount = modes.length;
    resetIdle();
  }

  let coverModeCount = 0;

  /* ── Browse by Artist ─────────────────────────────────────────────────────
   * The artist cards that used to be the cover. Every card is the same size:
   * an odd final card occupies one column and leaves the neighbouring slot
   * empty rather than stretching across it. */
  function renderArtists() {
    view.name = 'artists';
    view.artistId = null;
    setMode('gallery');
    clear(root);

    const banner = seedBanner();
    if (banner) root.appendChild(banner);
    const header = buildHeader('Artists', renderCover);
    root.appendChild(header);

    // No [data-native-scroll] here — this pane is deliberately unscrollable,
    // so the global preventDefault in script.js keeps it fixed.
    const pane = el('div', 'g-home');

    const help = el('p', 'g-home-help');
    help.textContent = 'Tap an artist to see their work.';
    pane.appendChild(help);

    const grid = el('div', 'g-homegrid');
    pane.appendChild(grid);
    root.appendChild(pane);

    const artists = snap.artists;
    const bannerRows = 0;   // no full-width cards on this page any more
    const availH = availableHomeHeight([banner, header, help]);
    const availW = (root.clientWidth || DESIGN_W) - 32;
    const layout = pickHomeLayout(artists.length, bannerRows, availH, availW);

    grid.style.setProperty('--home-cols', String(layout.cols));
    grid.style.setProperty('--home-rows', String(layout.rows));
    grid.style.setProperty('--home-gap', HOME_GAP + 'px');
    grid.classList.toggle('is-overflow', layout.overflow);
    if (layout.overflow) {
      // Explicit, and only in the case where fitting is impossible.
      grid.setAttribute('data-native-scroll', '');
    }

    // Every card identical. An odd final card takes one column and leaves the
    // slot beside it empty — a card that stretches to fill its row reads as a
    // different, more important kind of thing, which it is not.
    artists.forEach(a => grid.appendChild(artistCard(a, layout)));

    // Exposed for tests and debugging: the numbers the layout was solved with.
    homeLayout = Object.assign({}, layout, {
      availH, bannerRows, artistCount: artists.length,
      totalH: layout.rows * layout.cardH + HOME_GAP * (layout.rows - 1),
    });

    resetIdle();
  }

  let homeLayout = null;

  function describeTotal() {
    const parts = [];
    if (snap.singleCount) parts.push(snap.singleCount + (snap.singleCount === 1 ? ' design' : ' designs'));
    if (snap.sheetCount) parts.push(snap.sheetCount + (snap.sheetCount === 1 ? ' sheet' : ' sheets'));
    return parts.join(' · ') || 'Browse everything';
  }

  function artistCard(a, layout) {
    const count = window.Catalog.countForArtist(a.id);
    // Tighter card when the grid is dense — at three or more columns the
    // portrait and the style list stop fitting, so they are dropped rather
    // than squeezed into something unreadable.
    const dense = !!layout && (layout.cols >= 3 || layout.cardH < 170);

    /* The card carries the artist's Instagram QR when there is physically
     * room for one big enough to scan. 180px of badge plus its gap needs the
     * card to be wide enough that the name and handle still have somewhere to
     * go, and tall enough not to clip it. Below that the badge is dropped
     * rather than shrunk — see the note in gallery.css. */
    const cardW = (layout && layout.cardW) || 0;
    const cardH = (layout && layout.cardH) || 0;
    const wantQr = !!a.instagram && !dense
      && cardW >= 460 && cardH >= 200;

    const card = el('button', 'g-card g-card-artist'
      + (count === 0 ? ' is-empty' : '')
      + (dense ? ' is-dense' : '')
      + (wantQr ? ' has-qr' : ''));

    const pic = el('div', 'g-card-portrait');
    if (a.portrait) {
      const img = el('img');
      img.src = a.portrait;
      img.alt = '';
      img.loading = 'lazy';
      pic.appendChild(img);
    } else {
      pic.appendChild(el('span', 'g-card-initials',
        a.name.split(/\s+/).slice(0, 2).map(s => s[0] || '').join('').toUpperCase()));
    }
    card.appendChild(pic);

    const meta = el('div', 'g-card-meta');
    meta.appendChild(el('div', 'g-card-name', a.name));
    if (a.handle) meta.appendChild(el('div', 'g-card-handle', a.handle));
    if (cfg.showSeniority && a.seniority) {
      meta.appendChild(el('div', 'g-card-seniority', a.seniority));
    }

    // An artist with nothing published is a real state — say so plainly
    // rather than rendering a card that looks tappable but goes nowhere.
    const singles = window.Catalog.countForArtistByType(a.id, 'design');
    const sheetsN = window.Catalog.countForArtistByType(a.id, 'sheet');
    const bits = [];
    if (singles) bits.push(singles + (singles === 1 ? ' design' : ' designs'));
    if (sheetsN) bits.push(sheetsN + (sheetsN === 1 ? ' sheet' : ' sheets'));
    meta.appendChild(el('div', 'g-card-count',
      bits.length ? bits.join(' · ') : 'Coming soon'));

    if (!dense) {
      const styles = window.Catalog.categoriesFor(a.id).slice(0, 3);
      if (styles.length) meta.appendChild(el('div', 'g-card-styles', styles.join(' • ').toLowerCase()));
    }

    card.appendChild(meta);

    /* Appended after the meta so the code sits on the trailing edge of the
     * card, away from the name. renderQrInto returns false if the encoder is
     * missing, in which case nothing is appended — an empty white square on a
     * pink card would read as a broken image, not as a missing feature. */
    if (wantQr) {
      const qr = el('div', 'g-card-qr');
      qr.setAttribute('role', 'img');
      qr.setAttribute('aria-label', 'QR code linking to ' + a.name + ' on Instagram');
      qr.setAttribute('data-qr-url', a.instagram);
      if (renderQrInto(qr, a.instagram)) {
        card.appendChild(qr);
      } else {
        card.classList.remove('has-qr');
      }
    }

    if (count > 0) {
      onTap(card, () => {
        // An artist with sheets and no singles has nothing a grid improves
        // on — open the linear viewer directly, scoped to her sheets.
        if (window.Catalog.isSheetsOnlyArtist(a.id)) {
          view.artistId = a.id;
          view.cameFromGrid = false;
          openSheetViewer(0, false, window.Catalog.query({ artistId: a.id, types: ['sheet'] }));
        } else {
          openGrid(a.id);
        }
      });
    } else {
      card.disabled = true;
    }

    return card;
  }

  /* ── Browse by Category ───────────────────────────────────────────────────
   * New: categories previously existed only as filter chips inside a grid,
   * which meant a customer who wants "florals" had to first pick a scope they
   * did not care about. This makes style a first-class way in. Same equal-size
   * rule as the artist page. */
  function renderCategories() {
    view.name = 'categories';
    view.artistId = null;
    setMode('gallery');
    clear(root);

    const banner = seedBanner();
    if (banner) root.appendChild(banner);
    const header = buildHeader('Styles', renderCover);
    root.appendChild(header);

    const pane = el('div', 'g-home');
    const help = el('p', 'g-home-help');
    help.textContent = 'Tap a style to see everything in it.';
    pane.appendChild(help);

    const grid = el('div', 'g-homegrid');
    pane.appendChild(grid);
    root.appendChild(pane);

    const cats = window.Catalog.categoriesFor(null);
    const availH = availableHomeHeight([banner, header, help]);
    const availW = (root.clientWidth || DESIGN_W) - 32;
    const layout = pickHomeLayout(cats.length, 0, availH, availW);

    grid.style.setProperty('--home-cols', String(layout.cols));
    grid.style.setProperty('--home-rows', String(layout.rows));
    grid.style.setProperty('--home-gap', HOME_GAP + 'px');
    grid.classList.toggle('is-overflow', layout.overflow);
    if (layout.overflow) grid.setAttribute('data-native-scroll', '');

    cats.forEach(c => {
      const n = window.Catalog.query({ categories: [c] }).length;
      const card = el('button', 'g-card g-card-category');
      card.appendChild(el('div', 'g-card-name', c));
      card.appendChild(el('div', 'g-card-count',
        n + (n === 1 ? ' piece' : ' pieces')));
      onTap(card, () => {
        view.artistId = null;
        view.categories = [c];
        view.types = null;
        view.cameFromCategories = true;
        renderGrid();
      });
      grid.appendChild(card);
    });

    homeLayout = Object.assign({}, layout, {
      availH, bannerRows: 0, artistCount: cats.length,
      totalH: layout.rows * layout.cardH + HOME_GAP * (layout.rows - 1),
    });
    resetIdle();
  }

  /* ── Grid (PRD §3.2) ───────────────────────────────────────────────────── */
  function openGrid(artistId) {
    view.artistId = artistId;
    view.categories = [];
    view.types = null;
    renderGrid();
  }

  function renderGrid() {
    view.name = 'grid';
    setMode('gallery');
    clear(root);

    const artist = view.artistId
      ? snap.artists.find(a => a.id === view.artistId)
      : null;

    const banner = seedBanner();
    if (banner) root.appendChild(banner);
    // Back goes where you came from, not always to the cover.
    const backTo = artist ? renderArtists
                  : (view.cameFromCategories ? renderCategories : renderCover);
    const backTitle = artist ? artist.name
                     : (view.categories.length === 1 ? view.categories[0] : 'All Flash');
    root.appendChild(buildHeader(backTitle, backTo));
    root.appendChild(buildFilterBar(artist));

    const scroll = el('div', 'g-scroll g-scroll-grid');
    scroll.setAttribute('data-native-scroll', '');

    // Artist views get a follow panel above the grid. It scrolls away with the
    // content rather than pinning, so it never eats grid space on a screen
    // whose whole job is showing artwork.
    if (artist) {
      const info = artistInfoPanel(artist);
      if (info) scroll.appendChild(info);
    }

    const items = window.Catalog.query({
      artistId: view.artistId,
      categories: view.categories,
      types: view.types,
      sort: view.sort,
    });
    // Provisional; layoutModules overwrites it with the arranged order below.
    view.items = items;

    if (!items.length) {
      scroll.appendChild(emptyState());
    } else {
      const gridWidthPx = root.clientWidth || DESIGN_W;
      const cols = pickGridColumns();
      const gridW = gridWidthPx - 28;
      const cell = Math.floor((gridW - GRID_GAP * (cols - 1)) / cols);

      // layoutEven returns the order it used so detail-view swiping matches
      // what is on screen.
      view.items = layoutEven(scroll, items, cols, cell);
      lastGridCols = cols;
      lastGridWidth = gridWidthPx;
    }

    root.appendChild(scroll);
    resetIdle();
  }


  /* Swaps the sheet viewer's corner QR between the studio default and a
   * specific artist. Uses the badge that already exists in the markup rather
   * than introducing a second QR treatment. */
  function syncSheetQr(artistId) {
    const badge = document.getElementById('qrBadge');
    if (!badge) return;

    const artist = artistId ? snap.artists.find(a => a.id === artistId) : null;
    const url = (artist && artist.instagram) || DEFAULT_QR_URL;
    const label = artist ? 'Follow ' + (artist.handle || artist.name) : DEFAULT_QR_LABEL;

    if (badge.getAttribute('data-qr-url') === url) return;  // already correct

    clear(badge);
    badge.setAttribute('data-qr-url', url);
    badge.setAttribute('aria-label', 'QR code linking to ' + url);
    renderQrInto(badge, url);

    let cap = document.getElementById('qrCaption');
    if (!cap) {
      cap = el('div', 'qr-caption');
      cap.id = 'qrCaption';
      if (badge.parentNode) badge.parentNode.insertBefore(cap, badge.nextSibling);
    }
    cap.textContent = label;
  }

  /* ── Artist follow panel ──────────────────────────────────────────────────
   * A QR to the artist's Instagram, on their own view only. Deliberately not
   * on grid tiles: a code per tile would be unscannable at that size and
   * would bury the artwork the grid exists to show.
   *
   * Sized well above the ~200px floor for a comfortable phone-to-panel scan,
   * and styled with the project's existing .qr-badge look rather than a
   * second QR treatment. */
  function artistInfoPanel(artist) {
    if (!artist || !artist.instagram) return null;

    const panel = el('div', 'g-artistinfo');

    const badge = el('div', 'qr-badge qr-inline');
    badge.setAttribute('role', 'img');
    badge.setAttribute('aria-label', 'QR code linking to ' + artist.name + ' on Instagram');
    // Recorded so tests can assert what was encoded without decoding pixels.
    badge.setAttribute('data-qr-url', artist.instagram);
    if (!renderQrInto(badge, artist.instagram)) return null;
    panel.appendChild(badge);

    const meta = el('div', 'g-artistinfo-meta');
    // "Follow" told a customer what the button does for the ARTIST, not what
    // it does for them. What they actually want to know standing in front of
    // the panel is whether this leads to photos of real finished tattoos —
    // so the lead line says that, and the handle sits underneath as the
    // supporting detail rather than the headline.
    meta.appendChild(el('div', 'g-artistinfo-follow',
      'See photos of their previous work on Instagram'));
    meta.appendChild(el('div', 'g-artistinfo-handle', artist.handle || artist.name));
    if (artist.bio) meta.appendChild(el('div', 'g-artistinfo-bio', artist.bio));
    meta.appendChild(el('div', 'g-artistinfo-hint', 'Scan with your phone camera'));
    panel.appendChild(meta);

    return panel;
  }

  /* Renders a QR into `node` using the vendored qrcode.js already in the
   * project. Returns false if the library is missing so callers can drop the
   * panel entirely rather than leave an empty white square on the wall. */
  function renderQrInto(node, url) {
    return renderStyledQr(node, url);
  }

  /* Kept for reference and as the fallback shape if styling is ever backed
   * out — plain square modules at ECC M. Not called. */
  function renderPlainQr(node, url) {
    if (typeof qrcode !== 'function') return false;
    let qr;
    try {
      // Type 0 = auto-size for the payload; 'M' matches the existing badge.
      qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
    } catch (err) {
      console.log('[qr] encode failed for', url, err && err.message);
      return false;
    }

    const count = qr.getModuleCount();
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${count} ${count}`);
    svg.setAttribute('shape-rendering', 'crispEdges');

    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
      }
    }
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', QR_INK);
    svg.appendChild(path);
    node.appendChild(svg);
    return true;
  }

  /* ── Styled QR rendering ───────────────────────────────────────────────
   * Rounded modules and rounded finder patterns. Three rules govern this and
   * none of them are aesthetic:
   *
   *   1. Error correction is raised to H (30%). Softening every module's
   *      silhouette costs dark area, and H is the budget that pays for it.
   *      It grows the code from 29 to 41 modules, which is why the module
   *      size arithmetic in gallery.css matters.
   *   2. Corners are rounded ONLY where a module has no neighbour on those
   *      two sides. A run of adjacent modules therefore stays one solid bar
   *      with a soft outline, instead of dissolving into beads that a
   *      decoder has to guess at. This is the difference between "styled"
   *      and "broken".
   *   3. Ink stays near-black. Brand pink on white is 4.1:1 — fine for text,
   *      not for something a phone camera has to threshold in shop lighting.
   *      The colour goes on the panel behind the code, not the code.
   */
  const QR_INK = '#000000';   // pure black: best contrast for scanning
  const QR_ECC = 'H';
  const QR_R = 0.42;   // module corner radius, in module units

  /* Finder patterns stay SQUARE, and this was measured, not assumed.
   *
   * Sweeping the two radii independently against the OpenCV decoder gave a
   * result that is the opposite of the intuition:
   *
   *     rounded modules, square finders   21/21 surfaces decode
   *     square modules,  rounded finders   2/21
   *     both rounded                       2/21
   *
   * Rounding the modules costs nothing — a decoder samples each module at its
   * centre, and softening the corners of a cell never moves its centre. The
   * finder patterns are a different object: they are not data, they are the
   * three fixed targets a decoder hunts for by scanning lines across the
   * image looking for a 1:1:3:1:1 run of dark:light:dark:light:dark. Round
   * their corners and that ratio stops holding on every scan line that does
   * not pass exactly through the middle, so detection fails before decoding
   * is even attempted — which is why the failures come back as an empty
   * string rather than a wrong URL.
   *
   * So: rounded modules and a rounded container tile, square eyes. If Joshua
   * wants the eyes softened too, the honest answer is that it costs the
   * scan. */
  const QR_FINDER_R = 0.001;
  const QR_PUPIL_R = 0.001;

  function roundedRectPath(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    return `M${x + r},${y}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}` +
           `v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}` +
           `h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}` +
           `v${-(h - 2 * r)}a${r},${r} 0 0 1 ${r},${-r}z`;
  }

  /* One module, rounded only on corners that face open space. */
  function modulePath(c, r, dark) {
    const at = (rr, cc) => !!(dark[rr] && dark[rr][cc]);
    const up = at(r - 1, c), dn = at(r + 1, c), lf = at(r, c - 1), rt = at(r, c + 1);
    const tl = (!up && !lf) ? QR_R : 0, tr = (!up && !rt) ? QR_R : 0;
    const br = (!dn && !rt) ? QR_R : 0, bl = (!dn && !lf) ? QR_R : 0;
    const x = c, y = r;
    let d = `M${x + tl},${y}`;
    d += `h${1 - tl - tr}`;
    if (tr) d += `a${tr},${tr} 0 0 1 ${tr},${tr}`;
    d += `v${1 - tr - br}`;
    if (br) d += `a${br},${br} 0 0 1 ${-br},${br}`;
    d += `h${-(1 - br - bl)}`;
    if (bl) d += `a${bl},${bl} 0 0 1 ${-bl},${-bl}`;
    d += `v${-(1 - bl - tl)}`;
    if (tl) d += `a${tl},${tl} 0 0 1 ${tl},${-tl}`;
    return d + 'z';
  }

  function renderStyledQr(node, url) {
    if (typeof qrcode !== 'function') return false;
    let qr;
    try {
      qr = qrcode(0, QR_ECC);
      qr.addData(url);
      qr.make();
    } catch (err) {
      console.log('[qr] encode failed for', url, err && err.message);
      return false;
    }

    const n = qr.getModuleCount();
    const dark = [];
    for (let r = 0; r < n; r++) {
      dark[r] = [];
      for (let c = 0; c < n; c++) dark[r][c] = qr.isDark(r, c);
    }

    /* The three finder patterns are drawn as shapes, not as modules, so they
     * keep the crisp 1:1:3:1:1 ratio a decoder scans for through their
     * centre. Rounding their outline is safe; rounding them into circles is
     * not, which is why the radius is a fifth of the square and no more. */
    const finders = [[0, 0], [0, n - 7], [n - 7, 0]];
    const inFinder = (r, c) => finders.some(([fr, fc]) =>
      r >= fr && r < fr + 7 && c >= fc && c < fc + 7);

    let d = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (dark[r][c] && !inFinder(r, c)) d += modulePath(c, r, dark);
      }
    }
    // Outer ring: a rounded square with a rounded square hole (evenodd).
    for (const [fr, fc] of finders) {
      d += roundedRectPath(fc, fr, 7, 7, QR_FINDER_R);
      d += roundedRectPath(fc + 1, fr + 1, 5, 5, QR_FINDER_R - 0.5);
      d += roundedRectPath(fc + 2, fr + 2, 3, 3, QR_PUPIL_R);
    }

    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', QR_INK);
    path.setAttribute('fill-rule', 'evenodd');
    svg.appendChild(path);
    node.appendChild(svg);
    node.setAttribute('data-qr-modules', String(n));
    return true;
  }

  /* Empty state — never a blank screen (PRD §3.2). */
  function emptyState() {
    const box = el('div', 'g-empty');
    box.appendChild(el('div', 'g-empty-title', 'Nothing matches that combination'));
    box.appendChild(el('div', 'g-empty-sub', 'Try a different style, or clear the filters to see everything.'));
    const reset = el('button', 'g-chip g-chip-clear', 'Clear filters');
    onTap(reset, () => { view.categories = []; view.types = null; renderGrid(); });
    box.appendChild(reset);
    return box;
  }

  function buildFilterBar(artist) {
    const wrap = el('div', 'g-filterwrap');
    const bar = el('div', 'g-filterbar');
    bar.setAttribute('data-native-scroll', '');

    const cats = window.Catalog.categoriesFor(view.artistId);
    const hasFilters = view.categories.length > 0 || view.types !== null;

    if (hasFilters) {
      const clearChip = el('button', 'g-chip g-chip-clear', 'Clear');
      onTap(clearChip, () => { view.categories = []; view.types = null; renderGrid(); });
      bar.appendChild(clearChip);
    }

    // Studio-wide view gets artist chips too (PRD §3.2).
    if (!view.artistId) {
      snap.artists.forEach(a => {
        if (window.Catalog.countForArtist(a.id) === 0) return;
        const chip = el('button', 'g-chip g-chip-artist', a.name);
        onTap(chip, () => openGrid(a.id));
        bar.appendChild(chip);
      });
    }

    // Type toggle only earns its space when both kinds actually exist here.
    const scopeHasSheets = window.Catalog
      .query({ artistId: view.artistId, types: ['sheet'] }).length > 0;
    const scopeHasSingles = window.Catalog
      .query({ artistId: view.artistId, types: ['design'] }).length > 0;

    if (scopeHasSheets && scopeHasSingles) {
      [['design', 'Designs'], ['sheet', 'Sheets']].forEach(([t, label]) => {
        const active = view.types && view.types[0] === t;
        const chip = el('button', 'g-chip' + (active ? ' is-active' : ''), label);
        onTap(chip, () => {
          view.types = active ? null : [t];
          renderGrid();
        });
        bar.appendChild(chip);
      });
    }

    cats.forEach(c => {
      const active = view.categories.indexOf(c) !== -1;
      const chip = el('button', 'g-chip' + (active ? ' is-active' : ''), c);
      onTap(chip, () => {
        const i = view.categories.indexOf(c);
        if (i === -1) view.categories.push(c); else view.categories.splice(i, 1);
        renderGrid();
      });
      bar.appendChild(chip);
    });

    wrap.appendChild(bar);
    return wrap;
  }

  /* ── Hybrid tiling ────────────────────────────────────────────────────────
   * A flash sheet is 9:16. Cropping it into a square grid cell hides the
   * composition that makes it a sheet, so instead a sheet claims a block of
   * 2 columns x 3 rows — roughly 2:3, close to its native shape — and the
   * three singles that follow it stack down the one leftover column beside
   * it. That is the "module": one sheet plus the next three designs, filling
   * a complete 3x3 band with no holes.
   *
   * Consecutive modules alternate which side the sheet sits on, so a gallery
   * with several sheets reads as a rhythm rather than a column of identical
   * blocks. `grid-auto-flow: dense` packs the singles into the gap.
   */
  /**
   * Spread the sheets evenly through the singles instead of leaving them
   * wherever the upload dates happened to put them.
   *
   * Sorted order alone clusters sheets — three uploaded the same week land
   * next to each other, producing three big blocks in a row and then a long
   * uninterrupted field of small squares. Evenly spacing them gives the page
   * a rhythm: a big block, some singles, another big block on the other side.
   *
   * Returns a flat item list in display order. Relative order WITHIN sheets
   * and WITHIN singles is preserved, so "newest first" still holds inside
   * each kind — only the interleaving changes.
   */
  function arrangeHybrid(items, cols) {
    const sheets = items.filter(i => i.type === 'sheet');
    const singles = items.filter(i => i.type !== 'sheet');

    // Nothing to interleave, or no room for a module — leave it alone.
    if (!sheets.length || !singles.length || cols < 3) return items.slice();

    const perModule = cols - 1;          // singles packed beside one sheet
    const out = [];
    let si = 0;

    // How many singles sit between one sheet and the next. Never less than
    // the module itself consumes, or blocks would overlap.
    const gapSingles = Math.max(
      perModule,
      Math.round(singles.length / sheets.length / perModule) * perModule
    );

    sheets.forEach((sheet, idx) => {
      out.push(sheet);
      // The singles that pack into the module's leftover column.
      for (let k = 0; k < perModule && si < singles.length; k++) out.push(singles[si++]);
      // Then a breather of plain rows before the next sheet.
      if (idx < sheets.length - 1) {
        const breather = gapSingles - perModule;
        for (let k = 0; k < breather && si < singles.length; k++) out.push(singles[si++]);
      }
    });

    while (si < singles.length) out.push(singles[si++]);
    return out;
  }

  /**
   * Places tiles, giving each sheet a block sized to its OWN proportions.
   *
   * Rows are square cells the width of a column, so a sheet spanning 2 columns
   * and N rows has a known aspect; N is chosen as whichever makes the block
   * closest to the sheet's real shape. A square sheet gets a 2x2 block, a tall
   * one gets 2x3. Fixing the span at 3 was what cropped the wide sheets.
   */
  /**
   * Columns for the current viewport. The kiosk is 1080px and gets 3, but this
   * page is also opened on phones — the QR code in the sheet viewer points
   * people at it — so the count has to be decided from the actual width, not
   * assumed. Previously JS assumed 3 while CSS media queries independently
   * switched to 2, and the module spans were computed against a grid that no
   * longer existed. That is what broke the phone layout.
   */
  function pickGridColumns() {
    // ONE layout everywhere. The kiosk and a phone are both portrait, so the
    // composition scales rather than reflows: a phone shows the same 3-column
    // grid, the same 2x3 sheet modules and the same alternation, just smaller.
    //
    // The original phone bug came from having two sources of truth — CSS
    // media queries dropped the grid to 2 columns while this code kept
    // computing module spans for 3. Column count now comes from here and
    // nowhere else, and it does not vary by width.
    return (cfg.grid && cfg.grid.columns) || 3;
  }

  /**
   * How many columns and rows a sheet's block claims, per breakpoint:
   *
   *   3 columns — sheet takes 2 columns; the 3 singles after it stack down
   *               the leftover column, filling a complete band.
   *   2 columns — sheet takes 1 column; the 2 singles after it stack beside
   *               it. Same idea, one column narrower.
   *   1 column  — no module at all. The sheet is simply full width and the
   *               singles stack underneath, which is the only thing that
   *               reads correctly at that size.
   *
   * Rows are chosen so the block's proportions land close to the image's own,
   * because the tile crops to fill (never letterboxes) and a badly matched
   * block would crop away most of the artwork.
   */
  function moduleSpan(aspect, cols) {
    if (cols < 2) return null;
    const colSpan = Math.min(2, cols);
    const a = aspect || 0.5625;                  // unknown: assume a tall sheet
    // A block colSpan wide and n rows tall has aspect ≈ colSpan / n. Rows are
    // chosen to land near the image's own proportions, because the tile crops
    // to fill and a badly matched block would crop away real artwork.
    const rows = Math.max(1, Math.min(4, Math.round(colSpan / a)));
    return { colSpan, rows };
  }

  /**
   * THE GRID — [CHANGED 2 Oct 2026, Joshua: "the grid is not good"].
   *
   * The staggered 2-column sheet blocks (layoutModules, below, now unused)
   * left big white gaps beside each sheet and cropped them to fill. Now two
   * plain, even grids:
   *   singles — square tiles, `cols` across (3 on the wall)
   *   sheets  — one even grid of identical portrait tiles, 2 across, each
   *             sheet shown WHOLE (contain, never cropped); a tap opens the
   *             sheet viewer at full size, no zoom
   * Singles first, then sheets, under a small label when both are present.
   */
  function layoutEven(scroll, items, cols, cell) {
    const singles = items.filter(i => i.type !== 'sheet');
    const sheets = items.filter(i => i.type === 'sheet');

    if (singles.length) {
      const g = el('div', 'g-grid');
      g.style.setProperty('--cols', String(cols));
      g.style.setProperty('--cell', cell + 'px');
      singles.forEach((item, i) => g.appendChild(tile(item, i)));
      scroll.appendChild(g);
    }
    if (sheets.length) {
      if (singles.length) scroll.appendChild(el('div', 'g-section-label', 'Full flash sheets'));
      const g = el('div', 'g-grid g-grid-sheets');
      g.style.setProperty('--cols', String(Math.max(1, Math.min(2, cols - 1))));
      sheets.forEach((item, k) => g.appendChild(tile(item, singles.length + k)));
      scroll.appendChild(g);
    }
    return singles.concat(sheets);
  }

  function layoutModules(grid, items, cols) {
    let moduleIndex = 0;
    const ordered = arrangeHybrid(items, cols);

    ordered.forEach((item, i) => {
      const node = tile(item, i);

      if (item.type === 'sheet') {
        const span = moduleSpan(item.aspect, cols);
        if (span) {
          // Alternate which side the block sits on so repeated modules read
          // as a rhythm. With colSpan 1 the alternation is simply column 1 vs
          // the last column.
          const onLeft = moduleIndex % 2 === 0;
          const startCol = onLeft ? 1 : (cols - span.colSpan + 1);
          node.classList.add('g-tile-module', onLeft ? 'is-left' : 'is-right');
          node.style.gridColumn = startCol + ' / span ' + span.colSpan;
          node.style.gridRow = 'span ' + span.rows;
          moduleIndex++;
        }
      }
      grid.appendChild(node);
    });

    // Keep the item order the detail view swipes through in sync with what is
    // actually on screen, or tapping the third tile opens the seventh design.
    return ordered;
  }

  /* ── Tiles ─────────────────────────────────────────────────────────────────
   * Two tile modules sharing one square cell so the grid stays uniform:
   *   design — thumb fills the cell (cover)
   *   sheet  — whole sheet visible, letterboxed (contain) + badge
   * A sheet cropped to square would hide most of its content, which defeats
   * the point of showing it at all. */
  function tile(item, index) {
    const t = el('button', 'g-tile g-tile-' + item.type);

    const shell = el('div', 'g-tile-img');
    const img = el('img');
    img.src = item.thumb || item.image;
    img.alt = item.title || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.draggable = false;
    img.addEventListener('error', () => shell.classList.add('is-broken'), { once: true });
    shell.appendChild(img);
    t.appendChild(shell);

    if (item.type === 'sheet') t.appendChild(el('div', 'g-tile-badge', 'FULL SHEET'));
    else if (item.featured) t.appendChild(el('div', 'g-tile-badge g-tile-badge-featured', 'FEATURED'));

    const cap = el('div', 'g-tile-cap');
    cap.appendChild(el('div', 'g-tile-title', item.title || ''));
    if (!view.artistId && item.artistName) {
      cap.appendChild(el('div', 'g-tile-artist', item.artistName));
    }
    t.appendChild(cap);

    onTap(t, () => {
      if (item.type === 'sheet') {
        // Browse within the sheets of the CURRENT filtered view, so back and
        // forward stay inside what the customer was looking at.
        const sheetsHere = view.items.filter(i => i.type === 'sheet');
        openSheetViewer(sheetsHere.indexOf(item), true, sheetsHere);
      } else {
        openDetail(index);
      }
    });
    return t;
  }

  /* ── Detail (PRD §3.3) ─────────────────────────────────────────────────── */
  let detailEls = null;

  function openDetail(index) {
    view.name = 'detail';
    view.index = index;
    setMode('gallery');
    clear(root);

    const wrap = el('div', 'g-detail');

    const stage = el('div', 'g-detail-stage');
    const inner = el('div', 'g-detail-inner');
    const img = el('img', 'g-detail-img');
    img.draggable = false;
    inner.appendChild(img);
    stage.appendChild(inner);
    wrap.appendChild(stage);

    const bar = el('div', 'g-detail-bar');
    const back = el('button', 'g-back g-back-detail');
    back.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>' +
      '<span>Back</span>';
    onTap(back, () => renderGrid());
    bar.appendChild(back);
    const counter = el('div', 'g-detail-counter');
    bar.appendChild(counter);
    wrap.appendChild(bar);

    const meta = el('div', 'g-detail-meta');
    wrap.appendChild(meta);

    const prev = el('button', 'g-detail-nav g-detail-prev');
    prev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';
    const next = el('button', 'g-detail-nav g-detail-next');
    next.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    onTap(prev, () => step(-1));
    onTap(next, () => step(1));
    wrap.appendChild(prev);
    wrap.appendChild(next);

    root.appendChild(wrap);
    detailEls = { img, inner, stage, meta, counter, prev, next };
    bindDetailGestures(stage, inner, img);
    paintDetail();
    resetIdle();
  }

  function step(delta) {
    if (!view.items.length) return;
    const n = view.items.length;
    view.index = (view.index + delta + n) % n;
    resetDetailZoom();
    paintDetail();
  }

  function paintDetail() {
    const item = view.items[view.index];
    if (!item || !detailEls) return;

    detailEls.img.src = item.image || item.thumb;
    detailEls.img.alt = item.title || '';
    detailEls.counter.textContent = (view.index + 1) + ' / ' + view.items.length;

    clear(detailEls.meta);
    detailEls.meta.appendChild(el('div', 'g-detail-title', item.title || ''));
    const sub = [];
    if (item.artistName) sub.push(item.artistName);
    if (item.categories.length) sub.push(item.categories.join(' • '));
    if (sub.length) detailEls.meta.appendChild(el('div', 'g-detail-sub', sub.join('  —  ')));

    const only = view.items.length <= 1;
    detailEls.prev.classList.toggle('hidden', only);
    detailEls.next.classList.toggle('hidden', only);

    // Preload neighbours so a swipe never lands on a blank frame.
    [1, -1].forEach(d => {
      const nItem = view.items[(view.index + d + view.items.length) % view.items.length];
      if (nItem) { const p = new Image(); p.src = nItem.image || nItem.thumb; }
    });
  }

  /* Detail zoom/pan. Deliberately mirrors the sheet viewer's model — tap to
   * zoom in on a point, tap again to zoom out, drag to pan while zoomed —
   * so the two viewers do not teach conflicting gestures. Pinch is left off
   * here for the same reason it is off there: on this panel a stray second
   * contact during a swipe reads as a pinch and hijacks navigation. */
  let dScale = 1, dTx = 0, dTy = 0;
  const D_MAX = 5;

  function resetDetailZoom() {
    dScale = 1; dTx = 0; dTy = 0;
    if (detailEls) {
      detailEls.inner.style.transition = 'none';
      detailEls.inner.style.transform = 'translate(0px,0px) scale(1)';
    }
  }

  function applyDetail(animate) {
    if (!detailEls) return;
    const s = detailEls.stage;
    const w = s.clientWidth, h = s.clientHeight;
    const iw = w * dScale, ih = h * dScale;
    dTx = iw <= w ? 0 : Math.min(0, Math.max(w - iw, dTx));
    dTy = ih <= h ? 0 : Math.min(0, Math.max(h - ih, dTy));
    detailEls.inner.style.transition = animate ? 'transform 0.25s ease-out' : 'none';
    detailEls.inner.style.transform = `translate(${dTx}px,${dTy}px) scale(${dScale})`;
  }

  function bindDetailGestures(stage, inner) {
    let start = null, tracked = null, dragging = false, multi = false;

    stage.addEventListener('touchstart', e => {
      e.preventDefault();
      if (start) { if (e.touches.length >= 2) multi = true; return; }
      const t = e.touches[0];
      if (!t) return;
      multi = e.touches.length >= 2;
      tracked = t.identifier;
      dragging = false;
      start = { x: t.clientX, y: t.clientY, tx: dTx, ty: dTy };
    }, { passive: false });

    stage.addEventListener('touchmove', e => {
      e.preventDefault();
      if (!start) return;
      let t = null;
      for (let i = 0; i < e.touches.length; i++) {
        if (e.touches[i].identifier === tracked) { t = e.touches[i]; break; }
      }
      if (!t) return;
      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      if (!dragging && Math.hypot(dx, dy) > TAP_TOLERANCE) dragging = true;
      if (dragging && dScale > 1.01) {
        dTx = start.tx + dx; dTy = start.ty + dy;
        applyDetail(false);
      }
    }, { passive: false });

    stage.addEventListener('touchend', e => {
      e.preventDefault();
      if (!start) return;
      let t = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === tracked) { t = e.changedTouches[i]; break; }
      }
      if (!t) return;

      const dx = t.clientX - start.x, dy = t.clientY - start.y;
      const moved = Math.hypot(dx, dy);

      if (moved <= TAP_TOLERANCE && !multi) {
        const rect = stage.getBoundingClientRect();
        toggleDetailZoom(t.clientX - rect.left, t.clientY - rect.top);
      } else if (dScale <= 1.01 && Math.abs(dx) > SWIPE_THRESHOLD
                 && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
        step(dx < 0 ? 1 : -1);
      }

      start = null; tracked = null; dragging = false; multi = false;
    }, { passive: false });

    stage.addEventListener('touchcancel', () => {
      start = null; tracked = null; dragging = false; multi = false;
    }, { passive: false });

    // Desktop preview only.
    stage.addEventListener('click', e => {
      if (e.detail === 0) return;
      const rect = stage.getBoundingClientRect();
      toggleDetailZoom(e.clientX - rect.left, e.clientY - rect.top);
    });
  }

  function toggleDetailZoom(ox, oy) {
    /* Zoom off (config.zoom !== true): the detail view is a lightbox, and
     * tapping the picture closes it, back to where the customer was. */
    if (cfg.zoom !== true) { renderGrid(); return; }
    if (dScale > 1.01) {
      dScale = 1; dTx = 0; dTy = 0;
      applyDetail(true);
    } else {
      const target = 3;
      const ratio = target / dScale;
      dTx = ox - ratio * (ox - dTx);
      dTy = oy - ratio * (oy - dTy);
      dScale = target;
      applyDetail(true);
    }
  }

  /* ── Sheet viewer handoff ──────────────────────────────────────────────── */
  /* `list` is catalog sheet items; `index` is the position within that list.
   * Passing the list through (rather than an index into data.js) is what lets
   * an artist's own sheets be browsed in isolation. */
  function openSheetViewer(index, fromGrid, list) {
    view.name = 'sheets';
    view.cameFromGrid = !!fromGrid;
    setMode('sheets');

    // A sheets-only artist never reaches the grid, so her follow QR would be
    // unreachable. Repoint the sheet viewer's existing corner badge at her
    // profile while her sheets are on screen, and restore it on the way out.
    syncSheetQr(view.artistId);

    if (window.SheetViewer && typeof window.SheetViewer.setSheets === 'function') {
      const set = (list && list.length) ? list : window.Catalog.sheets();
      window.SheetViewer.setSheets(set.map(sheetItem => ({
        title: sheetItem.title,
        file: sheetItem.image,
      })));
    }

    /* The back control is shown whenever the sheet viewer was reached FROM
     * the gallery — from a grid tile or from the home screen's sheets card,
     * both of which are dead ends without it. `fromGrid` only decides where
     * back goes (grid vs home), never whether the control exists.
     *
     * The sole case with no back control is a sheets-only kiosk, where the
     * sheet viewer is the whole app and there is nothing above it. */
    document.body.classList.add('sheets-has-back');

    if (window.SheetViewer && typeof window.SheetViewer.openAt === 'function') {
      window.SheetViewer.openAt(index || 0);
    }
    resetIdle();
  }

  function leaveSheetViewer() {
    if (view.cameFromGrid) renderGrid();
    else if (view.artistId) renderArtists();   // sheets-only artist
    else goHome();
  }

  function goHome() {
    document.body.classList.remove('sheets-has-back');
    resetDetailZoom();
    detailEls = null;
    view.cameFromCategories = false;
    renderCover();
  }

  /* ── Boot ──────────────────────────────────────────────────────────────── */
  async function boot() {
    if (booted) return;
    booted = true;

    root = document.getElementById('gallery');
    if (!root) return;

    snap = await window.Catalog.load();

    /* THE FALLBACK. Zero individual designs → the gallery never mounts and
     * the kiosk is byte-for-byte the experience that is live today. */
    if (snap.sheetsOnly) {
      setMode('sheets');
      document.body.classList.add('sheets-only');
      return;
    }

    if (snap.skipHome) {
      const only = snap.artists.find(a => window.Catalog.countForArtist(a.id) > 0);
      openGrid(only ? only.id : null);
    } else {
      renderCover();
    }

    window.Catalog.startAutoRefresh(fresh => {
      snap = fresh;
      if (view.name === 'cover') renderCover();
      else if (view.name === 'artists') renderArtists();
      else if (view.name === 'categories') renderCategories();
      else if (view.name === 'grid') renderGrid();
    });
  }

  let lastGridCols = null;
  let lastGridWidth = 0;
  let resizeTimer = null;

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!booted || view.name !== 'grid') return;
      // Columns never change, but the square cell size is derived from the
      // measured width, so a real width change still needs a re-measure.
      // iOS Safari fires resize constantly as the URL bar collapses, so only
      // react to a meaningful change or it fights the user's scrolling.
      const w = (root && root.clientWidth) || DESIGN_W;
      if (Math.abs(w - lastGridWidth) > 24) renderGrid();
    }, 150);
  });

  window.addEventListener('orientationchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (booted && view.name === 'grid') renderGrid(); }, 250);
  });

  /* Any touch anywhere postpones the idle reset. */
  document.addEventListener('touchstart', () => { if (booted) resetIdle(); },
    { capture: true, passive: true });

  return {
    boot,
    goHome,
    renderArtists,
    renderCategories,
    leaveSheetViewer,
    /* script.js calls this the moment the splash is dismissed. In sheets-only
     * mode it must do nothing at all — the legacy viewer is already correct.
     *
     * Otherwise this always lands on the top level, never on wherever the
     * last customer happened to stop. The splash reappears after idle, so a
     * dismissal means a new person is standing there (PRD §4.3). */
    onSplashDismissed() {
      if (!snap || snap.sheetsOnly) return;
      document.body.classList.remove('sheets-has-back');
      detailEls = null;
      if (snap.skipHome) {
        const only = snap.artists.find(a => window.Catalog.countForArtist(a.id) > 0);
        openGrid(only ? only.id : null);
      } else {
        view.cameFromCategories = false;
        renderCover();
      }
      resetIdle();
    },
    get state() { return view; },
    get snapshot() { return snap; },
    /* The solved home-screen geometry — column count, row count, resulting
     * card height, and whether it had to fall back to scrolling. */
    get homeLayout() { return homeLayout; },
    pickHomeLayout,
    pickGridColumns,
    moduleSpan,
    get gridCols() { return lastGridCols; },
  };
})();

document.addEventListener('DOMContentLoaded', () => window.KIOSK_ROUTER.boot());
if (document.readyState !== 'loading') window.KIOSK_ROUTER.boot();
