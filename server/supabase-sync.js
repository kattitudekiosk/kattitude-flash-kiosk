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

const DEFAULTS = {
  url: 'https://tovydesiocfgmasvzjvt.supabase.co',
  key: 'sb_publishable_2z_wow-2gSEvs4ng-YxyrA_Mytp7XaD',   // public by design (see config.js)
};
const EXT = /\.(jpe?g|png|webp|heic|heif|tiff?)$/i;

function log(msg) { console.log(`[supabase-sync] ${db.nowIso()} ${msg}`); }

function ensureTables(conn) {
  conn.exec(`CREATE TABLE IF NOT EXISTS synced_files (
    remote_id TEXT PRIMARY KEY, artist_id TEXT NOT NULL, local_rel TEXT NOT NULL,
    remote_url TEXT NOT NULL, md5 TEXT NOT NULL, synced_at TEXT NOT NULL)`);
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
}

const md5 = buf => crypto.createHash('md5').update(buf).digest('hex');

function fileName(d) {
  const ext = ((String(d.image_url).split('?')[0].match(/\.([a-z0-9]+)$/i) || [])[1] || 'jpg').toLowerCase();
  const title = String(d.title || 'sheet').replace(/[\/:\0\\]/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || 'sheet';
  return `${title} (${String(d.id).slice(0, 8)}).${ext}`;
}

async function getJson(fetchFn, url, key) {
  const r = await fetchFn(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url.replace(/\?.*/, '')}`);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('unexpected reply (not a list)');
  return j;
}

/* One sync pass. Returns a summary; never throws on network trouble. */
async function syncOnce(conn, opts) {
  opts = opts || {};
  const base = (opts.url || process.env.KT_SUPABASE_URL || DEFAULTS.url).replace(/\/+$/, '');
  const key = opts.key || process.env.KT_SUPABASE_KEY || DEFAULTS.key;
  const fetchFn = opts.fetch || fetch;
  const media = storage.mediaDir();
  const out = { ok: false, downloaded: [], removed: [], kept: [], skipped: [] };
  ensureTables(conn);

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
  const live = new Set();

  for (const d of remote) {
    live.add(d.id);
    const a = artists[d.artist_id];
    const folder = a && storage.folderName(a.name);
    if (!folder) { out.skipped.push(d.id); log(`skipped ${d.id}: artist ${d.artist_id} is not on this Mac yet`); continue; }
    if (!d.image_url || !EXT.test(String(d.image_url).split('?')[0])) { out.skipped.push(d.id); continue; }
    const have = synced[d.id];
    const rel = `${folder}/Designs/${fileName(d)}`;
    const full = path.join(media, ...rel.split('/'));
    if (have && have.remote_url === d.image_url && have.local_rel === rel && fs.existsSync(full)) continue;   // up to date

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
    conn.prepare(`INSERT OR REPLACE INTO synced_files (remote_id, artist_id, local_rel, remote_url, md5, synced_at)
                  VALUES (?,?,?,?,?,?)`).run(d.id, d.artist_id, rel, d.image_url, md5(buf), db.nowIso());
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

module.exports = { syncOnce, fileName };
