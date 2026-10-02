/* Studio server — database
 *
 * One SQLite file on the Mac mini's own disk, through Node's built-in
 * `node:sqlite`. No npm dependency, no database server to keep alive, and a
 * backup is a copy of one file.
 *
 * The tables mirror the Supabase schema the dashboard was written against,
 * column for column, so app.js does not know which backend it is talking to.
 * Types are declared here once and every read and write goes through
 * encode()/decode(), which is where SQLite's 0/1 becomes true/false and a JSON
 * string becomes an array again.
 *
 * Unknown columns are an ERROR, never silently dropped. PostgREST does the
 * same (PGRST204), and it is what catches the dashboard growing a column the
 * server has not heard of — the failure is loud on the first save, rather
 * than a save that says "Saved" and keeps nothing.
 */
'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/* type: text | int | bool | json | ts
 * Every table gets `id` (uuid text) unless it declares `pk`. */
const TABLES = {
  artists: {
    cols: {
      id: 'text', name: 'text', handle: 'text', email: 'text',
      portrait_url: 'text', portrait_thumb_url: 'text', bio: 'text',
      seniority: 'text', instagram_url: 'text',
      display_order: 'int', active: 'bool', kiosk_visible: 'bool',
      role: 'text', auth_user_id: 'text',
      tutorial_seen: 'json', tutorial_snoozed: 'json', tutorial_seen_at: 'ts',
      created_at: 'ts', updated_at: 'ts',
    },
    defaults: { display_order: 0, active: true, kiosk_visible: true, role: 'artist',
                tutorial_seen: [], tutorial_snoozed: [] },
    required: ['name'],
    ddl: `name TEXT NOT NULL, handle TEXT UNIQUE, email TEXT, portrait_url TEXT,
          portrait_thumb_url TEXT, bio TEXT, seniority TEXT, instagram_url TEXT,
          display_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
          kiosk_visible INTEGER NOT NULL DEFAULT 1,
          role TEXT NOT NULL DEFAULT 'artist' CHECK (role IN ('artist','admin')),
          auth_user_id TEXT UNIQUE, tutorial_seen TEXT, tutorial_snoozed TEXT,
          tutorial_seen_at TEXT, created_at TEXT, updated_at TEXT`,
  },
  categories: {
    cols: { id: 'text', name: 'text', slug: 'text', kind: 'text', display_order: 'int',
            normalized_name: 'text', canonical_key: 'text', created_at: 'ts' },
    defaults: { kind: 'style', display_order: 0 },
    required: ['name'],
    ddl: `name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'style',
          display_order INTEGER NOT NULL DEFAULT 0, normalized_name TEXT,
          canonical_key TEXT UNIQUE, created_at TEXT`,
  },
  designs: {
    cols: { id: 'text', artist_id: 'text', title: 'text', notes: 'text', price_band: 'text',
            image_url: 'text', thumb_url: 'text', width: 'int', height: 'int', type: 'text',
            source_sheet_id: 'text', display_order: 'int', featured: 'bool',
            published: 'bool', approved: 'bool', keywords: 'text',
            /* Set only for designs imported from a file dropped into
             * KIOSK MEDIA (server/folder-sync.js): the file's path relative
             * to KIOSK MEDIA, and size-mtime so a replaced file re-imports. */
            source_file: 'text', source_sig: 'text',
            created_at: 'ts', updated_at: 'ts' },
    defaults: { type: 'design', display_order: 0, featured: false, published: false, approved: true },
    required: ['image_url'],
    ddl: `artist_id TEXT REFERENCES artists(id) ON DELETE SET NULL, title TEXT, notes TEXT,
          price_band TEXT, image_url TEXT NOT NULL, thumb_url TEXT, width INTEGER, height INTEGER,
          type TEXT NOT NULL DEFAULT 'design' CHECK (type IN ('design','sheet')),
          source_sheet_id TEXT REFERENCES designs(id) ON DELETE SET NULL,
          display_order INTEGER NOT NULL DEFAULT 0, featured INTEGER NOT NULL DEFAULT 0,
          published INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 1,
          keywords TEXT, source_file TEXT UNIQUE, source_sig TEXT, created_at TEXT, updated_at TEXT,
          CHECK (source_sheet_id IS NULL OR source_sheet_id <> id)`,
  },
  design_categories: {
    pk: ['design_id', 'category_id'],
    cols: { design_id: 'text', category_id: 'text' },
    defaults: {},
    required: ['design_id', 'category_id'],
    ddl: `design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
          category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
          PRIMARY KEY (design_id, category_id)`,
  },
  category_requests: {
    cols: { id: 'text', requested_name: 'text', requested_by: 'text', status: 'text',
            review_note: 'text', merged_into_category_id: 'text', reviewed_at: 'ts',
            created_at: 'ts' },
    defaults: { status: 'pending' },
    required: ['requested_name'],
    ddl: `requested_name TEXT NOT NULL, requested_by TEXT REFERENCES artists(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','approved','rejected','merged')),
          review_note TEXT,
          merged_into_category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
          reviewed_at TEXT, created_at TEXT`,
  },
  flash_sales: {
    cols: { id: 'text', name: 'text', subtitle: 'text', starts_at: 'ts', ends_at: 'ts',
            published: 'bool', created_at: 'ts', updated_at: 'ts' },
    defaults: { published: false },
    required: ['name'],
    ddl: `name TEXT NOT NULL, subtitle TEXT, starts_at TEXT, ends_at TEXT,
          published INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT`,
  },
  flash_sale_tiers: {
    cols: { id: 'text', sale_id: 'text', price_cents: 'int', label: 'text',
            display_order: 'int', created_at: 'ts' },
    defaults: { display_order: 0 },
    required: ['sale_id', 'price_cents'],
    ddl: `sale_id TEXT NOT NULL REFERENCES flash_sales(id) ON DELETE CASCADE,
          price_cents INTEGER NOT NULL CHECK (price_cents > 0), label TEXT,
          display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT,
          UNIQUE (sale_id, price_cents)`,
  },
  flash_sale_media: {
    cols: { id: 'text', sale_id: 'text', url: 'text', media_type: 'text',
            display_order: 'int', created_at: 'ts' },
    defaults: { media_type: 'image', display_order: 0 },
    required: ['sale_id', 'url'],
    ddl: `sale_id TEXT NOT NULL REFERENCES flash_sales(id) ON DELETE CASCADE,
          url TEXT NOT NULL, media_type TEXT NOT NULL DEFAULT 'image'
            CHECK (media_type IN ('image','video')),
          display_order INTEGER NOT NULL DEFAULT 0, created_at TEXT`,
  },
  flash_sale_designs: {
    pk: ['sale_id', 'design_id'],
    cols: { sale_id: 'text', design_id: 'text' },
    defaults: {},
    required: ['sale_id', 'design_id'],
    ddl: `sale_id TEXT NOT NULL REFERENCES flash_sales(id) ON DELETE CASCADE,
          design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
          PRIMARY KEY (sale_id, design_id)`,
  },
};

