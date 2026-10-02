/* Studio server — the dashboard's RPCs
 *
 * The four category-request functions that lived in Postgres. Same names,
 * same argument names, same return shapes, because app.js calls them by name
 * through sb.rpc() and reads specific fields off the answer.
 *
 * Similarity is trigram similarity, computed the way pg_trgm computes it, so
 * the "Merge into Floral (62% alike)" buttons mean what they meant before.
 */
'use strict';

const db = require('./db');
const { deny } = require('./policy');

const SIMILAR = 0.3;   // pg_trgm's default similarity_threshold

function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
/* "Fine-Line", "fine line" and "FineLine" are one category. */
function canonicalKey(s) {
  return normalizeName(s).replace(/[^a-z0-9]+/g, '');
}

function trigrams(s) {
  const set = new Set();
  normalizeName(s).split(/[^a-z0-9]+/).filter(Boolean).forEach(w => {
    const p = '  ' + w + ' ';
    for (let i = 0; i < p.length - 2; i++) set.add(p.slice(i, i + 3));
  });
  return set;
}
function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  A.forEach(t => { if (B.has(t)) both++; });
  return both / (A.size + B.size - both);
}

function nearMatches(name, categories) {
  return categories
    .map(c => ({ id: c.id, name: c.name, kind: c.kind, similarity: similarity(name, c.name) }))
    .filter(m => m.similarity >= SIMILAR)
    .sort((x, y) => y.similarity - x.similarity)
    .slice(0, 5);
}

/* Fill the derived columns a category row carries. Called on every category
 * insert and rename, so the canonical key cannot drift from the name. */
function withKeys(row) {
  if (row.name !== undefined) {
    row.name = String(row.name).trim();
    row.normalized_name = normalizeName(row.name);
    row.canonical_key = canonicalKey(row.name);
    if (!row.slug) row.slug = row.normalized_name.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  return row;
}

function requestQueueRows(conn, ctx, readable) {
  const artists = Object.fromEntries(db.all(conn, 'artists').map(a => [a.id, a]));
  const cats = db.all(conn, 'categories');
  const all = db.all(conn, 'category_requests');
  return readable.map(r => {
    const a = artists[r.requested_by] || {};
    const key = canonicalKey(r.requested_name);
    return Object.assign({}, r, {
      requested_by_name: a.name || null,
      requested_by_handle: a.handle || null,
      near_matches: r.status === 'pending' ? nearMatches(r.requested_name, cats) : [],
      pending_duplicates: all.filter(x => x.status === 'pending' &&
        canonicalKey(x.requested_name) === key).length,
    });
  });
}

const RPC = {
  check_category_name(conn, ctx, { p_name }) {
    if (!ctx.me) throw deny();
    const key = canonicalKey(p_name);
    if (!key) return { reason: 'empty', message: 'Type a name with at least one letter or number.' };
    const cats = db.all(conn, 'categories');
    const exact = cats.find(c => canonicalKey(c.name) === key);
    if (exact) return { reason: 'exists', exact: { id: exact.id, name: exact.name, kind: exact.kind } };
    const myPending = db.all(conn, 'category_requests').find(r =>
      r.requested_by === ctx.me.id && r.status === 'pending' && canonicalKey(r.requested_name) === key);
    if (myPending) return { reason: 'already_requested', my_pending: myPending };
    return { reason: 'available', near: nearMatches(p_name, cats) };
  },

  approve_category_request(conn, ctx, { p_request_id, p_kind }) {
    if (!ctx.isAdmin) throw deny();
    return db.tx(conn, () => {
      const r = pending(conn, p_request_id);
      const cats = db.all(conn, 'categories');
      const cat = db.insertRow(conn, 'categories', withKeys({
        name: r.requested_name, kind: p_kind || 'theme', display_order: cats.length,
      }));
      db.updateRow(conn, 'category_requests', [r.id],
        { status: 'approved', merged_into_category_id: cat.id, reviewed_at: db.nowIso() });
      return cat;
    });
  },

  reject_category_request(conn, ctx, { p_request_id, p_note }) {
    if (!ctx.isAdmin) throw deny();
    const r = pending(conn, p_request_id);
    db.updateRow(conn, 'category_requests', [r.id],
      { status: 'rejected', review_note: p_note || null, reviewed_at: db.nowIso() });
    return null;
  },

  merge_category_request(conn, ctx, { p_request_id, p_category_id, p_note }) {
    if (!ctx.isAdmin) throw deny();
    const r = pending(conn, p_request_id);
    if (!db.getByKey(conn, 'categories', [p_category_id])) throw db.httpError(404, 'That category no longer exists');
    db.updateRow(conn, 'category_requests', [r.id], {
      status: 'merged', merged_into_category_id: p_category_id,
      review_note: p_note || null, reviewed_at: db.nowIso(),
    });
    return null;
  },
};

function pending(conn, id) {
  const r = db.getByKey(conn, 'category_requests', [id]);
  if (!r) throw db.httpError(404, 'That request no longer exists');
  if (r.status !== 'pending') throw db.httpError(409, 'That request has already been answered');
  return r;
}

module.exports = { RPC, withKeys, requestQueueRows, canonicalKey, similarity };
