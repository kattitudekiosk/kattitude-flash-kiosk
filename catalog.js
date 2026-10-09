/* Flash Gallery — catalog layer
 *
 * One job: turn whatever the configured source is (placeholder seed, live
 * Supabase, or nothing at all) into ONE normalized shape the UI can render
 * without caring where it came from.
 *
 * Nothing above this file knows about seed data, Supabase, or data.js. That
 * is what makes swapping placeholder content for real content a config edit
 * rather than a rewrite.
 *
 * Normalized item:
 *   { id, type: 'design' | 'sheet', artistId, artistName, artistHandle,
 *     title, image, thumb, categories: [name], featured, displayOrder,
 *     createdAt, sheetIndex }
 *
 * `sheetIndex` is present only on sheets and is the index into
 * GALLERY_DATA.sheets — it is how a grid tile hands off to the legacy linear
 * viewer, which addresses sheets positionally.
 */
window.Catalog = (function () {
  'use strict';

  const cfg = window.KIOSK_CONFIG || {};

  const state = {
    artists: [],
    categories: [],
    items: [],
    source: null,
    loadedAt: null,
    degraded: false,   // true when a live fetch failed and we're on stale data
    error: null,
  };

  /* ── Sheets ────────────────────────────────────────────────────
   * Sheets come from data.js, which is the live production source and stays
   * untouched. A sheet has no artist until someone assigns one; that is a
   * real state (the 4 current sheets are studio-wide), so artistId is null
   * rather than faked. */
  function loadSheets() {
    if (cfg.includeSheets === false) return [];

    // data.js declares `const GALLERY_DATA`. A top-level `const` in a classic
    // script creates a global LEXICAL binding, which is not a property of
    // `window` — so `window.GALLERY_DATA` is undefined here even though the
    // bare identifier resolves fine. Read the identifier, and keep the window
    // lookup as a fallback in case data.js is ever switched to `var`.
    const data = (typeof GALLERY_DATA !== 'undefined') ? GALLERY_DATA : window.GALLERY_DATA;
    if (!data || !Array.isArray(data.sheets)) return [];

    return data.sheets.map((sheet, i) => ({
      id: 'sheet-' + (sheet.id != null ? sheet.id : i),
      type: 'sheet',
      artistId: sheet.artistId || null,
      artistName: null,
      artistHandle: null,
      title: sheet.title || '',   // no made-up names (9 Oct 2026)
      image: sheet.file,
      thumb: sheet.thumb || sheet.file,
      categories: Array.isArray(sheet.categories) ? sheet.categories.slice() : [],
      featured: !!sheet.featured,
      displayOrder: i,
      createdAt: sheet.createdAt || null,
      sheetIndex: i,
    }));
  }

  /* ── Seed source ────────────────────────────────────────────────── */
  function loadSeed() {
    const seed = window.SEED_CATALOG;
    if (!seed) {
      return { artists: [], categories: [], designs: [] };
    }

    const byId = {};
    (seed.artists || []).forEach(a => { byId[a.id] = a; });

    const designs = (seed.designs || [])
      .filter(d => d.published !== false && d.approved !== false)
      .map(d => {
        const artist = byId[d.artistId] || null;
        return {
          id: d.id,
          type: d.type === 'sheet' ? 'sheet' : 'design',
          artistId: d.artistId || null,
          artistName: artist ? artist.name : null,
          artistHandle: artist ? artist.handle : null,
          title: d.title || '',
          image: d.image,
          thumb: d.thumb || d.image,
          categories: Array.isArray(d.categories) ? d.categories.slice() : [],
          featured: !!d.featured,
          displayOrder: d.displayOrder || 0,
          createdAt: d.createdAt || null,
          sheetIndex: null,
          // Real pixel dimensions. The grid uses these to give a sheet a block
          // that matches its actual shape — the four real sheets range from
          // 0.77 to a dead-square 1.0, nothing like the 9:16 the PRD assumed,
          // so a fixed block would crop them.
          width: d.width || null,
          height: d.height || null,
          aspect: (d.width && d.height) ? (d.width / d.height) : null,
        };
      });

    return {
      artists: (seed.artists || []).map(normalizeArtist),
      categories: (seed.categories || []).map(c => c.name),
      designs,
      // When the source carries its own sheet entries (attributed, dated),
      // the raw unattributed list from data.js must not be appended on top —
      // that would show every real sheet twice.
      providesSheets: !!seed.providesSheets,
    };
  }

  /* ── Live source (Supabase REST over the kiosk_catalog view) ─────────── */
  async function loadLive() {
    const live = cfg.live || {};
    if (!live.url) throw new Error('catalogSource is "live" but config.live.url is empty');

    const headers = live.anonKey
      ? { apikey: live.anonKey, Authorization: 'Bearer ' + live.anonKey }
      : {};

    async function get(url) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return res.json();
    }

    const [rows, artistRows, categoryRows] = await Promise.all([
      get(live.url),
      live.artistsUrl ? get(live.artistsUrl) : Promise.resolve([]),
      live.categoriesUrl ? get(live.categoriesUrl) : Promise.resolve([]),
    ]);

    const designs = (rows || []).map(r => ({
      id: r.id,
      type: r.type === 'sheet' ? 'sheet' : 'design',
      artistId: r.artist_id || null,
      artistName: r.artist_name || null,
      artistHandle: r.artist_handle || null,
      title: r.title || '',   // no "Untitled": a design with no name shows none
      image: r.image_url,
      thumb: r.thumb_url || r.image_url,
      categories: Array.isArray(r.categories) ? r.categories.slice() : [],
      featured: !!r.featured,
      displayOrder: r.display_order || 0,
      createdAt: r.created_at || null,
      sheetIndex: null,
      sourceName: r.source_name || null,
    }));

    // Artists can be derived from the catalog if no artists endpoint is set,
    // but then an artist with zero live designs is invisible. Prefer the
    // dedicated endpoint so empty artist cards still render.
    const artists = (artistRows && artistRows.length)
      ? artistRows.map(normalizeArtist)
      : deriveArtists(designs);

    return {
      artists,
      categories: (categoryRows || []).map(c => c.name),
      designs,
    };
  }

  function normalizeArtist(a) {
    /* HEADSHOTS — two sizes, one meaning.
     *
     * `portrait` is "the picture to draw", and it deliberately prefers the
     * 256px derivative the dashboard generates. Every place the kiosk shows a
     * face is small: the artist card well is 104px (84px when the card also
     * carries a QR) and the Follow panel is 160px. Pulling a 1024px original
     * for a 104px circle is 16x the pixels for no visible gain, and on the
     * home hub that is one download per artist on the roster.
     *
     * `portraitFull` keeps the original available for anything that ever
     * wants it, and is the fallback for a row uploaded before the derivative
     * existed — an artist whose photo predates this must not lose their face.
     */
    const full = a.portraitFull || a.portrait_url || a.portrait || '';
    const small = a.portraitThumb || a.portrait_thumb_url || '';
    return {
      id: a.id,
      name: a.name || 'Unnamed',
      handle: a.handle || '',
      bio: a.bio || '',
      portrait: small || full,
      portraitFull: full,
      // Studio Owner / Senior Artist / Junior Artist. Carried through for
      // ordering and possible display; hidden on the kiosk unless
      // KIOSK_CONFIG.showSeniority is turned on, since telling a walk-in
      // customer which artists are junior is a business decision, not a
      // layout one.
      seniority: a.seniority || '',
      // Full profile URL. Derived from the handle at seed/import time rather
      // than assembled in the view, so an artist whose socials move can be
      // corrected in one place from the dashboard.
      instagram: a.instagram || a.instagram_url || '',
      displayOrder: a.displayOrder != null ? a.displayOrder : (a.display_order || 0),
    };
  }

  function deriveArtists(designs) {
    const seen = new Map();
    designs.forEach(d => {
      if (!d.artistId || seen.has(d.artistId)) return;
      seen.set(d.artistId, {
        id: d.artistId, name: d.artistName || 'Unnamed',
        handle: d.artistHandle || '', bio: '',
        // No photo here by design: this path exists only when the artists
        // endpoint is unavailable, and the kiosk falls back to the generated
        // monogram, which cannot 404.
        portrait: '', portraitFull: '', displayOrder: seen.size,
      });
    });
    return [...seen.values()];
  }

  /* ── Load / refresh ─────────────────────────────────────────────── */
  /* Placeholder data is for the test harness ONLY (tools/verify.js sets
   * __KIOSK_TEST_ALLOW_SEED). Any page a customer can see is live — even if
   * config says 'seed' by mistake. */
  function sourceOf() {
    if (cfg.catalogSource === 'sheets-only') return 'sheets-only';
    if (cfg.catalogSource === 'seed' && window.__KIOSK_TEST_ALLOW_SEED === true) return 'seed';
    return 'live';
  }

  async function load() {
    const source = sourceOf();
    const sheets = loadSheets();

    // Explicit override: pretend the catalog is empty so the sheets-only
    // path can be exercised without deleting content.
    if (source === 'sheets-only') {
      apply({ artists: [], categories: [], designs: [] }, sheets, source);
      return snapshot();
    }

    let payload;
    try {
      payload = source === 'live' ? await loadLive() : loadSeed();
      state.degraded = false;
      state.error = null;
    } catch (err) {
      // Degrade, never blank. If we have a previous good load, keep showing
      // it; if this is the very first load, fall back to sheets alone, which
      // are local files and cannot fail to be available.
      console.warn('[catalog] load failed:', err && err.message ? err.message : err);
      state.error = err;
      state.degraded = true;
      if (state.loadedAt) return snapshot();
      payload = { artists: [], categories: [], designs: [] };
    }

    apply(payload, sheets, source);
    return snapshot();
  }

  function apply(payload, sheets, source) {
    state.artists = (payload.artists || []).slice()
      .sort((a, b) => a.displayOrder - b.displayOrder);
    /* A built-in studio sheet (data.js) that has since been dropped into an
     * artist's KIOSK MEDIA folder is shown once — under the artist — not
     * twice. Matched on file name, ignoring case, extension and a "_web"
     * suffix (Untitled_Artwork_2_web.JPEG is Untitled_Artwork_2.jpg). */
    const key = n => String(n || '').split('/').pop().replace(/\.[^.]+$/, '').replace(/_web$/i, '').toLowerCase();
    const claimed = new Set((payload.designs || []).map(d => d.sourceName).filter(Boolean).map(key));
    const studioSheets = sheets.filter(s => !claimed.has(key(s.image)));
    state.items = payload.providesSheets
      ? (payload.designs || []).slice()
      : (payload.designs || []).concat(studioSheets);
    state.source = source;
    state.loadedAt = Date.now();

    // Category list = configured vocabulary, but only the ones actually
    // present on live content. A chip that always returns zero results is
    // worse than no chip.
    const used = new Set();
    state.items.forEach(i => i.categories.forEach(c => used.add(c)));
    const declared = payload.categories || [];
    const ordered = declared.filter(c => used.has(c));
    used.forEach(c => { if (!ordered.includes(c)) ordered.push(c); });
    state.categories = ordered;
  }

  function startAutoRefresh(onChange) {
    const source = sourceOf();
    if (source !== 'live') return;
    const ms = (cfg.live && cfg.live.refreshMs) || 300000;
    setInterval(async () => {
      const before = state.items.length + ':' + state.loadedAt;
      await load();
      if (typeof onChange === 'function' && before !== state.items.length + ':' + state.loadedAt) {
        onChange(snapshot());
      }
    }, ms);
  }

  /* ── Queries ────────────────────────────────────────────────────── */
  function singles() { return state.items.filter(i => i.type === 'design'); }
  function sheets()  { return state.items.filter(i => i.type === 'sheet'); }

  /* Counts EVERYTHING an artist has, sheets included. Counting singles only
   * made a sheets-only artist look empty on the home screen and disabled her
   * card, which hid her work entirely. */
  function countForArtist(artistId) {
    return state.items.filter(i => i.artistId === artistId).length;
  }

  function countForArtistByType(artistId, type) {
    return state.items.filter(i => i.artistId === artistId && i.type === type).length;
  }

  /* True when an artist has sheets and no individual designs — her view must
   * open the linear sheet viewer, not a grid of four tiles. */
  function isSheetsOnlyArtist(artistId) {
    const items = state.items.filter(i => i.artistId === artistId);
    return items.length > 0 && items.every(i => i.type === 'sheet');
  }

  /** Categories present within a given scope, so an artist's filter bar only
   *  offers styles that artist actually works in. */
  function categoriesFor(artistId) {
    const scope = artistId
      ? state.items.filter(i => i.artistId === artistId)
      : state.items;
    const used = new Set();
    scope.forEach(i => i.categories.forEach(c => used.add(c)));
    return state.categories.filter(c => used.has(c));
  }

  /**
   * query({ artistId, categories, types, sort })
   *   artistId   — null for studio-wide
   *   categories — array; a design matches if it carries ANY of them (OR).
   *                OR is the right default on a kiosk: AND across two styles
   *                usually returns nothing and reads as a broken screen.
   *   types      — array of 'design' | 'sheet'; defaults to both
   *   sort       — 'newest' | 'artist' | 'category' | 'order'
   */
  function query(opts) {
    const o = opts || {};
    const cats = o.categories && o.categories.length ? o.categories : null;
    const types = o.types && o.types.length ? o.types : null;

    let out = state.items.filter(item => {
      if (o.artistId && item.artistId !== o.artistId) return false;
      if (types && types.indexOf(item.type) === -1) return false;
      if (cats && !item.categories.some(c => cats.indexOf(c) !== -1)) return false;
      return true;
    });

    const sort = o.sort || (cfg.grid && cfg.grid.defaultSort) || 'newest';
    out.sort(comparator(sort));
    return out;
  }

  function comparator(sort) {
    if (sort === 'artist') {
      return (a, b) => (a.artistName || '~').localeCompare(b.artistName || '~')
        || a.displayOrder - b.displayOrder;
    }
    if (sort === 'category') {
      return (a, b) => (a.categories[0] || '~').localeCompare(b.categories[0] || '~')
        || a.displayOrder - b.displayOrder;
    }
    if (sort === 'order') {
      return (a, b) => a.displayOrder - b.displayOrder;
    }
    // newest: featured floats up, then date desc, then explicit order
    return (a, b) => (b.featured - a.featured)
      || String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || a.displayOrder - b.displayOrder;
  }

  function snapshot() {
    const singleCount = singles().length;
    const sheetCount = sheets().length;
    return {
      artists: state.artists,
      categories: state.categories,
      items: state.items,
      source: state.source,
      degraded: state.degraded,
      error: state.error,

      hasSingles: singleCount > 0,
      hasSheets: sheetCount > 0,
      singleCount,
      sheetCount,

      /* THE fallback decision, in one place.
       *
       * [CHANGED 2 Oct 2026, Joshua: "yes go ahead and change the rule"]
       * Zero designs used to mean "straight into the linear sheet viewer",
       * which hid the artist cards — and with them every real headshot —
       * until somebody uploaded a design. Now the home screen shows whenever
       * there are artists to show: Browse by Artist (real photos, letter
       * circles for the rest) and the sheets, one tap away. The sheet viewer
       * is only the whole kiosk when there is nobody and nothing else. */
      sheetsOnly: singleCount === 0 && state.artists.length === 0 &&
        (cfg.sheetsOnlyFallback !== false),

      /* One artist and no sheets means the home hub has exactly one
       * destination — skip it and open that artist's grid directly. */
      skipHome: (cfg.skipHomeWhenSingleArtist !== false)
        && state.artists.filter(a => countForArtist(a.id) > 0).length <= 1
        && sheetCount === 0
        && singleCount > 0,
    };
  }

  return {
    load,
    startAutoRefresh,
    query,
    singles,
    sheets,
    countForArtist,
    countForArtistByType,
    isSheetsOnlyArtist,
    categoriesFor,
    snapshot,
    _normalizeArtist: normalizeArtist,
    get artists() { return state.artists; },
    get categories() { return state.categories; },
  };
})();
