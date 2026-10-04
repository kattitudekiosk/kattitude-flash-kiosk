/* Studio server — files dropped into KIOSK MEDIA go on the wall
 *
 * Joshua, 2 Oct 2026: "I moved the four flash sheets to the corresponding
 * artist and they are still showing as coming soon. Why isn't the kiosk
 * catching the direct uploads to the desktop folder?" Until now only the
 * dashboard could add designs. This makes the folder itself an upload route:
 *
 *   KIOSK MEDIA/<Artist>/Designs/<file>   a flash sheet
 *   KIOSK MEDIA/<Artist>/<file>           a flash sheet (loose in the folder)
 *
 * [CHANGED 2 Oct 2026 — Joshua: "they are only uploading sheets — designs
 * are sheets ... they only need one folder for designs/sheets".] EVERY
 * dropped image is a flash sheet; there is no single/sheet decision for
 * folder drops. Designs/ is the one work folder. The old Sheets/ folder is
 * emptied into Designs/ and removed (migrateSheets below).
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

/* A file dropped into Designs/ by hand is a flash sheet. Only a picture too
 * small to read on the 1080-wide wall (long side under 1080) is skipped, with
 * the reason logged. A file the Supabase sync downloaded may instead be a
 * square SINGLE design — see syncedType() below; the dashboard's two sizes
 * are plan() in dashboard/app.js. */
function classify(w, h) {
  return Math.max(w, h) >= MIN_SHEET_W ? 'sheet' : null;
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
    for (const sub of ['Designs', '']) {        // '' = loose in <Artist>/ itself
      const dir = path.join(media, folder, sub);
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const e of entries) {
        if (!e.isFile() || e.name.startsWith('.') || !EXT.test(e.name)) continue;
        const full = path.join(dir, e.name);
        const st = fs.statSync(full);
        found.push({ artist, folder, sub, name: e.name, full,
                     rel: (sub ? [folder, sub, e.name] : [folder, e.name]).join('/'),
                     sig: `${st.size}-${Math.floor(st.mtimeMs)}`, mtimeMs: st.mtimeMs });
      }
    }
  }
  return found;
}

/* The wall's copy lives in Designs/_kiosk/ — the flash bucket's storage
 * route maps <artist id>/<rest> onto KIOSK MEDIA/<Artist>/Designs/<rest>.
 * A file loose in <Artist>/ gets a "top-" prefix so it can never collide with
 * a same-named file in Designs/. */
function copySlug(f) { return (f.sub ? '' : 'top-') + slug(f.name); }
function urlFor(f, file) {
  return `/storage/v1/object/public/flash/${f.artist.id}/_kiosk/${copySlug(f)}/${file}`;
}
function outDir(media, f) { return path.join(media, f.folder, 'Designs', '_kiosk', copySlug(f)); }

/* ── Sheets/ → Designs/ (one-time, re-checked every scan) ───────────────
 * Moves anything in an artist's Sheets/ folder into Designs/ and removes the
 * empty Sheets/. An exact duplicate is stored once; a different file with a
 * taken name is kept under a new name, never overwritten. The design's
 * database row is re-pointed (same id) and re-imported. The old generated
 * Designs/_kiosk-sheets copies are removed; they are rebuilt in _kiosk. */
function sameFile(a, b) {
  const sa = fs.statSync(a), sb = fs.statSync(b);
  return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
}
function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  let n = `${base} (from Sheets)${ext}`, i = 2;
  while (fs.existsSync(path.join(dir, n))) n = `${base} (from Sheets ${i++})${ext}`;
  return n;
}
function migrateSheets(conn, media, byFolder) {
  const moved = [];
  const now = Date.now();
  for (const folder of Object.keys(byFolder)) {
    const sheets = path.join(media, folder, 'Sheets');
    const designs = path.join(media, folder, 'Designs');
    fs.rmSync(path.join(designs, '_kiosk-sheets'), { recursive: true, force: true });
    let entries;
    try { entries = fs.readdirSync(sheets, { withFileTypes: true }); } catch (e) { continue; }
    fs.mkdirSync(designs, { recursive: true });
    for (const e of entries) {
      const from = path.join(sheets, e.name);
      if (e.name === '.DS_Store') { fs.rmSync(from, { force: true }); continue; }
      if (e.isFile() && now - fs.statSync(from).mtimeMs < SETTLE_MS) continue;   // still copying
      let name = e.name, to = path.join(designs, name);
      if (fs.existsSync(to)) {
        if (e.isFile() && fs.statSync(to).isFile() && sameFile(from, to)) {
          fs.rmSync(from, { force: true });
          log(`removed duplicate ${folder}/Sheets/${e.name} (identical copy already in Designs/)`);
          continue;
        }
        name = freeName(designs, e.name);
        to = path.join(designs, name);
      }
      fs.renameSync(from, to);
      conn.prepare('UPDATE designs SET source_file = ?, source_sig = NULL WHERE source_file = ?')
        .run(`${folder}/Designs/${name}`, `${folder}/Sheets/${e.name}`);
      log(`moved ${folder}/Sheets/${e.name} → ${folder}/Designs/${name}`);
      moved.push([`${folder}/Sheets/${e.name}`, `${folder}/Designs/${name}`]);
    }
    try { if (!fs.readdirSync(sheets).length) { fs.rmdirSync(sheets); log(`removed empty ${folder}/Sheets/`); } }
    catch (e) { /* a file still copying; next pass */ }
  }
  return moved;
}

/* A file the Supabase sync downloaded carries the type its artist chose in
 * the dashboard (a square can be a single design). Anything dropped in by
 * hand has no record and stays a flash sheet, as before. */
function syncedType(conn, rel) {
  try {
    const r = conn.prepare('SELECT type FROM synced_files WHERE local_rel = ?').get(rel);
    return r && r.type === 'design' ? 'design' : null;
  } catch (e) { return null; }   // no sync has ever run: no table yet
}

function importOne(conn, media, f) {
  const { w, h } = dims(f.full);
  let type = classify(w, h);
  if (type && syncedType(conn, f.rel) === 'design') type = 'design';
  if (!type) {
    log(`skipped ${f.rel}: ${w}×${h} is too small for the wall ` +
        `(a flash sheet needs at least ${MIN_SHEET_W} pixels on its long side)`);
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
    result.moved = migrateSheets(conn, media, byFolder);
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
