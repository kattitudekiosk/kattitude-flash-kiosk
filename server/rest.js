/* Studio server — /rest/v1, the PostgREST-shaped part
 *
 * Answers the same URLs Supabase answered, in the same shape, for the subset
 * of PostgREST the kiosk and dashboard actually use:
 *
 *   select=*,child(cols)     embeds declared in db.EMBEDS
 *   col=eq.x | neq | gt | gte | lt | lte | in.(a,b) | is.null|true|false
 *   order=a,b.desc  limit  offset
 *   POST (insert, object or array), PATCH (update), DELETE
 *
 * ORDER OF OPERATIONS, which is the security model:
 *   1. load rows
 *   2. policy.read  — hide rows, and strip columns, the caller may not see
 *   3. THEN apply the caller's filters, to what is left
 * Filtering after the policy is deliberate. Filtering first would let an
 * anonymous caller ask `artists?email=eq.someone@x.com` and learn from
 * whether a row came back that the address belongs to an artist, without
 * ever seeing the column.
 *
 * Writes only ever touch rows the caller can READ (Postgres RLS's USING), and
 * then must also pass the write rule (its WITH CHECK).
 *
 * Data volumes are a tattoo studio's: hundreds of rows, not millions. Every
 * query reads the table and filters in JS, which keeps this file small enough
 * to audit, and that matters more here than speed.
 */
'use strict';

const db = require('./db');
const policy = require('./policy');
const { withKeys, requestQueueRows, canonicalKey } = require('./rpc');
const storage = require('./storage');

const VIEWS = ['kiosk_catalog', 'category_request_queue'];

/* Lazily-built lookups shared by the policy functions during one request. */
function makeEnv(conn) {
  const memo = {};
  const by = (table) => () => memo[table] ||
    (memo[table] = Object.fromEntries(db.all(conn, table).map(r => [r.id, r])));
  return { artistsById: by('artists'), designsById: by('designs'), salesById: by('flash_sales') };
}

/* ── select parsing ──────────────────────────────────────────────────── */
function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(sel) {
  const cols = [], embeds = [];
  for (const part of splitTop(sel || '*')) {
    const m = part.match(/^([a-z_]+)\((.*)\)$/);
    if (m) embeds.push({ table: m[1], cols: splitTop(m[2] || '*') });
    else cols.push(part);
  }
  return { cols: cols.length ? cols : ['*'], embeds };
}

function project(row, cols) {
  if (cols.includes('*')) return row;
  const out = {};
  cols.forEach(c => { if (c in row) out[c] = row[c]; });
  return out;
}

/* ── filters ─────────────────────────────────────────────────────────── */
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns', 'apikey']);

function coerce(raw, sample) {
  if (raw === 'null') return null;
  if (typeof sample === 'boolean' || raw === 'true' || raw === 'false') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  if (typeof sample === 'number' && raw !== '' && !isNaN(Number(raw))) return Number(raw);
  return raw;
}

function parseFilters(params, knownCols) {
  const filters = [];
  for (const [col, expr] of params) {
    if (RESERVED.has(col)) continue;
    if (knownCols && !knownCols.includes(col)) {
      throw db.httpError(400, `column "${col}" does not exist`, '42703');
    }
    const m = String(expr).match(/^(not\.)?(eq|neq|gt|gte|lt|lte|in|is|like|ilike)\.(.*)$/s);
    if (!m) throw db.httpError(400, `unsupported filter "${col}=${expr}"`, 'PGRST100');
    filters.push({ col, not: !!m[1], op: m[2], val: m[3] });
  }
  return filters;
}

function test(row, f) {
  const v = row[f.col];
  const want = coerce(f.val, v);
  let ok;
  switch (f.op) {
    case 'eq': ok = v !== undefined && v === want; break;
    case 'neq': ok = v !== undefined && v !== want; break;
    case 'gt': ok = v > want; break;
    case 'gte': ok = v >= want; break;
    case 'lt': ok = v < want; break;
    case 'lte': ok = v <= want; break;
    case 'is': ok = (f.val === 'null') ? (v === null) : (v === (f.val === 'true')); break;
    case 'in': {
      const list = f.val.replace(/^\(|\)$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, ''));
      ok = list.some(x => coerce(x, v) === v); break;
    }
    case 'like': case 'ilike': {
      const re = new RegExp('^' + f.val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[*%]/g, '.*') + '$',
        f.op === 'ilike' ? 'i' : '');
      ok = typeof v === 'string' && re.test(v); break;
    }
    default: ok = false;
  }
  return f.not ? !ok : ok;
}

