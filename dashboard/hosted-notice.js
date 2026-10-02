/* Kattitude Flash Dashboard — the hosted copy no longer writes to Supabase
 *
 * WHY (2 Oct 2026). The wall now reads the studio server on the Mac mini.
 * This same dashboard, opened from Vercel, still talked to Supabase — so an
 * artist could upload there, see "uploaded", and the work would never reach
 * the wall. Two backends, one of them invisible: a split brain. Joshua found
 * it when Naomi asked where her designs were.
 *
 * Served BY the studio server, local-backend.js has already loaded (it is
 * injected right after config.js) and this file does nothing. Served from
 * anywhere else:
 *   - DASH_CONFIG.studioServerUrl set → go there, keeping any sign-in link.
 *   - not set → no Supabase at all. Every call answers with a plain message
 *     saying where the dashboard is now, so nothing can be saved to a place
 *     the wall does not read.
 */
(function () {
  'use strict';
  var cfg = window.DASH_CONFIG || {};
  if (cfg.backend === 'studio-server') return;   // the real thing; nothing to do

  if (cfg.studioServerUrl) {
    window.location.replace(cfg.studioServerUrl.replace(/\/+$/, '') + '/dashboard/' + window.location.hash);
    return;
  }

  var MSG = 'The flash dashboard has moved to the studio’s own server. ' +
    'Nothing can be saved here. Ask Kat for your new sign-in link.';
  var err = { message: MSG, code: 'moved' };

  function q() {
    var self = {};
    ['select', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'match', 'order', 'limit',
     'range', 'insert', 'update', 'delete', 'upsert', 'single', 'maybeSingle', 'filter',
     'contains', 'like', 'ilike'].forEach(function (m) { self[m] = function () { return self; }; });
    self.then = function (ok, bad) { return Promise.resolve({ data: null, error: err }).then(ok, bad); };
    return self;
  }
  var client = {
    from: q,
    rpc: function () { return Promise.resolve({ data: null, error: err }); },
    storage: { from: function () { return {
      upload: function () { return Promise.resolve({ data: null, error: err }); },
      list: function () { return Promise.resolve({ data: [], error: err }); },
      remove: function () { return Promise.resolve({ data: null, error: err }); },
      getPublicUrl: function () { return { data: { publicUrl: '' } }; },
    }; } },
    channel: function () { var c = { on: function () { return c; }, subscribe: function () { return c; } }; return c; },
    removeChannel: function () {},
    auth: {
      getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
      getUser: function () { return Promise.resolve({ data: { user: null }, error: err }); },
      setSession: function () { return Promise.resolve({ data: { session: null }, error: err }); },
      signInWithOtp: function () { return Promise.resolve({ data: null, error: err }); },
      signOut: function () { return Promise.resolve({ error: null }); },
      onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    },
  };
  window.supabase = { createClient: function () { return client; } };

  /* Say it on the sign-in card too, before anyone types an email. */
  document.addEventListener('DOMContentLoaded', function () {
    var card = document.querySelector('#signin .signin-card');
    if (!card) return;
    var p = document.createElement('p');
    p.className = 'msg';
    p.id = 'hostedMoved';
    p.textContent = MSG;
    card.insertBefore(p, card.children[1] || null);
    ['email', 'sendLink'].forEach(function (id) { var e = document.getElementById(id); if (e) e.hidden = true; });
    var l = card.querySelector('label[for="email"]'); if (l) l.hidden = true;
    /* The email copy below the notice promises a link that will not come. */
    Array.prototype.forEach.call(card.querySelectorAll('p.muted'), function (x) { x.hidden = true; });
    /* Nothing behind this card works here, so do not show its tabs. */
    var st = document.createElement('style');
    st.textContent = '#topbar, #tabs, #howThisWorks { display: none !important; }';
    document.head.appendChild(st);
  });
})();
