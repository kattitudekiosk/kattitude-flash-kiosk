/* Kattitude Flash Dashboard — DEMO BACKEND
 *
 * A complete in-memory stand-in for Supabase, so the real dashboard can be
 * handed to a stranger with a link and no account.
 *
 * WHY A FAKE BACKEND RATHER THAN A DEMO ACCOUNT
 * ---------------------------------------------
 * A demo account on the real project would need its credentials sitting in a
 * public page, and every button a visitor pressed would be a write against
 * the studio's live catalog. This file removes that entire class of risk by
 * removing the network: `window.supabase` is replaced before app.js ever
 * runs, so every query it makes is answered from the objects below. Nothing
 * leaves the tab. Refresh and the demo is new again.
 *
 * WHAT IS REAL AND WHAT IS NOT
 * ----------------------------
 * Joshua: "it's okay if we have names already generated... they have their
 * names and their Instagram handles, that's fine, but their actual QR codes,
 * I want those QR codes to work to go to the Instagram pages. I just don't
 * want any phone numbers or emails."
 *
 * So the roster is the real one, with real handles, because a QR code that
 * scans to a dead profile is worse than no QR code at all — and a prospect
 * scanning one is the demo's best moment.
 *
 * There is NO email and NO phone column on these rows. Not blanked, not
 * masked, not filled with a placeholder that might later be mistaken for
 * real: absent. The dashboard renders an empty contact field for each artist,
 * which is both the truth and a live demonstration of the invite flow.
 *
 * Bios are null because they are null in the real database. Inventing
 * biography for a named, findable person is a worse thing to publish than an
 * empty field.
 *
 * The artwork is the studio's own placeholder flash, already public on the
 * kiosk, which is what Joshua asked to populate this with.
 *
 * WHAT THIS DELIBERATELY DOES NOT IMPLEMENT: RLS. There is no server here to
 * enforce it and nothing real to protect. Roles still drive the UI — the demo
 * signs in as an admin, and "View as artist" still works — but that is a
 * presentation choice, not a security boundary. Never point this file at a
 * real project.
 */
