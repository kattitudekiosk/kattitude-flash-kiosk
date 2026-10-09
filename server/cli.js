#!/usr/bin/env node
/* Kattitude studio server — commands, run on the Mac mini
 *
 *   node server/cli.js status
 *   node server/cli.js link <artist name or id> [--base https://…]
 *        One-time sign-in link. This is how Kat gets in the very first time;
 *        after that she makes everyone else's from the Artists tab.
 *   node server/cli.js import-supabase
 *        Copy the studio's data off Supabase onto this machine. Safe to re-run:
 *        rows are matched by id and updated, never duplicated.
 *   node server/cli.js backup
 *   node server/cli.js sync-supabase
 *        Pull the hosted dashboard's published sheets into KIOSK MEDIA (launchd, daily 09:15).
 *        Snapshot the database into <data>/backups/, keeping the last 30.
 *
 * Works while the server is running — SQLite in WAL mode allows it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const { withKeys } = require('./rpc');

const DATA = process.env.KT_DATA_DIR || path.join(os.homedir(), 'KattitudeData');
const PORT = process.env.KT_PORT || '8787';

function conn() {
  const c = db.open(path.join(DATA, 'kattitude.db'));
  storage.init(DATA, { artistName: id => (db.getByKey(c, 'artists', [id]) || {}).name });
  return c;
}
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; }

function findArtist(c, q) {
  const all = db.all(c, 'artists');
  const hit = all.filter(a => a.id === q || a.name.toLowerCase() === String(q).toLowerCase());
  if (hit.length !== 1) {
    console.error(hit.length ? `"${q}" matches more than one artist — use the id.` : `No artist "${q}".`);
    console.error('Artists: ' + all.map(a => `${a.name} (${a.id})`).join(', '));
    process.exit(1);
  }
  return hit[0];
}

/* ── import from Supabase ────────────────────────────────────────────── *
 * With the PUBLISHABLE key only, which is all this machine has, and on
 * purpose: no service-role key comes anywhere near the Mac mini. That key
 * can read what the kiosk can read. It cannot read emails, roles or login
 * links, so those are set here from what is known and recorded in LINKS.md:
 *   - Kat is the admin; everyone else is an artist.
 *   - emails start blank. Nobody needs one to sign in on the studio server,
 *     and Kat can add them on each card.
 * Drafts, unpublished designs and pending category requests are invisible to
 * that key too. On 2 Oct 2026 there were none of any of them to miss: the
 * designs table, kiosk_catalog and every flash sale table were empty. */
const SB = 'https://tovydesiocfgmasvzjvt.supabase.co';
const SB_KEY = 'sb_publishable_2z_wow-2gSEvs4ng-YxyrA_Mytp7XaD';

async function sbGet(q) {
  const r = await fetch(`${SB}/rest/v1/${q}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()} for ${q}`);
  return r.json();
}

