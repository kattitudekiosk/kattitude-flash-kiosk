/* Studio server — pull the dashboard's sheets from Supabase into KIOSK MEDIA
 *
 * The architecture Joshua approved (2 Oct 2026):
 *
 *   hosted dashboard (Vercel) → Supabase → THIS SYNC → KIOSK MEDIA/<Artist>/Designs
 *                                                    → folder-sync.js → the wall
 *
 * Artists upload from anywhere through the hosted dashboard. A sync runs
 * when the wall's screensaver starts (at most every 10 minutes), when the
 * server starts, and once a day from launchd (`node server/cli.js
 * sync-supabase`) — never on a polling loop. Each run:
 *
 *   1. reads Supabase's kiosk_catalog with the PUBLIC key. That view is
 *      exactly the published, approved designs — a draft, an unpublished
 *      design or a deleted one simply is not in it.
 *   2. downloads any sheet it has not got (or whose image changed) into the
 *      artist's Designs/ folder as  "<title> (<first 8 of its id>).<ext>".
 *      The existing folder importer then resizes it and puts it on the wall.
 *   3. removes a file it downloaded once that design is no longer published
 *      — but ONLY a file it wrote itself (recorded in the synced_files table)
 *      and only if the file is still byte-for-byte what it wrote. A file
 *      somebody dropped in by hand, or edited, is never deleted.
 *
 * FAILURE IS SAFE. Any network error, any non-200 from Supabase, any reply
 * that is not a list: nothing is deleted, the run logs "will retry", and the
 * next run tries again. The wall never waits on this — it reads the Mac mini.
 *
 * KEEP-ALIVE. Free Supabase projects pause "after 1 week of inactivity"
 * (supabase.com/pricing). Every run is a real PostgREST → Postgres query; the
 * first successful one each day is logged as the keep-alive, so the log shows
 * there has been database activity every day.
 *
 * NOT pushed back up: files dropped into KIOSK MEDIA by hand stay on the wall
 * only. Writing to Supabase needs a signed-in user or the service-role key,
 * and neither belongs on an unattended kiosk. See server/README.md.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('./db');
const storage = require('./storage');

const DEFAULTS = {   // Kat's project since 3 Oct 2026 (db/kat-project/)
  url: 'https://hnwyoglbmhvafxnzizqe.supabase.co',
  key: 'sb_publishable_XWA6QYk4ukTcmqvqjnBniw_DfvzQsZh',   // public by design (see config.js)
};
const EXT = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i;

function log(msg) { console.log(`[supabase-sync] ${db.nowIso()} ${msg}`); }

function ensureTables(conn) {
  conn.exec(`CREATE TABLE IF NOT EXISTS synced_files (
    remote_id TEXT PRIMARY KEY, artist_id TEXT NOT NULL, local_rel TEXT NOT NULL,
    remote_url TEXT NOT NULL, md5 TEXT NOT NULL, synced_at TEXT NOT NULL)`);
  /* type: 'design' (a square single) or 'sheet', as the dashboard set it.
   * Added 3 Oct 2026 — the folder importer would otherwise call every
   * download a sheet. Older databases get the column here. */
  const cols = conn.prepare('PRAGMA table_info(synced_files)').all().map(c => c.name);
  if (!cols.includes('type')) conn.exec('ALTER TABLE synced_files ADD COLUMN type TEXT');
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
}

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

