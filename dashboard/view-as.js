/* View as artist — an admin's preview of the artist dashboard.
 *
 * Joshua's ask: "give me a way to toggle that on the dashboard. The first time
 * I go through, I'll do the admin tutorial... then I'll switch over to the
 * artist tab, and then I can see what the artist sees when they see a
 * tutorial."
 *
 * IT IS A VIEW, NOT A ROLE. Nothing here touches the database and nothing here
 * takes a permission away. The row still says admin, is_admin() still returns
 * true, and RLS would still let this session do every admin thing if it asked.
 * All this does is hide the admin tabs and hand the tour the artist script, so
 * Kat can SEE what an artist sees. Anyone tempted to use it as a security
 * boundary should stop: it is a mirror, not a wall.
 *
 * WHY THE TOUR NEEDS NO CHANGES: tour.js picks its script from `artist.role`.
 * Passing it a shallow copy of the row with role forced to 'artist' is all it
 * takes to get the artist walkthrough — same engine, same ids, same
 * progress-recording against the same real row.
 *
 * SELF-WIRING, like tour.js and flash-sales.js. app.js gains nothing.
 */
window.ViewAs = (function () {
  'use strict';

  var KEY = 'kt-view-as-artist';
  var me = null;             // the real artists row
  var asArtist = false;
  var btn = null;

  function isAdmin() { return !!(me && me.role === 'admin'); }

  function stored() {
    try { return window.localStorage.getItem(KEY) === '1'; }
    catch (e) { return false; }
  }
  function store(v) {
    try { window.localStorage.setItem(KEY, v ? '1' : '0'); } catch (e) { /* private mode */ }
  }

  /* The row the tour should think it is talking to. Same id, so completion is
   * still recorded against Joshua's own row rather than a phantom. */
  function tourSubject() {
    if (!me) return null;
    if (!asArtist) return me;
    var copy = {};
    Object.keys(me).forEach(function (k) { copy[k] = me[k]; });
    copy.role = 'artist';
    return copy;
  }

  function adminTabs() {
    return Array.prototype.slice.call(document.querySelectorAll('.tab.admin-only'));
  }

  function paintButton() {
    if (!btn) return;
    btn.hidden = !isAdmin();
    btn.textContent = asArtist ? 'Back to admin view' : 'View as artist';
    btn.setAttribute('aria-pressed', asArtist ? 'true' : 'false');
    btn.classList.toggle('is-on', asArtist);
  }

  /* Admin tabs go away in artist view and come back out of it. Only ever
   * touches tabs app.js already decided this person may see — a non-admin has
   * them hidden and this file never unhides them, because isAdmin() gates the
   * button's existence in the first place. */
  function applyTabs() {
    if (!isAdmin()) return;
    adminTabs().forEach(function (t) { t.hidden = asArtist; });

    // Standing on a tab that just disappeared is a dead end, so step back to
    // the one every role has.
    if (asArtist) {
      var active = document.querySelector('.tab.is-active');
      if (active && active.classList.contains('admin-only')) {
        var upload = document.querySelector('.tab[data-view="upload"]');
        if (upload) upload.click();
      }
    }
  }

  /* The "?" is contextual, and in artist view it has to answer as the artist
   * script rather than the admin one. Rebinding it here rather than teaching
   * tour.js about view modes keeps that concept out of the tour entirely. */
  function bindHelp() {
    var q = document.getElementById('howThisWorks');
    if (!q) return;
    q.onclick = function () {
      window.Tour.start({ artist: tourSubject(), mode: 'tab' });
    };
  }

  function set(next, opts) {
    asArtist = !!next;
    store(asArtist);
    paintButton();
    applyTabs();
    bindHelp();

    if (opts && opts.announce) {
      var t = document.getElementById('toast');
      if (t) {
        t.textContent = asArtist
          ? 'Showing what an artist sees. Tap the ? for their walkthrough.'
          : 'Back to the admin view.';
        t.className = 'toast';
        t.hidden = false;
        clearTimeout(set._t);
        set._t = setTimeout(function () { t.hidden = true; }, 4000);
      }
    }
  }

  function build() {
    var who = document.querySelector('#topbar .who');
    if (!who) return;
    btn = document.createElement('button');
    btn.id = 'viewAs';
    btn.type = 'button';
    btn.className = 'btn btn-quiet viewas';
    btn.hidden = true;
    btn.onclick = function () { set(!asArtist, { announce: true }); };
    // Before Sign out, so the destructive control stays last.
    var out = document.getElementById('signOut');
    if (out) who.insertBefore(btn, out); else who.appendChild(btn);
  }

  /** Called once the dashboard has signed someone in. */
  function attach(artist) {
    me = artist;
    if (!btn) build();
    // Restore the last mode, but never leave a non-admin in a state they
    // could not have chosen.
    asArtist = isAdmin() ? stored() : false;
    paintButton();
    applyTabs();
    bindHelp();
  }

  return {
    attach, set,
    isArtistView: function () { return asArtist; },
    subject: tourSubject,
  };
})();

/* Self-wiring: wait for the dashboard to sign somebody in, same trick tour.js
 * uses — with one difference learned the hard way.
 *
 * IT MUST NOT GIVE UP. The first version set done = true and disconnected the
 * observer BEFORE awaiting the session, so if localStorage did not have it yet
 * — which is exactly what happens while app.js is still exchanging a magic
 * link — this returned and never ran again. The visible result was a signed-in
 * dashboard with no name, no role pill, no avatar and no admin tabs, because
 * every self-wiring module bailed at the same instant for the same reason.
 *
 * So: only mark done once a row is actually in hand, and keep retrying on a
 * short timer until then. Bounded, so a genuinely signed-out page stops.
 */
(function () {
  'use strict';

  var bar = document.getElementById('topbar');
  if (!bar) return;

  var done = false;
  var tries = 0;
  var MAX = 40;            // ~10s at 250ms, then stop asking

  async function attempt() {
    if (done) return true;
    if (bar.hidden) return false;
    try {
      var sb = await window.DashClient.client();
      if (!sb) return false;
      var got = await sb.auth.getUser();
      var user = got && got.data && got.data.user;
      if (!user) return false;
      var res = await sb.from('artists')
        .select('id, name, role, tutorial_seen, tutorial_seen_at')
        .eq('auth_user_id', user.id).maybeSingle();
      if (res.error || !res.data) return false;

      done = true;
      window.ViewAs.attach(res.data);

      /* app.js has a race of its own: getSession() can resolve before the
       * magic-link token is exchanged, take its signed-OUT branch, and unhide
       * the sign-in card on top of a dashboard you are already inside. By the
       * time we get here a row is in hand, so that card is provably wrong. */
      var signin = document.getElementById('signin');
      if (signin && !signin.hidden) signin.hidden = true;

      return true;
    } catch (e) {
      console.warn('view-as: could not start', e);
      return false;
    }
  }

  function poll() {
    attempt().then(function (ok) {
      if (ok || ++tries >= MAX) return;
      setTimeout(poll, 250);
    });
  }

  var obs = new MutationObserver(function () { poll(); });
  obs.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  poll();
})();