(function () {
  'use strict';

  var SHEETS = 'https://kattitude-flash-kiosk.vercel.app/assets/sheets/';
  var ART = [
    SHEETS + 'IMG_1705.JPEG',
    SHEETS + 'IMG_2120.JPEG',
    SHEETS + 'Untitled_Artwork.JPEG',
    SHEETS + 'Untitled_Artwork_2_web.JPEG',
  ];

  var DEMO_USER_ID = 'demo-user-0000-0000-000000000001';

  var uid = (function () { var n = 0; return function (p) { n++; return (p || 'id') + '-' + n; }; })();
  var now = new Date('2026-08-06T09:00:00Z').getTime();
  function ago(days) { return new Date(now - days * 86400000).toISOString(); }
  function ahead(days) { return new Date(now + days * 86400000).toISOString(); }

  function monogram(name) {
    var ch = (name || '?').trim().charAt(0).toUpperCase();
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">' +
              '<rect width="512" height="512" fill="#0a0a0a"/>' +
              '<text x="256" y="256" fill="#ffffff" font-family="Inter,Helvetica,Arial" ' +
              'font-size="240" font-weight="700" text-anchor="middle" ' +
              'dominant-baseline="central">' + ch + '</text></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  /* ── Seed ──────────────────────────────────────────────────────────────
   * The real roster, real handles. See the header for why, and for what is
   * deliberately missing. The demo signs in as the studio owner. */
  function seed() {
    var artists = [
      { id: 'a-1', auth_user_id: DEMO_USER_ID, name: 'Kat', handle: '@Kattitudetattoo',
        role: 'admin', seniority: 'Studio Owner' },
      { id: 'a-2', auth_user_id: null, name: 'Barbie', handle: '@delicatelyscripted',
        role: 'artist', seniority: 'Senior Artist' },
      { id: 'a-3', auth_user_id: null, name: 'Miranda', handle: '@mirandaiink',
        role: 'artist', seniority: 'Junior Artist' },
      { id: 'a-4', auth_user_id: null, name: 'Jen', handle: '@inkedbyjemini',
        role: 'artist', seniority: 'Junior Artist' },
      { id: 'a-5', auth_user_id: null, name: 'Naomi', handle: '@Puratinta_26',
        role: 'artist', seniority: 'Junior Artist' },
      { id: 'a-6', auth_user_id: null, name: 'Ally', handle: '@allycat_ink',
        role: 'artist', seniority: 'Junior Artist' },
      { id: 'a-7', auth_user_id: null, name: 'Alena', handle: '@Alenanebotattoos',
        role: 'artist', seniority: 'Senior Artist' },
    ];
    artists.forEach(function (a, i) {
      a.active = true;
      a.kiosk_visible = true;
      a.display_order = i;
      /* The handle carries a leading @; the URL must not. */
      a.instagram_url = 'https://instagram.com/' + a.handle.replace(/^@/, '');
      a.bio = null;
      /* A generated monogram, not a photograph. Stock faces belong to real
       * people who did not agree to appear here, and a real artist's headshot
       * is exactly the personal data Joshua asked to keep out. An initial on
       * the studio's own black is honest about being a placeholder and still
       * fills the roster out. Inline SVG so it needs no network and no asset. */
      a.portrait_url = monogram(a.name);
      a.portrait_thumb_url = a.portrait_url;
      /* PER-TAB DISCOVERY, matching what the real studio rows now carry.
       *
       * Joshua: "I would rather people have to go to the thing. They'll see
       * those dots disappear as they work through and open those new areas
       * they haven't been to yet."
       *
       * Nothing is SEEN, so every tab that owes a step wears its dot — tour.js
       * computes dots from unseen and deliberately does not filter them by
       * snooze, "so a feature waved away still shows as waiting".
       *
       * seen_at is SET, which puts the first run in 'unseen' mode, where
       * dueNow() = unseen AND not snoozed. So only the Upload steps and the
       * avatar step are due on open; the rest wait behind their dots and teach
       * themselves when a tab is tapped, because 'new' mode deliberately
       * includes snoozed steps — "tapping the dot is asking for it".
       *
       * No code change was needed for any of this. tour.js already supported
       * it; nothing had ever set the opening state to use it. */
      a.tutorial_seen = [];
      a.tutorial_snoozed = [
        'designs-needs-category', 'designs-tab',
        'artists-add', 'artists-invite',
        'requests-review', 'requests-kind',
        'flashsales-create', 'flashsales-photos',
        'review-queue', 'help-button',
      ];
      a.tutorial_seen_at = new Date(now - 86400000).toISOString();
      a.created_at = ago(120 - i);
    });

    var cats = ['Traditional', 'Neo-Traditional', 'Blackwork', 'Fine Line', 'Floral',
                'Snakes', 'Daggers', 'Script', 'Summertime', 'Panther']
      .map(function (n, i) {
        return { id: 'c-' + (i + 1), name: n, slug: n.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
                 kind: i < 4 ? 'style' : 'subject', display_order: i, created_at: ago(100) };
      });

    var titles = ['Dagger & Rose', 'Coiled Viper', 'Wild Bloom', 'Panther Head',
                  'Swallow Pair', 'Nightshade', 'Anchor', 'Moth', 'Hand of Fate', 'Thorn Script'];
    var designs = titles.map(function (t, i) {
      return {
        id: 'd-' + (i + 1),
        /* Index 0 is the signed-in demo user. Including her in the rotation is
         * deliberate: "View as artist" is a view of YOUR OWN dashboard with the
         * admin tabs hidden, so if the signed-in row owns nothing, the artist
         * view a prospect is being shown is an empty state. */
        artist_id: artists[i % artists.length].id,
        title: t,
        type: i % 5 === 0 ? 'sheet' : 'design',
        image_url: ART[i % ART.length],
        thumb_url: ART[i % ART.length],
        width: i % 5 === 0 ? 2160 : 2048,
        height: i % 5 === 0 ? 3840 : 2048,
        published: i > 1,
        approved: i > 1,
        created_at: ago(30 - i),
      };
    });

    var design_categories = [];
    designs.forEach(function (d, i) {
      design_categories.push({ design_id: d.id, category_id: cats[i % cats.length].id });
      design_categories.push({ design_id: d.id, category_id: cats[(i + 4) % cats.length].id });
    });

    var sale = { id: 's-1', name: 'Friday the 13th', subtitle: 'One day only — walk-ins from noon',
                 starts_at: ahead(2), ends_at: ahead(3), published: true, created_at: ago(3) };

    return {
      artists: artists,
      categories: cats,
      designs: designs,
      design_categories: design_categories,
      category_requests: [
        { id: 'r-1', name: 'Summertime', kind: 'subject', status: 'pending',
          requested_by: 'a-3', created_at: ago(1) },
      ],
      category_request_queue: [
        { id: 'r-1', name: 'Summertime', kind: 'subject', status: 'pending',
          requested_by: 'a-3', artist_name: 'Miranda', created_at: ago(1) },
      ],
      flash_sales: [sale],
      flash_sale_tiers: [
        { id: 't-1', sale_id: 's-1', price_cents: 10000, label: 'Small', display_order: 0 },
        { id: 't-2', sale_id: 's-1', price_cents: 15000, label: 'Medium', display_order: 1 },
        { id: 't-3', sale_id: 's-1', price_cents: 25000, label: 'Large', display_order: 2 },
      ],
      flash_sale_media: [
        { id: 'm-1', sale_id: 's-1', url: ART[1], media_type: 'image', display_order: 0 },
      ],
      flash_sale_designs: [
        { sale_id: 's-1', design_id: 'd-3' },
        { sale_id: 's-1', design_id: 'd-5' },
      ],
    };
  }

  var DB = seed();

  /* Which column joins a child table back to its parent, for the embedded
   * selects PostgREST resolves server-side and we have to resolve here. */
  var FK = {
    design_categories: { parent: 'designs', key: 'design_id' },
    flash_sale_tiers: { parent: 'flash_sales', key: 'sale_id' },
    flash_sale_media: { parent: 'flash_sales', key: 'sale_id' },
    flash_sale_designs: { parent: 'flash_sales', key: 'sale_id' },
  };

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  /* "*, flash_sale_tiers(*), flash_sale_media(*)" → ['flash_sale_tiers', ...] */
  function embedsOf(sel) {
    var out = [], re = /([a-z_]+)\(([^)]*)\)/g, m;
    while ((m = re.exec(sel || ''))) out.push(m[1]);
    return out;
  }

  function attach(row, table, sel) {
    embedsOf(sel).forEach(function (child) {
      var fk = FK[child];
      if (!fk || fk.parent !== table) return;
      row[child] = (DB[child] || []).filter(function (r) { return r[fk.key] === row.id; }).map(clone);
    });
    return row;
  }

  function Query(table) {
    this.t = table; this.rows = null; this.sel = '*';
    this.filters = []; this.ord = null; this.one = false; this.mode = 'select';
    this.payload = null;
  }

  Query.prototype.select = function (sel) { this.sel = sel || '*'; return this; };
  Query.prototype.eq = function (col, val) { this.filters.push([col, val]); return this; };
  Query.prototype.order = function (col, opts) {
    this.ord = { col: col, asc: !(opts && opts.ascending === false) }; return this;
  };
  Query.prototype.limit = function (n) { this.lim = n; return this; };
  Query.prototype.single = function () { this.one = 'strict'; return this._run(); };
  Query.prototype.maybeSingle = function () { this.one = 'maybe'; return this._run(); };
  Query.prototype.insert = function (payload) { this.mode = 'insert'; this.payload = payload; return this; };
  Query.prototype.update = function (payload) { this.mode = 'update'; this.payload = payload; return this; };
  Query.prototype.delete = function () { this.mode = 'delete'; return this; };
  Query.prototype.then = function (res, rej) { return this._run().then(res, rej); };

  Query.prototype._match = function (r) {
    return this.filters.every(function (f) { return r[f[0]] === f[1]; });
  };

  /* ── Identity swap behind "View as artist" ─────────────────────────────
   * Joshua wanted the toggle to actually become an artist — Kat as admin,
   * Barbie as artist — rather than showing the owner's own dashboard with the
   * admin tabs hidden, which is all view-as.js does on its own.
   *
   * DEMO ONLY. It is done here, in the fake backend, precisely so that
   * view-as.js — which the studio depends on — is not touched.
   *
   * ROLE STAYS 'admin', AND THAT IS NOT A MISTAKE. view-as.js paints its own
   * button with `btn.hidden = !isAdmin()`, and isAdmin() reads this row's
   * role. Hand it an artist and the toggle hides itself the moment you use
   * it, with no way back short of clearing storage. So the row keeps the
   * admin role — which is what keeps the button on screen — and view-as.js
   * goes on forcing role:'artist' onto its own copy for the tour, exactly as
   * it does in production. Everything else about the identity is Barbie's,
   * including the id, which is what makes My Designs show her work. */
  var VIEW_AS_KEY = 'kt-view-as-artist';
  var ARTIST_PERSONA_ID = 'a-2';   // Barbie

  function viewingAsArtist() {
    try { return window.localStorage.getItem(VIEW_AS_KEY) === '1'; }
    catch (e) { return false; }
  }

  function personaFor(row) {
    if (!viewingAsArtist()) return row;
    var persona = null;
    (DB.artists || []).forEach(function (a) { if (a.id === ARTIST_PERSONA_ID) persona = a; });
    if (!persona) return row;
    var out = clone(persona);
    out.auth_user_id = row.auth_user_id;   // still the signed-in session
    out.role = 'admin';                    // see the note above — load-bearing
    return out;
  }

  Query.prototype._run = function () {
    var self = this;
    DB[this.t] = DB[this.t] || [];
    var table = DB[this.t];
    var out;

    if (this.mode === 'insert') {
      var items = Array.isArray(this.payload) ? this.payload : [this.payload];
      out = items.map(function (it) {
        var row = clone(it);
        if (!row.id) row.id = uid(self.t.slice(0, 2));
        if (!row.created_at) row.created_at = new Date().toISOString();
        table.push(row);
        return clone(row);
      });
    } else if (this.mode === 'update') {
      out = table.filter(function (r) { return self._match(r); }).map(function (r) {
        Object.keys(self.payload).forEach(function (k) { r[k] = self.payload[k]; });
        return clone(r);
      });
    } else if (this.mode === 'delete') {
      out = [];
      for (var i = table.length - 1; i >= 0; i--) {
        if (self._match(table[i])) out.push(clone(table.splice(i, 1)[0]));
      }
    } else {
      out = table.filter(function (r) { return self._match(r); })
                 .map(function (r) { return attach(clone(r), self.t, self.sel); });
      /* "Who am I" is the only query the persona applies to — an artists
       * lookup filtered by auth_user_id. The roster query is untouched, so the
       * Artists tab still lists everybody exactly once and Barbie does not
       * appear twice. */
      if (self.t === 'artists' &&
          self.filters.some(function (f) { return f[0] === 'auth_user_id'; })) {
        out = out.map(personaFor);
      }
      if (this.ord) {
        var c = this.ord.col, asc = this.ord.asc;
        out.sort(function (a, b) {
          var x = a[c], y = b[c];
          if (x === y) return 0;
          if (x === null || x === undefined) return 1;
          if (y === null || y === undefined) return -1;
          return (x > y ? 1 : -1) * (asc ? 1 : -1);
        });
      }
      if (this.lim) out = out.slice(0, this.lim);
    }

    if (this.one) {
      if (!out.length) {
        return Promise.resolve({
          data: null,
          error: this.one === 'strict' ? { message: 'No rows found', code: 'PGRST116' } : null,
        });
      }
      return Promise.resolve({ data: out[0], error: null });
    }
    return Promise.resolve({ data: out, error: null, count: out.length });
  };

  /* ── Storage ───────────────────────────────────────────────────────────
   * Uploads become object URLs, so an image a visitor picks really does
   * appear on the card they just made. They live only as long as the tab —
   * which is the correct lifetime for a demo, and is why the banner says so. */
  var FILES = Object.create(null);

  function bucket(name) {
    return {
      upload: function (path, file) {
        try { FILES[name + '/' + path] = URL.createObjectURL(file); }
        catch (e) { FILES[name + '/' + path] = ART[0]; }
        return Promise.resolve({ data: { path: path }, error: null });
      },
      getPublicUrl: function (path) {
        return { data: { publicUrl: FILES[name + '/' + path] || ART[0] } };
      },
      list: function (prefix) {
        var pre = name + '/' + (prefix || '');
        return Promise.resolve({
          data: Object.keys(FILES).filter(function (k) { return k.indexOf(pre) === 0; })
                      .map(function (k) { return { name: k.slice(pre.length + 1) }; }),
          error: null,
        });
      },
      remove: function (paths) {
        (paths || []).forEach(function (p) { delete FILES[name + '/' + p]; });
        return Promise.resolve({ data: [], error: null });
      },
    };
  }

  /* ── Auth ──────────────────────────────────────────────────────────────
   * Always signed in, as the studio owner. This is the whole point of the
   * demo: "they don't have to have the magic link". signInWithOtp is still
   * answered rather than removed, because the sign-in view is part of what a
   * client is being shown — it just never sends anything. */
  var SESSION = {
    access_token: 'demo', refresh_token: 'demo', expires_in: 3600,
    token_type: 'bearer',
    user: { id: DEMO_USER_ID, email: 'demo@demo.invalid', aud: 'authenticated', role: 'authenticated' },
  };

  /* Both restart paths clear the persona too. Starting a fresh demo halfway
   * into somebody else's identity would be a confusing first impression. */
  function clearPersona() {
    try { window.localStorage.removeItem(VIEW_AS_KEY); } catch (e) {}
  }

  var auth = {
    getSession: function () { return Promise.resolve({ data: { session: SESSION }, error: null }); },
    getUser: function () { return Promise.resolve({ data: { user: SESSION.user }, error: null }); },
    setSession: function () { return Promise.resolve({ data: { session: SESSION }, error: null }); },
    signInWithOtp: function () {
      return Promise.resolve({ data: {}, error: { message: 'This is a demo — you are already signed in.' } });
    },
    signOut: function () {
      /* Signing out of a demo means starting it over, not stranding somebody
       * on a login screen they cannot pass. */
      DB = seed();
      clearPersona();
      setTimeout(function () { window.location.reload(); }, 50);
      return Promise.resolve({ error: null });
    },
    onAuthStateChange: function (cb) {
      setTimeout(function () { try { cb('SIGNED_IN', SESSION); } catch (e) {} }, 0);
      return { data: { subscription: { unsubscribe: function () {} } } };
    },
  };

  function createClient() {
    return {
      from: function (t) { return new Query(t); },
      storage: { from: bucket },
      auth: auth,
      rpc: function () { return Promise.resolve({ data: null, error: null }); },
      channel: function () {
        var ch = { on: function () { return ch; }, subscribe: function () { return ch; },
                   unsubscribe: function () {} };
        return ch;
      },
      removeChannel: function () {},
    };
  }

  /* ── The session has to exist in localStorage too ────────────────────
   * Answering auth.getSession() is not enough. dash-client.js — which is how
   * tour.js, avatar.js and view-as.js reach the database — does NOT ask the
   * client for the session. It reads it straight out of localStorage:
   *
   *     const raw = key && window.localStorage.getItem(key);
   *     if (!raw) return null;
   *
   * With nothing there it returns null, and every caller is UI code that fails
   * quietly by design. That is why the demo opened with no walkthrough, no
   * avatar and no "View as artist": not an error anywhere, just three modules
   * deciding nobody was signed in. Writing the session here puts the demo
   * through the same code path the real app uses rather than around it.
   *
   * The key is derived exactly as dash-client.js derives it, from the same
   * config value, so the two cannot drift. DASH_CONFIG does not exist yet at
   * this point in the page — this file loads first, deliberately — so the ref
   * is taken from the URL the app is built against and asserted against
   * DASH_CONFIG on the next tick. */
  var PROJECT_REF = 'hnwyoglbmhvafxnzizqe';

  function writeSession() {
    try {
      window.localStorage.setItem(
        'sb-' + PROJECT_REF + '-auth-token',
        JSON.stringify({
          access_token: SESSION.access_token,
          refresh_token: SESSION.refresh_token,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: SESSION.user,
        })
      );
    } catch (e) { /* private browsing — the belt-and-braces below still holds */ }
  }
  writeSession();

  /* Belt and braces, and the reason is worth stating: if the project ref above
   * ever stops matching DASH_CONFIG, the key would be wrong and the tour would
   * go quiet again in exactly the same undebuggable way. dash-client.js has
   * already defined itself by the time this fires, so replacing it here is
   * safe, and it removes localStorage from the demo's critical path entirely.
   * Both mechanisms are kept: this one cannot fail, the one above keeps the
   * demo exercising the real code path. */
  document.addEventListener('DOMContentLoaded', function () {
    var real = window.DASH_CONFIG && window.DASH_CONFIG.supabaseUrl;
    if (real && real.indexOf(PROJECT_REF) === -1) {
      try { PROJECT_REF = new URL(real).hostname.split('.')[0]; writeSession(); } catch (e) {}
    }

    /* view-as.js flips its flag and re-paints in place — it never reloads,
     * because in production nothing about WHO you are has changed. Here it
     * has, and `me` was read once at sign-in, so without a reload the header
     * would still say Kat while the tabs behaved like Barbie's. Reloading is
     * the honest way to re-read identity, and it costs nothing: the demo's
     * whole database is rebuilt in a millisecond.
     *
     * Matched on the button's own text rather than an id or class, so a
     * change to view-as.js's markup cannot silently break this. */
    document.addEventListener('click', function (e) {
      var el = e.target && e.target.closest && e.target.closest('button');
      if (!el) return;
      var t = (el.textContent || '').trim().toLowerCase();
      if (t === 'view as artist' || t === 'back to admin view') {
        setTimeout(function () { window.location.reload(); }, 60);
      }
    }, true);

    var shared = createClient();
    window.DashClient = {
      client: function () { return Promise.resolve(shared); },
      raw: shared,
    };
  });

  window.supabase = { createClient: createClient };
  window.KATTITUDE_DEMO = {
    reset: function () { clearPersona(); DB = seed(); window.location.reload(); },
  };
})();