function fileName(d) {
  const ext = ((String(d.image_url).split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || 'jpg').toLowerCase();
  const title = String(d.title || 'sheet').replace(/[\/:\0\\]/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || 'sheet';
  return `${title} (${String(d.id).slice(0, 8)}).${ext}`;
}

/* What the catalog looks like from here: every published design's id, image
 * and type. Changes when anything is published, unpublished, deleted,
 * re-uploaded or switched between single and sheet — and only then. */
/* Designs AND the artist cards: a new photo, a renamed artist or someone
 * taken off the wall changes it, so the next screensaver start syncs. */
function combinedFingerprint(designs, artists) {
  return crypto.createHash('sha1').update(fingerprint(designs) + '\n' + (artists
    ? artists.map(a => JSON.stringify(a)).sort().join('\n') : 'artists: unavailable')).digest('hex');
}

function fingerprint(list) {
  return crypto.createHash('sha1')
    .update(list.map(d => d.id + '|' + d.image_url + '|' + (d.type || '')).sort().join('\n')).digest('hex');
}

/* The cheap "anything new?" check (Joshua, 3 Oct 2026: new uploads must show
 * up the next time the screensaver comes on). One small request — ids and
 * image URLs only, no files. null when Supabase cannot be reached. */
async function remoteFingerprint(opts) {
  opts = opts || {};
  const base = (opts.url || process.env.KT_SUPABASE_URL || DEFAULTS.url).replace(/\/+$/, '');
  const key = opts.key || process.env.KT_SUPABASE_KEY || DEFAULTS.key;
  try {
    const f = opts.fetch || fetch;
    const designs = await getJson(f, `${base}/rest/v1/kiosk_catalog?select=id,image_url,type`, key);
    // Designs decide whether Supabase is reachable; an artists list that
    // fails on its own counts as "unknown", the same way syncOnce records it.
    let artists = null;
    try { artists = await getJson(f, `${base}/rest/v1/${ARTISTS_Q}`, key); } catch (e) { artists = null; }
    return combinedFingerprint(designs, artists);
  } catch (e) { return null; }
}

async function getJson(fetchFn, url, key) {
  const r = await fetchFn(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url.replace(/\?.*/, '')}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('unexpected reply (not a list)');
  return j;
}

/* ── Artists and headshots (Joshua, 9 Oct 2026: "When does the Kiosk refresh
 * profile pics?") ──────────────────────────────────────────────────────────
 * The wall's artist cards come from THIS Mac's database, and the sync used to
 * pull designs only — so Kat's new photo, Ally coming off the wall, and any
 * artist added in the dashboard never arrived. Now every sync reads the
 * public artist list first:
 *   - a new artist is added here with the SAME id, and their folders made;
 *   - display fields follow (a new name renames their KIOSK MEDIA folder);
 *   - a new or changed photo is downloaded into <Artist>/Headshots and the
 *     card points at it (stored as a path, like every photo here);
 *   - an artist no longer in the list (inactive, or taken off the wall) is
 *     set kiosk_visible = false here. Nothing is deleted; they come back if
 *     they reappear. An EMPTY list hides nobody — that is an outage, not a
 *     studio with no artists.
 * The public key reads only what the kiosk may show (no email, role or login)
 * and only active, on-the-wall artists — exactly the people the wall shows. */
const ARTIST_COLS = ['name', 'handle', 'bio', 'instagram_url', 'seniority', 'display_order'];
const ARTISTS_Q = `artists?select=id,${ARTIST_COLS.join(',')},portrait_url,portrait_thumb_url&order=display_order`;

function photoFile(u) {
  if (!u) return null;
  const f = decodeURIComponent(String(u).split('?')[0].split('/').pop() || '');
  return /^[A-Za-z0-9._-]+$/.test(f) && f !== '.' && f !== '..' ? f : null;   // a bare file name, nothing else
}
function same(a, b) {
  if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) return true;
  return String(a) === String(b);
}

async function syncPhoto(conn, r, out, fetchFn) {
  const local = db.getByKey(conn, 'artists', [r.id]);
  const want = photoFile(r.portrait_url), wantSm = photoFile(r.portrait_thumb_url);
  if (want === photoFile(local.portrait_url) && wantSm === photoFile(local.portrait_thumb_url)) return;
  if (!want) {
    db.updateRow(conn, 'artists', [r.id], { portrait_url: null, portrait_thumb_url: null });
    out.photos.push(`${local.name}: photo removed`);
    log(`${local.name}: photo removed`);
    return;
  }
  const folder = storage.folderName(local.name);
  const dir = path.join(storage.mediaDir(), folder, 'Headshots');
  fs.mkdirSync(dir, { recursive: true });
  for (const [url, file] of [[r.portrait_url, want], [r.portrait_thumb_url, wantSm]]) {
    if (!file) continue;
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const tmp = path.join(dir, `.sync-${process.pid}-${Date.now()}`);
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(dir, file));
    } catch (e) {
      log(`could not download ${local.name}'s photo (${e.message}) — card unchanged, will retry next run`);
      return;
    }
  }
  const p = f => (f ? `/storage/v1/object/public/avatars/${r.id}/${f}` : null);
  db.updateRow(conn, 'artists', [r.id], { portrait_url: p(want), portrait_thumb_url: p(wantSm) });
  out.photos.push(`${local.name}: new photo`);
  log(`${local.name}: new photo → ${folder}/Headshots/${want}`);
}

