/* Studio server — files dropped into KIOSK MEDIA go on the wall
 *
 * Joshua, 2 Oct 2026: "I moved the four flash sheets to the corresponding
 * artist and they are still showing as coming soon. Why isn't the kiosk
 * catching the direct uploads to the desktop folder?" Until now only the
 * dashboard could add designs. This makes the folder itself an upload route:
 *
 *   KIOSK MEDIA/<Artist>/Designs/<file>   shape decides: a square at least
 *                                         2048 wide is a single, anything
 *                                         else at least 1080 wide a sheet
 *   KIOSK MEDIA/<Artist>/Sheets/<file>    always a flash sheet (for square
 *                                         sheets, which would read as singles)
 *
 * Same rules as dashboard uploads (CLAUDE.md invariant 3): the file Joshua
 * dropped is the original and is NEVER modified or moved; the wall shows a
 * copy fitted inside 2048×2048 / 2160×3840 — never cropped, never enlarged —
 * written to <folder>/_kiosk/<name>/. Too-small files are skipped and the
 * reason logged. Delete the file and its design leaves the wall.
 *
 * Only LOOSE files are imported. Subfolders hold dashboard uploads, which
 * already have their own database rows, and the _kiosk copies made here.
 *
 * Runs at start-up, on every change Finder makes (debounced, so a copy in
 * progress is not read half-written), and every 60 s as a backstop in case a
 * change notification is missed. Resizing uses macOS's own `sips`.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('./db');
const storage = require('./storage');

const EXT = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i;
const SPEC = { design: { w: 2048, h: 2048 }, sheet: { w: 2160, h: 3840 } };
const MIN_SHEET_W = 1080;
const SETTLE_MS = 2000;      // a file must be unchanged this long before import

function log(msg) { console.log(`[folder-sync] ${db.nowIso()} ${msg}`); }

function dims(file) {
  const out = execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
  const w = parseInt((out.match(/pixelWidth:\s*(\d+)/) || [])[1], 10);
  const h = parseInt((out.match(/pixelHeight:\s*(\d+)/) || [])[1], 10);
  if (!w || !h) throw new Error('could not read image size');
  return { w, h };
}

/* Same decision the dashboard makes (classify() in dashboard/app.js). */
function classify(w, h, forceSheet) {
  if (forceSheet) return w >= MIN_SHEET_W || h >= MIN_SHEET_W ? 'sheet' : null;
  if (w === h) return w >= SPEC.design.w ? 'design' : null;
  return w >= MIN_SHEET_W ? 'sheet' : null;
}

function sips(args) { execFileSync('/usr/bin/sips', args, { stdio: 'ignore' }); }

/* Whole image scaled to fit inside maxW×maxH, never enlarged. */
function fitInside(src, out, maxW, maxH, w, h) {
  const s = Math.min(1, maxW / w, maxH / h);
  const nw = Math.round(w * s), nh = Math.round(h * s);
  const args = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90'];
  if (s < 1) args.push('-z', String(nh), String(nw));
  sips(args.concat([src, '--out', out]));
  return { w: nw, h: nh };
}

/* 512×512 grid thumbnail, centre-cropped (cover) — the dashboard does the
 * same for thumbnails; only the kiosk copy is never cropped. */
function thumb(src, out, w, h) {
  const tmp = out + '.tmp.jpg';
  sips(['-s', 'format', 'jpeg', w < h ? '--resampleWidth' : '--resampleHeight', '512', src, '--out', tmp]);
  sips(['--cropToHeightWidth', '512', '512', tmp, '--out', out]);
  fs.unlinkSync(tmp);
}

function slug(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) || 'file';
}
function titleOf(name) {
  return name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Every loose image under <Artist>/Designs and <Artist>/Sheets. */
function scanFiles(media, artistsByFolder) {
  const found = [];
  for (const [folder, artist] of Object.entries(artistsByFolder)) {
    for (const [sub, forceSheet] of [['Designs', false], ['Sheets', true]]) {
      const dir = path.join(media, folder, sub);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.') || !EXT.test(e.name)) continue;
        const full = path.join(dir, e.name);
        const st = fs.statSync(full);
        found.push({ artist, folder, sub, name: e.name, full, forceSheet,
                     rel: path.join(folder, sub, e.name).split(path.sep).join('/'),
                     sig: `${st.size}-${Math.floor(st.mtimeMs)}`, mtimeMs: st.mtimeMs });
      }
    }
  }
  return found;
}

function kioskDir(media, f) { return path.join(media, f.folder, f.sub, '_kiosk', slug(f.name)); }

