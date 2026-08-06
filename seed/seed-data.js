/* Flash Gallery — SEED CATALOG (placeholder content)
 *
 * WHY THIS FILE IS COMMITTED, when .gitignore excludes seed/
 * ---------------------------------------------------------
 * .vercelignore says seed content "SHIPS to previews on purpose" — but that
 * only holds for a CLI deploy from a machine that has the files on disk. A
 * Vercel build FROM GITHUB cannot ship what was never committed, so
 * seed/seed-data.js 404'd on every git-based deploy, window.SEED_CATALOG was
 * undefined, catalog.js returned an empty catalog, and sheetsOnlyFallback
 * dropped the kiosk into the OLD linear sheet viewer.
 *
 * That is why the demo kept showing the old app. Not a stale deployment, not a
 * caching problem: a missing file, failing exactly the way it was designed to
 * fail safely.
 *
 * So this one is committed by hand, and it references ONLY images that are in
 * the repo (assets/sheets/), so it cannot 404 the way a generated seed with
 * generated art would.
 *
 * The four sheets are the studio's real placeholder artwork and carry their
 * true pixel dimensions — the grid sizes tiles from the real aspect ratio, and
 * these run 0.787 to a dead-square 1.0, which is exactly what catalog.js's own
 * comment warns a fixed block would crop. providesSheets is true so data.js's
 * unattributed copies are not appended on top and shown twice.
 *
 * The individual designs reuse those same four images on purpose. There is no
 * other artwork in this repository, and inventing filenames that do not exist
 * would put broken tiles on a wall. showSeedBanner stays on so nobody mistakes
 * this for the studio's real catalog.
 *
 * NO EMAILS AND NO PHONE NUMBERS, and portraits are generated monograms rather
 * than photographs — the same rule as the dashboard demo, for the same reason.
 * Real names and handles, so the per-artist QR codes scan through to real
 * Instagram profiles.
 *
 * Regenerate with tools/generate-seed.py once there is real seed art to point
 * at; delete this folder entirely when catalogSource goes to 'live'.
 */
window.SEED_CATALOG = (function () {
  'use strict';

  function monogram(name) {
    var ch = (name || '?').trim().charAt(0).toUpperCase();
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">' +
      '<rect width="512" height="512" fill="#0a0a0a"/>' +
      '<text x="256" y="256" fill="#ffffff" font-family="Inter,Helvetica,Arial" ' +
      'font-size="240" font-weight="700" text-anchor="middle" ' +
      'dominant-baseline="central">' + ch + '</text></svg>');
  }

  /* name, handle, seniority */
  var ROSTER = [
    ['Kat', '@Kattitudetattoo', 'Studio Owner'],
    ['Barbie', '@delicatelyscripted', 'Senior Artist'],
    ['Miranda', '@mirandaiink', 'Junior Artist'],
    ['Jen', '@inkedbyjemini', 'Junior Artist'],
    ['Naomi', '@Puratinta_26', 'Junior Artist'],
    ['Ally', '@allycat_ink', 'Junior Artist'],
    ['Alena', '@Alenanebotattoos', 'Senior Artist'],
  ];

  /* file, width, height — measured from the actual JPEGs, not assumed. */
  var SHEETS = [
    ['assets/sheets/IMG_1705.JPEG', 1320, 1677],
    ['assets/sheets/IMG_2120.JPEG', 1320, 1615],
    ['assets/sheets/Untitled_Artwork.JPEG', 2550, 3300],
    ['assets/sheets/Untitled_Artwork_2_web.JPEG', 3000, 3000],
  ];

  var CATS = ['Traditional', 'Neo-Traditional', 'Blackwork', 'Fine Line', 'Floral',
              'Snakes', 'Daggers', 'Script', 'Panther', 'Swallow'];

  var TITLES = ['Dagger & Rose', 'Coiled Viper', 'Wild Bloom', 'Panther Head',
                'Swallow Pair', 'Nightshade', 'Anchor', 'Moth', 'Hand of Fate',
                'Thorn Script', 'Serpent Crown', 'Ember'];

  var ROMAN = ['I', 'II', 'III', 'IV'];

  var artists = ROSTER.map(function (r, i) {
    return {
      id: 'a-' + (i + 1),
      name: r[0],
      handle: r[1],
      seniority: r[2],
      bio: '',
      portrait_url: monogram(r[0]),
      portrait_thumb_url: monogram(r[0]),
      instagram_url: 'https://instagram.com/' + r[1].replace(/^@/, ''),
      displayOrder: i,
    };
  });

  var designs = [];

  /* The real sheets, attributed and dated. sheetIndex is what lets a grid tile
   * hand off to the legacy linear viewer, which addresses sheets positionally. */
  SHEETS.forEach(function (s, i) {
    designs.push({
      id: 's-' + (i + 1),
      artistId: artists[(i % 6) + 1].id,
      type: 'sheet',
      title: 'Flash Sheet ' + ROMAN[i],
      image: s[0], thumb: s[0], width: s[1], height: s[2],
      categories: [CATS[i % CATS.length]],
      featured: i === 0,
      displayOrder: i,
      createdAt: '2026-07-' + (10 + i) + 'T10:00:00Z',
      sheetIndex: i,
    });
  });

  /* Individual designs, so browse-by-artist and browse-by-category have
   * something to browse. Two categories each, spread across the whole roster. */
  TITLES.forEach(function (t, i) {
    var s = SHEETS[i % SHEETS.length];
    designs.push({
      id: 'd-' + (i + 1),
      artistId: artists[i % artists.length].id,
      type: 'design',
      title: t,
      image: s[0], thumb: s[0], width: s[1], height: s[2],
      categories: [CATS[i % CATS.length], CATS[(i + 3) % CATS.length]],
      featured: i < 2,
      displayOrder: i,
      createdAt: '2026-07-' + (1 + (i % 28)) + 'T12:00:00Z',
    });
  });

  return {
    providesSheets: true,
    artists: artists,
    categories: CATS.map(function (c) { return { name: c }; }),
    designs: designs,
  };
})();
