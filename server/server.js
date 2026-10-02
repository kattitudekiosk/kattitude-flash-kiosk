#!/usr/bin/env node
/* Kattitude studio server — the Mac mini as the studio's own backend
 *
 * One Node process, no npm dependencies, holding:
 *   - the database   (SQLite, <data>/kattitude.db)
 *   - every photo    (~/Desktop/KIOSK MEDIA/<Artist>/Flash|Headshots)
 *   - sign-in        (one-time links → long-lived sessions)
 *   - the kiosk and the dashboard themselves, served from this repo
 *
 * The wall's Safari opens http://localhost:8787 and needs no internet at all.
 * Phones reach the dashboard through a tunnel (see server/README.md) at
 * <tunnel>/dashboard/.
 *
 * It speaks Supabase's URL shapes (/rest/v1, /storage/v1, /auth/v1) so the
 * kiosk and dashboard code are unchanged. Served from here, two HTML files get
 * one script tag injected to point them at this server; served from Vercel,
 * they are byte-for-byte what they were and still talk to Supabase.
 *
 *   KT_DATA_DIR  where data lives      default ~/KattitudeData
 *   KT_PORT      port                  default 8787
 *   KT_HOST      interface to bind     default 127.0.0.1 (this machine only;
 *                                      the tunnel connects from localhost)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./db');
const rest = require('./rest');
const auth = require('./auth');
const storage = require('./storage');
const { RPC } = require('./rpc');

const REPO = path.resolve(__dirname, '..');
const DATA = process.env.KT_DATA_DIR || path.join(os.homedir(), 'KattitudeData');
const PORT = parseInt(process.env.KT_PORT || '8787', 10);
const HOST = process.env.KT_HOST || '127.0.0.1';
const JSON_LIMIT = 2 * 1024 * 1024;

/* ── static files ────────────────────────────────────────────────────── *
 * The repo is the website, as on Vercel — minus what .vercelignore keeps off
 * Vercel, minus this server's own code, minus anything dotted (.git!). */
const DENY_TOP = new Set(['server', 'tools', 'db', 'node_modules', 'assets/originals',
  'seed', 'assets/seed']);   // placeholder data never reaches a browser
const STATIC_TYPES = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', mp4: 'video/mp4',
  woff: 'font/woff', woff2: 'font/woff2', gif: 'image/gif',
};

function staticPath(urlPath) {
  let p = decodeURIComponent(urlPath);
  if (p.endsWith('/')) p += 'index.html';
  const segs = p.split('/').filter(Boolean);
  if (!segs.length || segs.some(s => s.startsWith('.') || s === '..')) return null;
  if (DENY_TOP.has(segs[0]) || DENY_TOP.has(segs.slice(0, 2).join('/'))) return null;
  if (/\.md$/i.test(p)) return null;
  const full = path.resolve(REPO, ...segs);
  if (!full.startsWith(REPO + path.sep)) return null;
  const ext = (full.match(/\.([a-z0-9]+)$/i) || [])[1];
  if (!ext || !STATIC_TYPES[ext.toLowerCase()]) return null;
  return full;
}

/* The two injections. Each anchors on an exact tag; if the tag has moved,
 * the page is served as a 500 that says so, rather than quietly serving a
 * dashboard that talks to Supabase while everyone thinks it is local. */
const INJECT = {
  'index.html': {
    anchor: '<script src="config.js"></script>',
    add: '\n  <script src="studio-server.js"></script><!-- injected by server/server.js -->',
  },
  'dashboard/index.html': {
    anchor: '<script src="config.js"></script>',
    add: '\n<script src="local-backend.js"></script><!-- injected by server/server.js -->',
    tail: '</body>',
    tailAdd: '<script src="local-links.js"></script><!-- injected by server/server.js -->\n',
    drop: '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>',
  },
};

function injected(rel, html) {
  const rule = INJECT[rel];
  if (!rule) return html;
  if (!html.includes(rule.anchor)) throw db.httpError(500, `studio server: injection anchor missing in ${rel}`);
  let out = html.replace(rule.anchor, rule.anchor + rule.add);
  if (rule.drop) out = out.replace(rule.drop, '<!-- supabase-js not needed: this page talks to the studio server -->');
  if (rule.tail) {
    if (!out.includes(rule.tail)) throw db.httpError(500, `studio server: injection anchor missing in ${rel}`);
    out = out.replace(rule.tail, rule.tailAdd + rule.tail);
  }
  return out;
}

/* Point the kiosk at this server. Relative URLs, so it works from localhost
 * and through the tunnel alike. */