function urlFor(f, file) {
  /* The storage route for the flash bucket maps <artist id>/<rest> onto
   * KIOSK MEDIA/<Artist>/Designs/<rest>. Sheets/ sits beside Designs/, so
   * its copies are reached through Designs/../Sheets — safePath would refuse
   * '..', so Sheets copies are written under Designs/_kiosk-sheets instead. */
  const sub = f.sub === 'Designs' ? '_kiosk' : '_kiosk-sheets';
  return `/storage/v1/object/public/flash/${f.artist.id}/${sub}/${slug(f.name)}/${file}`;
}
function outDir(media, f) {
  return f.sub === 'Designs' ? kioskDir(media, f)
    : path.join(media, f.folder, 'Designs', '_kiosk-sheets', slug(f.name));
}

function importOne(conn, media, f) {
  const { w, h } = dims(f.full);
  const type = classify(w, h, f.forceSheet);
  if (!type) {
    log(`skipped ${f.rel}: ${w}×${h} is too small for the wall ` +
        `(singles need a square at least 2048 wide; sheets at least ${MIN_SHEET_W} wide)`);
    return null;
  }
  const dir = outDir(media, f);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const spec = SPEC[type];
  const k = fitInside(f.full, path.join(dir, 'kiosk.jpg'), spec.w, spec.h, w, h);
  thumb(path.join(dir, 'kiosk.jpg'), path.join(dir, 'thumb.jpg'), k.w, k.h);

  const row = {
    artist_id: f.artist.id, title: titleOf(f.name), type,
    image_url: urlFor(f, 'kiosk.jpg'), thumb_url: urlFor(f, 'thumb.jpg'),
    width: k.w, height: k.h, published: true, approved: true,
    source_file: f.rel, source_sig: f.sig,
  };
  const existing = conn.prepare('SELECT id FROM designs WHERE source_file = ?').get(f.rel);
  if (existing) db.updateRow(conn, 'designs', [existing.id], row);
  else db.insertRow(conn, 'designs', row);
  log(`imported ${f.rel} → ${type} ${k.w}×${k.h} (original ${w}×${h} kept untouched)`);
  return row;
}

let running = false;

/* One pass: import new or changed files, drop designs whose file is gone. */
function syncOnce(conn) {
  if (running) return { skipped: true };
  running = true;
  const media = storage.mediaDir();
  const result = { imported: [], removed: [], skipped: [] };
  try {
    const artists = db.all(conn, 'artists');
    const byFolder = {};
    artists.forEach(a => { const f = storage.folderName(a.name); if (f) byFolder[f] = a; });
    const files = scanFiles(media, byFolder);
    const now = Date.now();
    const present = new Set(files.map(f => f.rel));

    for (const f of files) {
      const row = conn.prepare('SELECT id, source_sig, artist_id FROM designs WHERE source_file = ?').get(f.rel);
      if (row && row.source_sig === f.sig && row.artist_id === f.artist.id) continue;   // up to date
      if (now - f.mtimeMs < SETTLE_MS) continue;                                         // still copying
      try {
        const r = importOne(conn, media, f);
        (r ? result.imported : result.skipped).push(f.rel);
      } catch (e) {
        log(`could not import ${f.rel}: ${e.message}`);
        result.skipped.push(f.rel);
      }
    }

    /* A file that is gone takes its design (and its generated copies) with it. */
    const imported = conn.prepare('SELECT id, source_file, image_url FROM designs WHERE source_file IS NOT NULL').all();
    for (const d of imported) {
      if (present.has(d.source_file)) continue;
      db.deleteRow(conn, 'designs', [d.id]);
      const m = String(d.image_url).match(/^\/storage\/v1\/object\/public\/(flash\/.+)\/kiosk\.jpg$/);
      if (m) {
        const [bucket, ...rest] = m[1].split('/');
        try { fs.rmSync(storage.diskPath(bucket, rest.join('/')), { recursive: true, force: true }); } catch (e) {}
      }
      log(`removed ${d.source_file} from the wall (file no longer in KIOSK MEDIA)`);
      result.removed.push(d.source_file);
    }
  } finally {
    running = false;
  }
  return result;
}

/* Start-up scan, change notifications (debounced), and a 60 s backstop. */
function start(conn) {
  const media = storage.mediaDir();
  const run = () => { try { syncOnce(conn); } catch (e) { log('scan failed: ' + e.message); } };
  run();
  let timer = null;
  const soon = () => { clearTimeout(timer); timer = setTimeout(run, SETTLE_MS + 500); };
  try {
    fs.watch(media, { recursive: true }, (evt, name) => {
      if (name && /(^|\/)_kiosk/.test(name)) return;   // our own output
      soon();
    });
  } catch (e) {
    log('cannot watch KIOSK MEDIA (' + e.message + '); relying on the 60 s rescan');
  }
  setInterval(run, 60000).unref();
}

module.exports = { start, syncOnce, classify };