/* Child tables that a select can embed, e.g. `*, design_categories(category_id)`.
 * PostgREST resolves these from foreign keys; here they are declared. */
const EMBEDS = {
  designs: { design_categories: 'design_id' },
  flash_sales: { flash_sale_tiers: 'sale_id', flash_sale_media: 'sale_id',
                 flash_sale_designs: 'sale_id' },
};

/* Columns that hold a URL to a file this server stores. They are kept as a
 * PATH in the database and turned back into a full URL per request — see
 * absolutize() in rest.js for why. */
const URL_COLS = {
  artists: ['portrait_url', 'portrait_thumb_url'],
  designs: ['image_url', 'thumb_url'],
  kiosk_catalog: ['image_url', 'thumb_url'],
  flash_sale_media: ['url'],
};

/* Auth bookkeeping. Never exposed through /rest. Tokens are stored hashed,
 * so a copy of the database file does not hand anyone a working session. */
const PRIVATE_DDL = `
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT);
  CREATE TABLE IF NOT EXISTS signin_links (
    token_hash TEXT PRIMARY KEY, artist_id TEXT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

function nowIso() { return new Date().toISOString(); }

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  for (const [name, t] of Object.entries(TABLES)) {
    const idCol = t.pk ? '' : 'id TEXT PRIMARY KEY, ';
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (${idCol}${t.ddl})`);
  }
  db.exec(PRIVATE_DDL);
  /* Columns added after a database was created. SQLite has no ADD COLUMN IF
   * NOT EXISTS, so check first. (UNIQUE cannot be added by ALTER; an index
   * gives the same guarantee.) */
  for (const [name, t] of Object.entries(TABLES)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name));
    for (const col of Object.keys(t.cols)) {
      if (!have.has(col)) db.exec(`ALTER TABLE ${name} ADD COLUMN ${col} TEXT`);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS designs_source_file ON designs(source_file)');
  return db;
}