const KIOSK_OVERRIDE = `/* Served by the Kattitude studio server (server/server.js), not a file in the repo.
   Points the kiosk at the catalog on this Mac mini instead of Supabase. */
(function () {
  var c = window.KIOSK_CONFIG;
  if (!c) return;
  c.catalogSource = 'live';
  c.studioServer = true;
  c.live = Object.assign({}, c.live, {
    url: '/rest/v1/kiosk_catalog?select=*',
    anonKey: '',
    artistsUrl: '/rest/v1/artists?active=eq.true&order=display_order' +
      '&select=id,name,handle,portrait_url,portrait_thumb_url,bio,instagram_url,seniority,display_order',
    categoriesUrl: '/rest/v1/categories?order=display_order',
    /* A file dropped into KIOSK MEDIA should reach the wall within a minute. */
    refreshMs: 60 * 1000,
  });
})();
`;

/* ── plumbing ────────────────────────────────────────────────────────── */
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.socket.encrypted ? 'https' : 'http');
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

const CORS = {
  /* Bearer tokens, never cookies, so * is safe: a foreign page can only send
   * a token it already has. This lets a Vercel-hosted dashboard use the
   * tunnel as its backend. */
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-upsert, prefer, x-client-info, cache-control, range',
  'Access-Control-Expose-Headers': 'content-range, content-length, etag',
  'Access-Control-Max-Age': '600',
};

function send(res, status, body, headers) {
  const h = Object.assign({}, CORS, headers || {});
  if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
    body = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  res.writeHead(status, h);
  res.end(body);
}

function fail(res, e) {
  const status = e.status || 500;
  if (status >= 500) console.error('[studio-server]', e);
  send(res, status, { message: e.message || 'Server error', code: e.code || null,
                      error: e.code || null, statusCode: String(status) });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > limit) { reject(db.httpError(413, 'Request is too large', 'EntityTooLarge')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, JSON_LIMIT);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) { throw db.httpError(400, 'Body is not valid JSON', 'PGRST102'); }
}

/* Files with Range support. Safari will not play a <video> from a server
 * that ignores Range, and the attract reel and flash sale clips are video. */
function streamFile(req, res, file, size, headers) {
  const h = Object.assign({}, CORS, headers);
  if (headers.ETag && req.headers['if-none-match'] === headers.ETag) {
    res.writeHead(304, h); res.end(); return;
  }
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    if (start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, Object.assign(h, { 'Content-Range': `bytes */${size}` })); res.end(); return;
    }
    res.writeHead(206, Object.assign(h, { 'Content-Range': `bytes ${start}-${end}/${size}`,
                                          'Content-Length': end - start + 1 }));
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, Object.assign(h, { 'Content-Length': size }));
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).pipe(res);
}

