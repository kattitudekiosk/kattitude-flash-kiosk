/* Studio server — is this design title one a person typed, or one a machine
 * made up from a file name?
 *
 * Joshua, 9 Oct 2026: "Please remove the 'titles' of the flash sheets, because
 * they don't have names and it just shows as a file string. Only add a
 * title/name if they add it to the form when they upload."
 *
 * Until then the dashboard pre-filled the title from the file name and the Mac
 * made one from every dropped or synced file — "IMG 1185", "Untitled Artwork
 * 2 web", "IMG 0709 (725b96b5)". This is the one rule for recognising those,
 * used to clear them (`node server/cli.js clear-auto-titles`). The SQL sent for
 * Kat's Supabase (db/kat-project/11-clear-auto-titles.sql) uses the same
 * patterns. It errs towards KEEPING a title: only a recognised camera/app
 * file name, or the design's own file name, counts as made up.
 */
'use strict';

const PATTERNS = [
  // Phone cameras: IMG 1185, IMG_1185, IMG-1185, IMG 1185 2, plus the sync's (1af602c9)
  /^IMG[ _-]?\d+( \d+)?$/i,
  // Procreate's default name, any suffix: Untitled Artwork, Untitled Artwork 2 web
  /^Untitled[ _-]?Artwork\b.*$/i,
  // Other cameras and screenshot tools
  /^(DSC|DSCN|DSCF|PXL|MVIMG|PHOTO|IMAGE|Screenshot|Screen Shot)[ _-]?\d[\w .:-]*$/i,
];
// The Mac's sync names a download "<title> (<first 8 of its id>).<ext>"; the
// folder importer then read that back as a title.
const SYNC_SUFFIX = / \([0-9a-f]{8}\)$/i;

/* "IMG_1185.JPEG" → "IMG 1185" — the way both the dashboard and the folder
 * importer used to turn a file name into a title. */
function stemTitle(fileName) {
  return String(fileName || '').split('/').pop()
    .replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** true when `title` was made up from a file name rather than typed. */
function isAutoTitle(title, sourceFile) {
  if (title == null) return false;
  const t = String(title).trim().replace(SYNC_SUFFIX, '');
  if (!t) return true;                                  // empty is no title
  if (PATTERNS.some(re => re.test(t))) return true;
  if (sourceFile) {
    const stem = stemTitle(sourceFile).replace(SYNC_SUFFIX, '');
    if (stem && stem.toLowerCase() === t.toLowerCase()) return true;
  }
  return false;
}

module.exports = { isAutoTitle, stemTitle, PATTERNS, SYNC_SUFFIX };
