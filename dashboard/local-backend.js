/* Kattitude Flash Dashboard — STUDIO SERVER BACKEND
 *
 * Replaces window.supabase with a client that talks to the studio server on
 * the Mac mini (server/server.js) instead of Supabase. Same idea as
 * demo-backend.js, which proved the dashboard does not care what is behind
 * `window.supabase.createClient` — except this one is real: every request
 * goes to the server, and the server enforces who may do what.
 *
 * NOT referenced by index.html. The studio server injects it, right after
 * config.js, when it serves the dashboard. Opened from Vercel, the dashboard
 * is unchanged and still talks to Supabase.
 *
 * Covers exactly the calls the dashboard makes — from/select/eq/order/limit/
 * single/maybeSingle/insert/update/delete, rpc, storage upload/getPublicUrl/
 * list/remove, and the six auth calls. Anything else throws loudly, so a new
 * call shows up as an error on first use rather than as a silent no-op.
 *
 * SIGN-IN: a link Kat sends, carrying #kt_signin=<token>. It is redeemed once
 * on arrival, the fragment is wiped from the address bar, and the session is
 * stored under the same localStorage key dash-client.js reads.
 */
(function () {
  'use strict';

  var cfg = window.DASH_CONFIG || (window.DASH_CONFIG = {});
  /* A Vercel-hosted copy may name a studio server explicitly; served by the
   * studio server itself, the server is simply this page's own origin. */
  var BASE = (cfg.studioServerUrl || window.location.origin).replace(/\/+$/, '');
  cfg.supabaseUrl = BASE;
  cfg.supabaseAnonKey = 'studio-server';
  cfg.backend = 'studio-server';

  /* Derived exactly as dash-client.js derives it, so both read one session. */
  function storageKey() {
    try { return 'sb-' + new URL(cfg.supabaseUrl).hostname.split('.')[0] + '-auth-token'; }
    catch (e) { return 'sb-studio-auth-token'; }
  }
  function loadSession() {
    try {
      var s = JSON.parse(window.localStorage.getItem(storageKey()) || 'null');
      if (s && s.access_token && (!s.expires_at || s.expires_at * 1000 > Date.now())) return s;
    } catch (e) { /* private mode or junk: signed out */ }
    return null;
  }
  function saveSession(s) {
    try {
      if (s) window.localStorage.setItem(storageKey(), JSON.stringify(s));
      else window.localStorage.removeItem(storageKey());
    } catch (e) { /* the in-memory copy still works for this tab */ }
    memSession = s;
  }
  var memSession = null;
  function current() { return loadSession() || memSession; }

  function err(message, code, status) {
    return { message: message || 'Request failed', code: code || null, details: null, hint: null, status: status };
  }

  async function call(method, path, body, token, extraHeaders, raw) {
    var headers = Object.assign({}, extraHeaders || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    var res;
    try {
      res = await fetch(BASE + path, {
        method: method, headers: headers,
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
      });
    } catch (e) {
      return { data: null, error: err('Cannot reach the studio server. Is the Mac mini on?', 'network') };
    }
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      return { data: null, status: res.status,
               error: err(data && data.message ? data.message : res.status + ' ' + res.statusText,
                          data && data.code, res.status) };
    }
    return { data: data, error: null, status: res.status };
  }

  /* ── SIGN-IN LINK ARRIVAL ─────────────────────────────────────────────
   * Runs once, before anything asks for the session. getSession() waits on
   * it, which is what makes a freshly-opened link land straight in the app
   * rather than flashing the sign-in screen first. */
  var arrival = (async function () {
    var m = (window.location.hash || '').match(/kt_signin=([A-Za-z0-9_-]+)/);
    if (m) {
      /* Wipe the token from the address bar BEFORE redeeming, so it cannot be
       * bookmarked, shared or screenshotted in the time the request takes. */
      try { history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) {}
      var r = await call('POST', '/auth/v1/redeem', { token: m[1] });
      if (r.error) { window.KT_SIGNIN_ERROR = r.error.message; return; }
      saveSession(r.data);
      return;
    }
    /* A stored session the server no longer honours (Kat switched the artist
     * off, or it expired) is dropped here, so the app shows the sign-in
     * screen instead of an empty dashboard. */
    var s = current();
    if (s) {
      var u = await call('GET', '/auth/v1/user', undefined, s.access_token);
      if (u.error && u.status === 401) saveSession(null);
      else if (u.data) { s.user = u.data; saveSession(s); }
    }
  })();

  var listeners = [];
  function emit(evt, session) {
    listeners.forEach(function (cb) { try { cb(evt, session); } catch (e) { console.error(e); } });
  }

  /* After app.js shows the sign-in card, say why a link failed, once. */
  document.addEventListener('DOMContentLoaded', function () {
    arrival.then(function () {
      if (!window.KT_SIGNIN_ERROR) return;
      var msg = document.getElementById('signinMsg');
      if (msg) msg.textContent = window.KT_SIGNIN_ERROR;
    });
  });

  /* ── QUERY BUILDER ──────────────────────────────────────────────────── */
  function enc(v) { return encodeURIComponent(v === null ? 'null' : String(v)); }

  function Query(client, table) {
    this.c = client; this.t = table;
    this.sel = null; this.filters = []; this.orders = [];
    this.lim = null; this.off = null; this.mode = 'select'; this.payload = undefined; this.one = null;
  }
  Query.prototype.select = function (s) { this.sel = s || '*'; return this; };
  ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'like', 'ilike'].forEach(function (op) {
    Query.prototype[op] = function (col, val) { this.filters.push(col + '=' + op + '.' + enc(val)); return this; };
  });
  Query.prototype.is = function (col, val) { this.filters.push(col + '=is.' + enc(val)); return this; };
  Query.prototype.in = function (col, vals) {
    this.filters.push(col + '=in.(' + vals.map(function (v) { return enc(v); }).join(',') + ')'); return this;
  };
  Query.prototype.match = function (obj) {
    var self = this; Object.keys(obj).forEach(function (k) { self.eq(k, obj[k]); }); return this;
  };
  Query.prototype.order = function (col, opts) {
    this.orders.push(col + (opts && opts.ascending === false ? '.desc' : '.asc')); return this;
  };
  Query.prototype.limit = function (n) { this.lim = n; return this; };
  Query.prototype.range = function (a, b) { this.off = a; this.lim = b - a + 1; return this; };
  Query.prototype.insert = function (p) { this.mode = 'insert'; this.payload = p; return this; };
  Query.prototype.update = function (p) { this.mode = 'update'; this.payload = p; return this; };
  Query.prototype.delete = function () { this.mode = 'delete'; return this; };
  Query.prototype.upsert = function () { throw new Error('upsert is not supported by the studio server'); };
  Query.prototype.single = function () { this.one = 'strict'; return this; };
  Query.prototype.maybeSingle = function () { this.one = 'maybe'; return this; };
  Query.prototype.then = function (ok, bad) { return this._run().then(ok, bad); };

  Query.prototype._run = async function () {
    var q = [];
    q.push('select=' + encodeURIComponent(this.sel || '*'));
    q = q.concat(this.filters);
    if (this.orders.length) q.push('order=' + this.orders.join(','));
    if (this.lim !== null) q.push('limit=' + this.lim);
    if (this.off !== null) q.push('offset=' + this.off);
    var path = '/rest/v1/' + this.t + '?' + q.join('&');
    var method = { select: 'GET', insert: 'POST', update: 'PATCH', delete: 'DELETE' }[this.mode];
    var r = await call(method, path, this.mode === 'insert' || this.mode === 'update' ? this.payload : undefined,
                       await this.c._token());
    if (r.error) return { data: null, error: r.error, status: r.status };
    var rows = Array.isArray(r.data) ? r.data : [];
    if (this.one) {
      if (rows.length === 1) return { data: rows[0], error: null, status: r.status };
      if (!rows.length && this.one === 'maybe') return { data: null, error: null, status: r.status };
      return { data: null, status: 406,
               error: err(rows.length ? 'JSON object requested, multiple rows returned'
                                      : 'JSON object requested, no rows returned', 'PGRST116', 406) };
    }
    return { data: rows, error: null, count: rows.length, status: r.status };
  };

  /* ── STORAGE ────────────────────────────────────────────────────────── */
  function objPath(p) { return String(p).split('/').map(encodeURIComponent).join('/'); }

  function bucket(client, name) {
    return {
      upload: async function (path, body, opts) {
        opts = opts || {};
        var headers = { 'x-upsert': opts.upsert ? 'true' : 'false' };
        if (opts.contentType || (body && body.type)) headers['Content-Type'] = opts.contentType || body.type;
        var r = await call('POST', '/storage/v1/object/' + name + '/' + objPath(path), body,
                           await client._token(), headers, true);
        return r.error ? { data: null, error: r.error } : { data: { path: path }, error: null };
      },
      getPublicUrl: function (path) {
        return { data: { publicUrl: BASE + '/storage/v1/object/public/' + name + '/' + objPath(path) } };
      },
      list: async function (prefix, opts) {
        return call('POST', '/storage/v1/object/list/' + name,
                    { prefix: prefix || '', limit: (opts && opts.limit) || 100 }, await client._token());
      },
      remove: async function (paths) {
        return call('DELETE', '/storage/v1/object/' + name, { prefixes: paths || [] }, await client._token());
      },
    };
  }

  /* ── CLIENT ─────────────────────────────────────────────────────────── */
  function createClient(_url, _key, options) {
    var own = null;   // set by setSession(); dash-client.js uses that path
    var persist = !(options && options.auth && options.auth.persistSession === false);

    var client = {
      _token: async function () {
        await arrival;
        var s = own || current();
        return s ? s.access_token : null;
      },
      from: function (t) { return new Query(client, t); },
      rpc: async function (fn, args) {
        return call('POST', '/rest/v1/rpc/' + fn, args || {}, await client._token());
      },
      storage: { from: function (b) { return bucket(client, b); } },
      channel: function () { throw new Error('Realtime is not available on the studio server'); },
      removeChannel: function () {},
      auth: {
        getSession: async function () {
          await arrival;
          return { data: { session: own || current() }, error: null };
        },
        getUser: async function () {
          var t = await client._token();
          if (!t) return { data: { user: null }, error: err('Not signed in', 'not_authenticated', 401) };
          var r = await call('GET', '/auth/v1/user', undefined, t);
          return r.error ? { data: { user: null }, error: r.error } : { data: { user: r.data }, error: null };
        },
        setSession: async function (s) {
          await arrival;
          var stored = current();
          own = (stored && stored.access_token === s.access_token) ? stored
              : { access_token: s.access_token, refresh_token: s.refresh_token };
          if (persist) saveSession(own);
          return { data: { session: own }, error: null };
        },
        signInWithOtp: async function (args) {
          var r = await call('POST', '/auth/v1/otp', args || {});
          return { data: r.data, error: r.error };
        },
        signOut: async function () {
          var t = await client._token();
          if (t) await call('POST', '/auth/v1/logout', {}, t);
          own = null;
          saveSession(null);
          emit('SIGNED_OUT', null);
          return { error: null };
        },
        onAuthStateChange: function (cb) {
          /* No INITIAL_SESSION event: app.js picks the session up through
           * getSession(), and firing both would run onSignedIn() twice. */
          listeners.push(cb);
          return { data: { subscription: { unsubscribe: function () {
            listeners = listeners.filter(function (x) { return x !== cb; });
          } } } };
        },
      },
    };
    return client;
  }

  window.supabase = { createClient: createClient };

  /* For local-links.js: the one thing this backend can do that Supabase's
   * could not — hand Kat a sign-in link to send herself. */
  window.KT_STUDIO = {
    base: BASE,
    signInLink: async function (artistId) {
      var s = current();
      return call('POST', '/auth/v1/link',
        { artist_id: artistId, redirect_to: window.location.origin + window.location.pathname },
        s && s.access_token);
    },
  };
})();