function encode(table, col, v) {
  const type = TABLES[table].cols[col];
  if (v === undefined || v === null) return null;
  switch (type) {
    case 'bool': return v ? 1 : 0;
    case 'int': {
      const n = Number(v);
      if (!Number.isFinite(n)) throw httpError(400, `${col} must be a number`, '22P02');
      return Math.trunc(n);
    }
    case 'json': return JSON.stringify(v);
    case 'ts': {
      const d = new Date(v);
      if (isNaN(d)) throw httpError(400, `${col} is not a valid date`, '22007');
      return d.toISOString();
    }
    default: return String(v);
  }
}

function decodeRow(table, raw) {
  const out = {};
  for (const [col, type] of Object.entries(TABLES[table].cols)) {
    const v = raw[col];
    if (v === null || v === undefined) { out[col] = (type === 'json') ? [] : null; continue; }
    if (type === 'bool') out[col] = v === 1 || v === true;
    else if (type === 'int') out[col] = Number(v);
    else if (type === 'json') { try { out[col] = JSON.parse(v); } catch (e) { out[col] = []; } }
    else out[col] = v;
  }
  return out;
}

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status; e.code = code || null;
  return e;
}

/* Map SQLite constraint failures onto the messages the dashboard already
 * pattern-matches (flash-sales.js looks for /duplicate|unique/). */
function sqlError(e) {
  const m = String(e && e.message || e);
  if (/UNIQUE constraint failed/i.test(m)) {
    return httpError(409, 'duplicate key value violates unique constraint (' +
      m.replace(/.*UNIQUE constraint failed:\s*/i, '') + ')', '23505');
  }
  if (/FOREIGN KEY constraint failed/i.test(m)) {
    return httpError(409, 'insert or update violates foreign key constraint', '23503');
  }
  if (/CHECK constraint failed/i.test(m)) {
    return httpError(400, 'new row violates check constraint (' +
      m.replace(/.*CHECK constraint failed:\s*/i, '') + ')', '23514');
  }
  if (/NOT NULL constraint failed/i.test(m)) {
    return httpError(400, 'null value violates not-null constraint (' +
      m.replace(/.*NOT NULL constraint failed:\s*/i, '') + ')', '23502');
  }
  return e;
}

function keyOf(table, row) {
  const t = TABLES[table];
  return (t.pk || ['id']).map(k => row[k]);
}

function whereKey(table) {
  return (TABLES[table].pk || ['id']).map(k => `${k} = ?`).join(' AND ');
}

function all(db, table) {
  return db.prepare(`SELECT * FROM ${table}`).all().map(r => decodeRow(table, r));
}

function insertRow(db, table, input) {
  const t = TABLES[table];
  const row = Object.assign({}, t.defaults, input);
  if (!t.pk && !row.id) row.id = crypto.randomUUID();
  const now = nowIso();
  if ('created_at' in t.cols && !row.created_at) row.created_at = now;
  if ('updated_at' in t.cols) row.updated_at = now;
  for (const r of t.required) {
    if (row[r] === undefined || row[r] === null || row[r] === '') {
      throw httpError(400, `null value in column "${r}" violates not-null constraint`, '23502');
    }
  }
  const cols = Object.keys(row);
  try {
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
      .run(...cols.map(c => encode(table, c, row[c])));
  } catch (e) { throw sqlError(e); }
  return getByKey(db, table, keyOf(table, row));
}

function updateRow(db, table, key, patch) {
  const t = TABLES[table];
  const p = Object.assign({}, patch);
  if ('updated_at' in t.cols) p.updated_at = nowIso();
  const cols = Object.keys(p);
  if (!cols.length) return getByKey(db, table, key);
  try {
    db.prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE ${whereKey(table)}`)
      .run(...cols.map(c => encode(table, c, p[c])), ...key);
  } catch (e) { throw sqlError(e); }
  return getByKey(db, table, key);
}

function deleteRow(db, table, key) {
  try { db.prepare(`DELETE FROM ${table} WHERE ${whereKey(table)}`).run(...key); }
  catch (e) { throw sqlError(e); }
}

function getByKey(db, table, key) {
  const raw = db.prepare(`SELECT * FROM ${table} WHERE ${whereKey(table)}`).get(...key);
  return raw ? decodeRow(table, raw) : null;
}

/* Run fn inside one transaction. node:sqlite is synchronous and this server
 * is one process, so nothing interleaves; the transaction is for atomicity —
 * a multi-row insert either lands whole or not at all. */
function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* already rolled back */ } throw e; }
}

module.exports = {
  TABLES, EMBEDS, URL_COLS, open, all, insertRow, updateRow, deleteRow, getByKey,
  keyOf, tx, httpError, nowIso, decodeRow,
};