async function syncArtists(conn, base, key, fetchFn, out) {
  let remote;
  try { remote = await getJson(fetchFn, `${base}/rest/v1/${ARTISTS_Q}`, key); }
  catch (e) { log(`artists: ${e.message} — cards unchanged, will retry next run`); return; }
  out._artistsRemote = remote;
  const seen = new Set();
  for (const r of remote) {
    if (!r || !r.id || !r.name) continue;
    seen.add(r.id);
    const local = db.getByKey(conn, 'artists', [r.id]);
    if (!local) {
      const row = { id: r.id, role: 'artist', active: true, kiosk_visible: true };
      ARTIST_COLS.forEach(c => { if (r[c] !== undefined && r[c] !== null) row[c] = r[c]; });
      db.insertRow(conn, 'artists', row);
      storage.ensureArtistFolders([r.name]);
      out.artistsAdded.push(r.name);
      log(`new artist ${r.name} — folders made in KIOSK MEDIA`);
    } else {
      const patch = {};
      ARTIST_COLS.forEach(c => { if (r[c] !== undefined && !same(local[c], r[c])) patch[c] = r[c]; });
      if (!local.kiosk_visible) patch.kiosk_visible = true;   // back on the wall
      if (patch.name) storage.renameArtistFolder(local.name, patch.name);
      if (Object.keys(patch).length) {
        db.updateRow(conn, 'artists', [r.id], patch);
        out.artistsUpdated.push(`${r.name} (${Object.keys(patch).join(', ')})`);
        log(`${r.name}: ${Object.keys(patch).join(', ')} updated`);
      }
    }
    await syncPhoto(conn, r, out, fetchFn);
  }
  if (!remote.length) { log('artists: the public list came back empty — hiding nobody'); return; }
  for (const a of db.all(conn, 'artists')) {
    if (!seen.has(a.id) && a.kiosk_visible) {
      db.updateRow(conn, 'artists', [a.id], { kiosk_visible: false });
      out.artistsHidden.push(a.name);
      log(`${a.name} is no longer on the wall (inactive or hidden in the dashboard)`);
    }
  }
}

