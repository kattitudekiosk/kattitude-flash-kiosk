/* Studio server — sign-in
 *
 * NO EMAIL. Supabase's built-in sender only ever delivered to addresses on
 * Joshua's own account (artists-tab.js says so in as many words), and a free
 * Mac mini has no mail server either. So sign-in is a LINK that Kat hands to
 * an artist herself — by text, AirDrop, Instagram DM, whatever she already
 * uses with them:
 *
 *   1. Kat taps "Copy sign-in link" on the artist's card (admin only).
 *   2. The artist opens it on their phone. That redeems it, once, and the
 *      phone is signed in for SESSION_DAYS.
 *
 * Kat's own very first link comes from the Mac mini itself:
 *     node server/cli.js link Kat
 *
 * The token rides in the URL FRAGMENT (#kt_signin=…), which browsers never
 * send to a server, so it does not land in tunnel logs or Referer headers.
 * Tokens are random 256-bit values stored only as SHA-256 hashes: a copy of
 * the database file is not a copy of anybody's login.
 */
'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const LINK_DAYS = 7;
const SESSION_DAYS = 180;   // artists sign in on their own phones; don't make them redo it monthly

function token() { return crypto.randomBytes(32).toString('base64url'); }
function hash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function days(n) { return new Date(Date.now() + n * 86400000).toISOString(); }

function userFor(artist) {
  return { id: artist.auth_user_id, email: artist.email || null,
           aud: 'authenticated', role: 'authenticated' };
}

/* Create a one-time link for an artist. Any older unused link for the same
 * artist is cancelled, so only the most recent one Kat sent works. */
function createLink(conn, artistId, createdBy) {
  const a = db.getByKey(conn, 'artists', [artistId]);
  if (!a) throw db.httpError(404, 'No such artist');
  if (!a.active) throw db.httpError(409, `${a.name} is switched off — turn them back on first`);
  const t = token();
  db.tx(conn, () => {
    conn.prepare('DELETE FROM signin_links WHERE artist_id = ? AND used_at IS NULL').run(artistId);
    conn.prepare('INSERT INTO signin_links (token_hash, artist_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?)')
      .run(hash(t), artistId, createdBy || null, db.nowIso(), days(LINK_DAYS));
  });
  return { token: t, artist: a, expires_at: days(LINK_DAYS) };
}

function redeem(conn, t) {
  const row = conn.prepare('SELECT * FROM signin_links WHERE token_hash = ?').get(hash(t));
  if (!row || row.used_at || row.expires_at < db.nowIso()) {
    throw db.httpError(401, 'That sign-in link has expired or was already used. Ask Kat for a new one.', 'otp_expired');
  }
  return db.tx(conn, () => {
    conn.prepare('UPDATE signin_links SET used_at = ? WHERE token_hash = ?').run(db.nowIso(), row.token_hash);
    let a = db.getByKey(conn, 'artists', [row.artist_id]);
    if (!a || !a.active) throw db.httpError(403, 'This profile is switched off. Ask Kat.', 'user_banned');
    /* First sign-in claims the card: the artist row gets a login identity.
     * This is the only place auth_user_id is ever written. */
    if (!a.auth_user_id) a = db.updateRow(conn, 'artists', [a.id], { auth_user_id: crypto.randomUUID() });
    const s = token();
    const expires = days(SESSION_DAYS);
    conn.prepare('INSERT INTO sessions (token_hash, artist_id, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?)')
      .run(hash(s), a.id, db.nowIso(), expires, db.nowIso());
    return session(s, a, expires);
  });
}

function session(t, artist, expiresIso) {
  return {
    access_token: t, refresh_token: t, token_type: 'bearer',
    expires_at: Math.floor(new Date(expiresIso).getTime() / 1000),
    expires_in: Math.floor((new Date(expiresIso).getTime() - Date.now()) / 1000),
    user: userFor(artist),
  };
}

/* Bearer token → ctx. Anything wrong with the token is simply "anonymous";
 * the caller then gets exactly what the kiosk gets, never an error page. */
function contextFor(conn, authHeader) {
  const m = String(authHeader || '').match(/^Bearer\s+(.+)$/i);
  const anon = { me: null, isAdmin: false, token: null };
  if (!m) return anon;
  const row = conn.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash(m[1]));
  if (!row || row.expires_at < db.nowIso()) return anon;
  const me = db.getByKey(conn, 'artists', [row.artist_id]);
  if (!me || !me.active) return anon;
  /* Touch at most hourly — no write on every image request. */
  if (!row.last_seen_at || Date.parse(row.last_seen_at) < Date.now() - 3600000) {
    conn.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(db.nowIso(), row.token_hash);
  }
  return { me, isAdmin: me.role === 'admin', token: m[1], expires_at: row.expires_at };
}

function signOut(conn, t) {
  if (t) conn.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(t));
}

/* Kat switching someone off must end their sessions, not just hide them. */
function revokeArtist(conn, artistId) {
  conn.prepare('DELETE FROM sessions WHERE artist_id = ?').run(artistId);
  conn.prepare('DELETE FROM signin_links WHERE artist_id = ? AND used_at IS NULL').run(artistId);
}

module.exports = { createLink, redeem, contextFor, signOut, revokeArtist, session, userFor, hash };
