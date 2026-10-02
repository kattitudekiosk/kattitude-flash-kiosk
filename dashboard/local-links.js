/* Kattitude Flash Dashboard — sign-in links (studio server only)
 *
 * On the studio server there is no email, so this is how anyone gets in:
 * Kat picks an artist, gets a link, and sends it however she already talks to
 * them. One card at the top of the Artists tab. Injected by server/server.js
 * at the end of the page; never loaded on Vercel/Supabase.
 *
 * A bolt-on, like tag-ui.js and view-as.js: it watches #view-artists and adds
 * its card after artists-tab.js renders, so neither app.js nor artists-tab.js
 * knows it exists.
 *
 * The link is shown once and never stored here. Making a new link for the
 * same artist cancels the previous unused one (server/auth.js), so a link
 * sent to the wrong number can be killed by making another.
 */
(function () {
  'use strict';

  if (!window.KT_STUDIO) return;   // not on the studio server

  var pane = document.getElementById('view-artists');
  if (!pane) return;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  async function artists() {
    var sb = window.supabase.createClient();
    var r = await sb.from('artists').select('id,name,active,auth_user_id').order('display_order');
    return r.data || [];
  }

  function linksCard() {
    var card = el('div', 'card');
    card.id = 'kt-signin-links';
    card.appendChild(el('h2', null, 'Sign-in links'));
    card.appendChild(el('p', 'muted',
      'Pick someone and send them their link — text, DM, AirDrop, whatever you ' +
      'already use. Opening it signs their phone in. Each link works once, for ' +
      '7 days. Making a new one cancels the last.'));

    var row = el('div', 'row');
    var pick = el('select', 'input');
    pick.appendChild(el('option', null, 'Choose an artist…')).value = '';
    var make = el('button', 'btn btn-primary', 'Make link');
    row.append(pick, make);
    card.appendChild(row);

    var out = el('div', 'row');
    out.style.display = 'none';   // not .hidden: the dashboard's .row { display:flex } beats it
    var field = el('input', 'input');
    field.readOnly = true;
    field.style.flex = '1 1 100%';
    /* The dashboard renders typed input in caps. A link is case-sensitive:
     * shown in caps, anyone retyping it gets a dead link. */
    field.style.textTransform = 'none';
    var copy = el('button', 'btn btn-quiet', 'Copy');
    var share = el('button', 'btn btn-quiet', 'Send…');
    share.hidden = !navigator.share;
    out.append(field, copy, share);
    card.appendChild(out);
    var note = el('p', 'muted small');
    card.appendChild(note);

    artists().then(function (list) {
      list.filter(function (a) { return a.active; }).forEach(function (a) {
        var o = el('option', null, a.name + (a.auth_user_id ? '' : ' — not signed in yet'));
        o.value = a.id;
        pick.appendChild(o);
      });
    });

    var who = '';
    make.onclick = async function () {
      if (!pick.value) { note.textContent = 'Choose an artist first.'; return; }
      make.disabled = true;
      note.textContent = 'Making…';
      var r = await window.KT_STUDIO.signInLink(pick.value);
      make.disabled = false;
      if (r.error) { note.textContent = r.error.message; out.style.display = 'none'; return; }
      who = r.data.artist;
      field.value = r.data.url;
      out.style.display = '';
      note.textContent = 'Link for ' + who + '. Works once, until ' +
        new Date(r.data.expires_at).toLocaleDateString() + '.';
    };
    copy.onclick = async function () {
      try { await navigator.clipboard.writeText(field.value); copy.textContent = 'Copied'; }
      catch (e) { field.select(); copy.textContent = 'Select + copy'; }
      setTimeout(function () { copy.textContent = 'Copy'; }, 2000);
    };
    share.onclick = function () {
      navigator.share({ title: 'Kattitude dashboard',
                        text: 'Hi ' + who + ' — your Kattitude flash dashboard sign-in link:',
                        url: field.value }).catch(function () {});
    };
    return card;
  }

  /* ── COPY THAT PROMISES EMAIL ──────────────────────────────────────────
   * Four places tell people a link will be emailed: the sign-in screen, the
   * Artists intro, each artist card's hint, and one tutorial step. On the
   * studio server none of that is true, and CLAUDE.md is plain that copy
   * teaching a rule that no longer holds is a defect, not a nicety. Rewritten
   * here, matched on the sentence itself, so the Supabase build keeps its
   * own copy untouched. */
  var REWRITES = [
    [/until custom SMTP is switched on/,
     'This studio server does not send email. Use Sign-in links below to get someone in.'],
    [/tapping Update changes both saves the card and sends/,
     'Add someone, or open a card below and edit it. To get someone signed in, ' +
     'make them a link under Sign-in links.'],
    [/^(Changing the email sends a fresh sign-in link|Adding an email sends them a sign-in link)/,
     'The email is kept on the card for your records. To sign them in, use Sign-in links at the top.'],
    [/^Email \(this is also their sign-in\)$/, 'Email (for your records)'],
  ];

  function rewrite(root) {
    Array.prototype.forEach.call(root.querySelectorAll('p, div.muted, span.muted'), function (p) {
      if (p.children.length) return;
      REWRITES.forEach(function (r) { if (r[0].test(p.textContent.trim())) p.textContent = r[1]; });
    });
  }

  /* The sign-in screen. Its email box and button cannot do anything here, so
   * they go, and the copy says what does work. #signinMsg stays: it is where
   * local-backend.js reports a link that has expired or was already used. */
  function fixSignin() {
    var s = document.getElementById('signin');
    if (!s || s.dataset.ktLocal) return;
    var btn = document.getElementById('sendLink');
    var email = document.getElementById('email');
    var label = s.querySelector('label[for="email"]');
    if (!btn || !email) return;
    s.dataset.ktLocal = '1';
    [btn, email, label].forEach(function (x) { if (x) x.hidden = true; });
    var ps = s.querySelectorAll('.signin-card > p.muted');
    if (ps[0]) ps[0].textContent = 'Kat sends you a sign-in link. Open it on this phone and you are in — ' +
      'no password, and no email needed.';
    if (ps[1]) ps[1].textContent = 'Each link works once, for 7 days. Lost it, or it says expired? ' +
      'Ask Kat for a new one.';
  }

  function fixTour() {
    var all = window.Tour && window.Tour._steps;
    if (!all) return;
    Object.keys(all).forEach(function (k) {
      if (!Array.isArray(all[k])) return;   // _steps also carries non-list entries
      all[k].forEach(function (st) {
        if (st.id === 'artists-invite') {
          st.title = 'Getting someone signed in';
          st.body = 'There is no email on this studio server. Make them a link under ' +
            'Sign-in links and send it however you like — opening it signs their phone in.';
        }
      });
    });
  }

  function place() {
    if (pane.hidden || !pane.firstChild) return;
    rewrite(pane);
    if (document.getElementById('kt-signin-links')) return;
    pane.insertBefore(linksCard(), pane.firstChild.nextSibling);
  }

  /* Each fix stands alone: a change in tour.js must not cost Kat the
   * Sign-in links card, which is the only way anybody gets in. */
  [fixSignin, fixTour].forEach(function (fn) {
    try { fn(); } catch (e) { console.error('[local-links]', fn.name, e); }
  });
  new MutationObserver(place).observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
})();