/* ── routes ──────────────────────────────────────────────────────────── */
function makeServer(conn) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const origin = originOf(req);
    /* One line per write — uploads, saves, deletes, sign-ins — with who did
     * it and how it ended. "Where did my uploads go?" must be answerable
     * from ~/KattitudeData/logs/server.log, not from guesswork. */
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      res.on('finish', () => {
        let who = 'anon';
        try { const c = auth.contextFor(conn, req.headers.authorization); if (c.me) who = c.me.name; } catch (e) {}
        console.log(`[studio-server] ${db.nowIso()} ${req.method} ${p} -> ${res.statusCode} by ${who}` +
          (req.headers['content-length'] ? ` (${req.headers['content-length']} bytes)` : ''));
      });
    }
    try {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      const ctx = auth.contextFor(conn, req.headers.authorization);

      if (p === '/healthz') {
        const n = t => conn.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;
        return send(res, 200, { ok: true, artists: n('artists'), designs: n('designs'),
                                categories: n('categories'), time: db.nowIso() });
      }

      /* ── REST ── */
      let m = p.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
      if (m) {
        if (req.method !== 'POST') throw db.httpError(405, 'Use POST');
        const fn = RPC[m[1]];
        if (!fn) throw db.httpError(404, `Could not find the function public.${m[1]}`, 'PGRST202');
        return send(res, 200, fn(conn, ctx, await readJson(req)));
      }
      m = p.match(/^\/rest\/v1\/([a-z_]+)$/);
      if (m) {
        const body = ['POST', 'PATCH'].includes(req.method) ? await readJson(req) : null;
        /* Artist renamed → rename their KIOSK MEDIA folder to match. */
        const before = (m[1] === 'artists' && body && body.name !== undefined)
          ? Object.fromEntries(db.all(conn, 'artists').map(a => [a.id, a.name])) : null;
        const rows = rest.handle(conn, ctx, req.method, m[1], url.searchParams, body, origin);
        if (m[1] === 'artists' && req.method === 'PATCH' && body && body.active === false) {
          rows.forEach(r => auth.revokeArtist(conn, r.id));
        }
        if (m[1] === 'artists' && rows.length) {
          if (before) rows.forEach(r => storage.renameArtistFolder(before[r.id], r.name));
          if (req.method === 'POST') storage.ensureArtistFolders(rows.map(r => r.name));
        }
        return send(res, req.method === 'POST' ? 201 : 200, rows);
      }

      /* ── AUTH ── */
      if (p === '/auth/v1/otp') {
        throw db.httpError(400, 'Email sign-in is not set up on the studio server. ' +
          'Kat can copy your sign-in link from the Artists tab and text it to you.', 'email_disabled');
      }
      if (p === '/auth/v1/link' && req.method === 'POST') {
        if (!ctx.isAdmin) throw db.httpError(403, 'Only an admin can make sign-in links', '42501');
        const { artist_id, redirect_to } = await readJson(req);
        const link = auth.createLink(conn, artist_id, ctx.me.id);
        return send(res, 200, { url: linkUrl(redirect_to, origin, link.token),
                                expires_at: link.expires_at, artist: link.artist.name });
      }
      if (p === '/auth/v1/redeem' && req.method === 'POST') {
        const { token } = await readJson(req);
        return send(res, 200, auth.redeem(conn, token));
      }
      if (p === '/auth/v1/user') {
        if (!ctx.me) throw db.httpError(401, 'Not signed in', 'not_authenticated');
        return send(res, 200, auth.userFor(ctx.me));
      }
      if (p === '/auth/v1/logout' && req.method === 'POST') {
        auth.signOut(conn, ctx.token);
        return send(res, 204, '');
      }

      /* ── STORAGE ── */
      m = p.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
      if (m && (req.method === 'GET' || req.method === 'HEAD')) {
        const f = storage.publicFile(m[1], decodeURIComponent(m[2]));
        if (f.status !== 200) return send(res, f.status, { message: 'Object not found' });
        return streamFile(req, res, f.file, f.size, f.headers);
      }
      m = p.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
      if (m && req.method === 'POST') {
        const { prefix, limit } = await readJson(req);
        return send(res, 200, storage.list(ctx, m[1], prefix, limit));
      }
      m = p.match(/^\/storage\/v1\/object\/([^/]+)$/);
      if (m && req.method === 'DELETE') {
        const { prefixes } = await readJson(req);
        return send(res, 200, storage.remove(ctx, m[1], prefixes));
      }
      m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
      if (m && (req.method === 'POST' || req.method === 'PUT')) {
        if (!ctx.me) throw db.httpError(403, 'Sign in to upload', '42501');
        const buf = await readBody(req, storage.MAX_BYTES);
        const upsert = req.method === 'PUT' || String(req.headers['x-upsert']) === 'true';
        return send(res, 200, storage.upload(ctx, m[1], decodeURIComponent(m[2]), buf, upsert));
      }

      /* ── the kiosk and dashboard ── */
      if (p === '/studio-server.js') {
        return send(res, 200, KIOSK_OVERRIDE, { 'Content-Type': 'text/javascript; charset=utf-8',
                                                'Cache-Control': 'no-cache' });
      }
      if (p === '/dashboard') return send(res, 301, '', { Location: '/dashboard/' });
      if (req.method === 'GET' || req.method === 'HEAD') {
        const full = staticPath(p);
        let st = null;
        try { st = full && fs.statSync(full); } catch (e) { st = null; }
        if (!st || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
        const rel = path.relative(REPO, full).split(path.sep).join('/');
        const type = STATIC_TYPES[full.match(/\.([a-z0-9]+)$/i)[1].toLowerCase()];
        if (INJECT[rel]) {
          const html = injected(rel, fs.readFileSync(full, 'utf8'));
          return send(res, 200, html, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
        }
        return streamFile(req, res, full, st.size, {
          'Content-Type': type, 'Cache-Control': 'no-cache',
          ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        });
      }
      throw db.httpError(404, 'Not found');
    } catch (e) {
      fail(res, e);
    }
  });
}

/* Where a sign-in link lands. The dashboard asks for its own address so a
 * link made on the tunnel opens on the tunnel. Only same-origin or relative
 * targets are honoured — a link must never be redirectable to someone else's
 * site with a live token in it. */
function linkUrl(redirectTo, origin, token) {
  let base = origin + '/dashboard/';
  try {
    if (redirectTo) {
      const u = new URL(redirectTo, origin);
      if (u.origin === origin) base = u.origin + u.pathname;
    }
  } catch (e) { /* fall back to the default */ }
  return base + '#kt_signin=' + token;
}

function start() {
  const conn = db.open(path.join(DATA, 'kattitude.db'));
  storage.init(DATA, { artistName: id => (db.getByKey(conn, 'artists', [id]) || {}).name });
  storage.ensureArtistFolders(db.all(conn, 'artists').map(a => a.name));
  /* Files dropped straight into KIOSK MEDIA go on the wall too. */
  require('./folder-sync').start(conn);
  const server = makeServer(conn);
  server.listen(PORT, HOST, () => {
    console.log(`[studio-server] ${db.nowIso()} listening on http://${HOST}:${PORT}  data=${DATA}`);
  });
  const stop = () => { server.close(); try { conn.close(); } catch (e) {} process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return server;
}

if (require.main === module) start();

module.exports = { makeServer, injected, staticPath, linkUrl, KIOSK_OVERRIDE };