/* One sync pass. Returns a summary; never throws on network trouble. */
async function syncOnce(conn, opts) {
  opts = opts || {};
  const base = (opts.url || process.env.KT_SUPABASE_URL || DEFAULTS.url).replace(/\/+$/, '');
  const key = opts.key || process.env.KT_SUPABASE_KEY || DEFAULTS.key;
  const fetchFn = opts.fetch || fetch;
  const media = storage.mediaDir();
  const out = { ok: false, downloaded: [], removed: [], kept: [], skipped: [], retyped: [],
                artistsAdded: [], artistsUpdated: [], artistsHidden: [], photos: [] };
  ensureTables(conn);

  // Artists first: a design can only land in the folder of an artist this
  // Mac knows, and a renamed artist's folder must move before files arrive.
  await syncArtists(conn, base, key, fetchFn, out);

  let remote;
  try {
    remote = await getJson(fetchFn,
      `${base}/rest/v1/kiosk_catalog?select=id,artist_id,title,type,image_url`, key);
  } catch (e) {
    out.error = e.message;
    log(`offline or Supabase unreachable (${e.message}) — nothing changed, will retry next run`);
    return out;
  }
  out.ok = true;
  out.fingerprint = combinedFingerprint(remote, out._artistsRemote || null);

  /* Keep-alive: the query above reached Postgres. Log the first one a day. */
  const today = db.nowIso().slice(0, 10);
  const last = conn.prepare("SELECT value FROM meta WHERE key = 'supabase_keepalive_day'").get();
  if (!last || last.value !== today) {
    conn.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('supabase_keepalive_day', ?)").run(today);
    log(`keep-alive: database query OK (${remote.length} published design${remote.length === 1 ? '' : 's'}) — Supabase saw activity today`);
    out.keepalive = true;
  }

  const artists = Object.fromEntries(db.all(conn, 'artists').map(a => [a.id, a]));
  const synced = Object.fromEntries(conn.prepare('SELECT * FROM synced_files').all().map(r => [r.remote_id, r]));
  /* Designs that STARTED on this Mac and were copied up to Supabase with the
   * same id (the 3 Oct 2026 move to Kat's project did exactly that with the 4
   * studio sheets). They are already on the wall; downloading them would put
   * every one on it twice. A synced download is imported under a NEW local id,
   * so it never matches here. */
  const localIds = new Set(db.all(conn, 'designs').map(x => x.id));
  const live = new Set();
  out.alreadyHere = [];

  for (const d of remote) {
    live.add(d.id);
    if (!synced[d.id] && localIds.has(d.id)) { out.alreadyHere.push(d.id); continue; }
    const a = artists[d.artist_id];
    const folder = a && storage.folderName(a.name);
    if (!folder) { out.skipped.push(d.id); log(`skipped ${d.id}: artist ${d.artist_id} is not on this Mac yet`); continue; }
    if (!d.image_url || !EXT.test(String(d.image_url).split('?')[0])) { out.skipped.push(d.id); continue; }
    const have = synced[d.id];
    const rel = `${folder}/Designs/${fileName(d)}`;
    const full = path.join(media, ...rel.split('/'));
    const rtype = d.type === 'design' ? 'design' : 'sheet';
    if (have && have.remote_url === d.image_url && have.local_rel === rel && fs.existsSync(full)) {
      /* Same file, switched between single and sheet in My Designs: no
       * download, just carry the new type onto the wall's copy. */
      if ((have.type || 'sheet') !== rtype) {
        conn.prepare('UPDATE synced_files SET type = ? WHERE remote_id = ?').run(rtype, d.id);
        conn.prepare('UPDATE designs SET type = ? WHERE source_file = ?').run(rtype, rel);
        out.retyped.push(rel);
        log(`${rel} is now a ${rtype === 'design' ? 'single design' : 'flash sheet'}`);
      }
      continue;   // up to date
    }

    let buf;
    try {
      const r = await fetchFn(d.image_url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      out.skipped.push(d.id);
      log(`could not download ${rel} (${e.message}) — will retry next run`);
      continue;
    }
    /* A hand-made file already sitting at this exact name is not ours to
     * overwrite. (The id in the name makes this practically impossible.) */
    if (!have && fs.existsSync(full)) { out.skipped.push(d.id); log(`skipped ${rel}: a file by that name is already there`); continue; }
    if (have && have.local_rel !== rel) removeOurs(conn, media, have, out, 'renamed');   // title changed
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const tmp = path.join(path.dirname(full), `.sync-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, full);                         // atomic: the importer never sees half a file
    const old = new Date(Date.now() - 5000);          // already settled for the importer
    fs.utimesSync(full, old, old);
    conn.prepare(`INSERT OR REPLACE INTO synced_files (remote_id, artist_id, local_rel, remote_url, md5, synced_at, type)
                  VALUES (?,?,?,?,?,?,?)`).run(d.id, d.artist_id, rel, d.image_url, md5(buf), db.nowIso(), rtype);
    out.downloaded.push(rel);
    log(`downloaded ${rel} (${buf.length} bytes)`);
  }

  /* Deleted or unpublished in the dashboard → take our copy back off. */
  for (const s of Object.values(synced)) {
    if (!live.has(s.remote_id)) removeOurs(conn, media, s, out, 'no longer published');
  }
  return out;
}

function removeOurs(conn, media, s, out, why) {
  const full = path.join(media, ...s.local_rel.split('/'));
  let same = false;
  try { same = md5(fs.readFileSync(full)) === s.md5; } catch (e) { same = null; }   // already gone
  if (same === false) {
    out.kept.push(s.local_rel);
    log(`kept ${s.local_rel}: ${why} in the dashboard, but the file was changed on this Mac — not deleting it`);
  } else {
    if (same) fs.rmSync(full, { force: true });
    out.removed.push(s.local_rel);
    log(`removed ${s.local_rel}: ${why} in the dashboard`);
  }
  conn.prepare('DELETE FROM synced_files WHERE remote_id = ?').run(s.remote_id);
}

module.exports = { syncOnce, fileName, remoteFingerprint, fingerprint, combinedFingerprint, ensureTables };