function applyOrder(rows, order) {
  if (!order) return rows;
  const keys = order.split(',').map(s => {
    const [col, ...mods] = s.trim().split('.');
    return { col, desc: mods.includes('desc') };
  });
  return rows.slice().sort((a, b) => {
    for (const k of keys) {
      const x = a[k.col], y = b[k.col];
      if (x === y) continue;
      if (x === null || x === undefined) return 1;   // nulls last, both ways
      if (y === null || y === undefined) return -1;
      return (x > y ? 1 : -1) * (k.desc ? -1 : 1);
    }
    return 0;
  });
}

/* ── URLs to stored files ────────────────────────────────────────────── *
 * A file URL is stored as a PATH ("/storage/v1/object/public/flash/…") and
 * given a host on the way out, from whichever address the caller used.
 *
 * Why: the kiosk reaches this server as http://localhost and phones reach it
 * through the tunnel's https address. Store the tunnel address and the wall
 * would fetch every image out through the internet and back — and a free
 * tunnel's address changes when it restarts, which would orphan every image
 * in the catalog at once. A path is right from everywhere.
 *
 * Only URLs that point at a file this server actually holds are shortened;
 * anything else (a Supabase URL from before the move, say) is kept as given. */
function relativize(table, row) {
  for (const c of (db.URL_COLS[table] || [])) {
    const v = row[c];
    if (typeof v !== 'string') continue;
    const m = v.match(/^https?:\/\/[^/]+(\/storage\/v1\/object\/public\/[^?#]+)/);
    if (m && storage.existsPublicPath(m[1])) row[c] = m[1];
  }
  return row;
}
function absolutize(table, row, origin) {
  for (const c of (db.URL_COLS[table] || [])) {
    if (typeof row[c] === 'string' && row[c].startsWith('/storage/')) row[c] = origin + row[c];
  }
  return row;
}

/* ── views ───────────────────────────────────────────────────────────── */
function kioskCatalog(conn) {
  const artists = Object.fromEntries(db.all(conn, 'artists').map(a => [a.id, a]));
  const cats = Object.fromEntries(db.all(conn, 'categories').map(c => [c.id, c]));
  const links = db.all(conn, 'design_categories');
  return db.all(conn, 'designs')
    .filter(d => policy.liveDesign(d, artists))
    .filter(d => !d.artist_id || artists[d.artist_id].kiosk_visible)
    .map(d => {
      const a = artists[d.artist_id] || {};
      const categories = links.filter(l => l.design_id === d.id).map(l => cats[l.category_id])
        .filter(Boolean).sort((x, y) => x.display_order - y.display_order).map(c => c.name);
      return {
        id: d.id, artist_id: d.artist_id, artist_name: a.name || null, artist_handle: a.handle || null,
        title: d.title, type: d.type, image_url: d.image_url, thumb_url: d.thumb_url,
        width: d.width, height: d.height, price_band: d.price_band, featured: d.featured,
        display_order: d.display_order, created_at: d.created_at, source_sheet_id: d.source_sheet_id,
        categories,
      };
    });
}

/* Every row of `table` this caller may see, columns already stripped. */
function readable(conn, ctx, table, env) {
  if (table === 'kiosk_catalog') return kioskCatalog(conn);
  if (table === 'category_request_queue') {
    return requestQueueRows(conn, ctx, readable(conn, ctx, 'category_requests', env));
  }
  const rule = policy.read[table];
  if (!rule) throw db.httpError(404, `Could not find the table 'public.${table}'`, 'PGRST205');
  return db.all(conn, table).map(r => rule(ctx, r, env)).filter(Boolean);
}

function knownCols(table) {
  return db.TABLES[table] ? Object.keys(db.TABLES[table].cols) : null;
}

function selectRows(conn, ctx, table, params, env) {
  let rows = readable(conn, ctx, table, env);
  rows = rows.filter(r => parseFilters(params, knownCols(table)).every(f => test(r, f)));
  rows = applyOrder(rows, params.get('order'));
  const off = parseInt(params.get('offset') || '0', 10) || 0;
  const lim = params.has('limit') ? parseInt(params.get('limit'), 10) : undefined;
  return rows.slice(off, lim === undefined ? undefined : off + lim);
}

function shape(conn, ctx, table, rows, sel, env, origin) {
  const { cols, embeds } = parseSelect(sel);
  return rows.map(r => {
    const out = absolutize(table, project(Object.assign({}, r), cols), origin);
    for (const e of embeds) {
      const fk = (db.EMBEDS[table] || {})[e.table];
      if (!fk) throw db.httpError(400, `Could not find a relationship between '${table}' and '${e.table}'`, 'PGRST200');
      out[e.table] = readable(conn, ctx, e.table, env)
        .filter(c => c[fk] === r.id)
        .map(c => absolutize(e.table, project(Object.assign({}, c), e.cols), origin));
    }
    return out;
  });
}

function checkColumns(table, row) {
  const cols = knownCols(table);
  for (const k of Object.keys(row)) {
    if (!cols.includes(k)) {
      throw db.httpError(400, `Could not find the '${k}' column of '${table}' in the schema cache`, 'PGRST204');
    }
  }
}

/* Extra integrity rules that were triggers or constraints on Supabase. */
function beforeWrite(conn, table, row) {
  if (table === 'categories') withKeys(row);
  if (table === 'category_requests' && row.requested_name !== undefined) {
    const key = canonicalKey(row.requested_name);
    if (!key) throw db.httpError(400, 'Type a name with at least one letter or number.');
    const exists = db.all(conn, 'categories').find(c => c.canonical_key === key || canonicalKey(c.name) === key);
    if (exists) throw db.httpError(409, `That already exists as ${exists.name}. Tag your work with it instead.`, '23505');
  }
  return row;
}

/* ── the handler ─────────────────────────────────────────────────────── */
function handle(conn, ctx, method, table, params, body, origin) {
  const env = makeEnv(conn);
  const sel = params.get('select') || '*';

  if (method === 'GET' || method === 'HEAD') {
    return shape(conn, ctx, table, selectRows(conn, ctx, table, params, env), sel, env, origin);
  }

  if (VIEWS.includes(table)) throw db.httpError(405, `cannot write to view ${table}`, '42809');
  const rules = policy.write[table];
  if (!rules) throw db.httpError(404, `Could not find the table 'public.${table}'`, 'PGRST205');

  if (method === 'POST') {
    const items = Array.isArray(body) ? body : [body];
    if (!items.length || items.some(i => !i || typeof i !== 'object')) {
      throw db.httpError(400, 'Request body must be an object or array of objects', 'PGRST102');
    }
    const rows = db.tx(conn, () => items.map(item => {
      const row = Object.assign({}, item);
      checkColumns(table, row);
      const allowed = rules.insert(ctx, row, env);
      beforeWrite(conn, table, relativize(table, allowed));
      return db.insertRow(conn, table, allowed);
    }));
    const fresh = makeEnv(conn);
    return shape(conn, ctx, table,
      rows.map(r => policy.read[table](ctx, r, fresh)).filter(Boolean), sel, fresh, origin);
  }

  if (method === 'PATCH') {
    const patch = Object.assign({}, body || {});
    checkColumns(table, patch);
    const targets = selectRows(conn, ctx, table, params, env);
    if (!parseFilters(params, knownCols(table)).length) {
      throw db.httpError(400, 'UPDATE requires a WHERE clause', '21000');
    }
    const keys = db.tx(conn, () => targets.map(t => {
      const old = db.getByKey(conn, table, db.keyOf(table, t));
      const p = rules.update(ctx, old, Object.assign({}, patch), env);
      beforeWrite(conn, table, relativize(table, p));
      db.updateRow(conn, table, db.keyOf(table, old), p);
      return db.keyOf(table, old);
    }));
    const fresh = makeEnv(conn);
    const rows = keys.map(k => db.getByKey(conn, table, k)).filter(Boolean)
      .map(r => policy.read[table](ctx, r, fresh)).filter(Boolean);
    return shape(conn, ctx, table, rows, sel, fresh, origin);
  }

  if (method === 'DELETE') {
    if (!parseFilters(params, knownCols(table)).length) {
      throw db.httpError(400, 'DELETE requires a WHERE clause', '21000');
    }
    const targets = selectRows(conn, ctx, table, params, env);
    db.tx(conn, () => targets.forEach(t => {
      const old = db.getByKey(conn, table, db.keyOf(table, t));
      rules.remove(ctx, old, env);
      db.deleteRow(conn, table, db.keyOf(table, old));
    }));
    return shape(conn, ctx, table, targets, sel, env, origin);
  }

  throw db.httpError(405, 'Method not allowed');
}

module.exports = { handle, kioskCatalog, relativize };