/* Download one Supabase-hosted file into local storage; return its new path. */
async function pull(url) {
  const m = String(url || '').match(/\/storage\/v1\/object\/public\/([^/]+)\/([^?#]+)/);
  if (!m || !url.startsWith(SB)) return url;
  const r = await fetch(url);
  if (!r.ok) { console.warn(`  ! could not download ${url}: ${r.status}`); return url; }
  const buf = Buffer.from(await r.arrayBuffer());
  const rel = decodeURIComponent(m[2]);
  const full = storage.diskPath(m[1], rel);   // → ~/Desktop/KIOSK MEDIA/<Artist>/…
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buf);
  console.log(`  ↓ ${m[1]}/${rel} (${buf.length} bytes)`);
  return `/storage/v1/object/public/${m[1]}/${m[2]}`;
}

function upsert(c, table, row) {
  const have = db.getByKey(c, table, db.keyOf(table, row));
  if (have) return db.updateRow(c, table, db.keyOf(table, row), row);
  return db.insertRow(c, table, row);
}

async function importSupabase() {
  const c = conn();
  const artists = await sbGet('artists?select=id,name,handle,portrait_url,portrait_thumb_url,bio,' +
    'instagram_url,seniority,display_order,active&order=display_order');
  const categories = await sbGet('categories?select=*&order=display_order');
  const designs = await sbGet('designs?select=*');
  const links = await sbGet('design_categories?select=*');
  const sales = await sbGet('flash_sales?select=*,flash_sale_tiers(*),flash_sale_media(*),flash_sale_designs(*)');
  console.log(`Supabase: ${artists.length} artists, ${categories.length} categories, ` +
              `${designs.length} designs, ${sales.length} flash sales`);

  for (const a of artists) {
    a.portrait_url = await pull(a.portrait_url);
    a.portrait_thumb_url = await pull(a.portrait_thumb_url);
  }
  for (const d of designs) {
    d.image_url = await pull(d.image_url);
    d.thumb_url = await pull(d.thumb_url);
  }
  for (const s of sales) for (const m of (s.flash_sale_media || [])) m.url = await pull(m.url);

  const pick = (table, row) => Object.fromEntries(
    Object.entries(row).filter(([k]) => k in db.TABLES[table].cols));

  db.tx(c, () => {
    for (const a of artists) {
      const existing = db.getByKey(c, 'artists', [a.id]);
      const row = pick('artists', a);
      /* Never overwrite what this machine now owns: a role Kat changed, an
       * email she added, a login an artist already claimed. */
      if (!existing) {
        row.role = a.name.trim().toLowerCase() === 'kat' ? 'admin' : 'artist';
        row.kiosk_visible = true;
      }
      upsert(c, 'artists', row);
      console.log(`  artist ${a.name}${!existing && row.role === 'admin' ? '  (admin)' : ''}`);
    }
    for (const cat of categories) upsert(c, 'categories', withKeys(pick('categories', cat)));
    for (const d of designs) upsert(c, 'designs', pick('designs', d));
    for (const l of links) upsert(c, 'design_categories', pick('design_categories', l));
    for (const s of sales) {
      upsert(c, 'flash_sales', pick('flash_sales', s));
      for (const t of s.flash_sale_tiers || []) upsert(c, 'flash_sale_tiers', pick('flash_sale_tiers', t));
      for (const m of s.flash_sale_media || []) upsert(c, 'flash_sale_media', pick('flash_sale_media', m));
      for (const x of s.flash_sale_designs || []) upsert(c, 'flash_sale_designs', pick('flash_sale_designs', x));
    }
    c.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('imported_from_supabase_at', db.nowIso());
  });
  console.log('Imported. Local database: ' + path.join(DATA, 'kattitude.db'));
}

function backup() {
  const c = conn();
  const dir = path.join(DATA, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `kattitude-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  c.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = fs.readdirSync(dir).filter(f => /^kattitude-.*\.db$/.test(f)).sort();
  old.slice(0, Math.max(0, old.length - 30)).forEach(f => fs.unlinkSync(path.join(dir, f)));
  console.log('Backup: ' + file);
}

function status() {
  const c = conn();
  const n = t => c.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
  console.log(`Data:      ${DATA}`);
  for (const t of Object.keys(db.TABLES)) console.log(`  ${t.padEnd(20)} ${n(t)}`);
  console.log(`  sessions             ${n('sessions')}`);
  const admins = db.all(c, 'artists').filter(a => a.role === 'admin').map(a => a.name);
  console.log(`Admins:    ${admins.join(', ') || 'NONE — run: node server/cli.js link <name> after making one'}`);
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === 'link') {
    const c = conn();
    const a = findArtist(c, process.argv[3]);
    const l = auth.createLink(c, a.id, 'cli');
    const base = (arg('--base') || `http://localhost:${PORT}`).replace(/\/+$/, '');
    console.log(`Sign-in link for ${a.name} (${a.role}), works once, until ${l.expires_at.slice(0, 10)}:\n`);
    console.log(`${base}/dashboard/#kt_signin=${l.token}`);
  } else if (cmd === 'import-supabase') {
    await importSupabase();
  } else if (cmd === 'sync-supabase') {
    /* Run by launchd once a day (com.kattitude.studio-sync). Pulls the
     * hosted dashboard's published sheets, artist cards and headshots into
     * KIOSK MEDIA and this Mac's database; see
     * server/supabase-sync.js. Exits 0 even when offline — it just retries. */
    const c = conn();
    const r = await require('./supabase-sync').syncOnce(c);
    if (r.ok && !r.downloaded.length && !r.removed.length && !r.kept.length &&
        !r.artistsAdded.length && !r.artistsUpdated.length && !r.artistsHidden.length && !r.photos.length) {
      console.log(`[supabase-sync] ${db.nowIso()} up to date`);
    }
  } else if (cmd === 'backup') {
    backup();
  } else if (cmd === 'status') {
    status();
  } else {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n'));
    process.exit(cmd ? 1 : 0);
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
