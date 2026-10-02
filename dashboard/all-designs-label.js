/* Tab label: "My Designs" → "All Designs" for admins.
 *
 * WHY THIS EXISTS. The designs query has no artist filter:
 *
 *     sb.from('designs').select('*, design_categories(category_id)')
 *
 * RLS decides the rows. An artist gets their own; an admin gets every one in
 * the studio. So the "everyone's uploads" view Joshua asked for was already
 * built and already correct — it was only ever labelled wrong. The pane
 * heading has always said "All designs"; the tab said "My Designs", and the
 * tab is the part you read before deciding whether to tap.
 *
 * WHY IT WATCHES THE ROLE PILL. #whoRole is app.js's own rendering of admin
 * state, and view-as.js rewrites it when the toggle flips. Reading it means
 * this file cannot disagree with the app about who you are — there is no
 * second copy of that judgement to drift. Watching state.isAdmin directly
 * would need app.js to expose it, and watching the toggle would miss the
 * initial sign-in.
 *
 * IT ONLY EVER SETS TWO STRINGS. If the pill is missing, the tab is missing,
 * or the markup is renamed, this does nothing at all — the tab keeps whatever
 * label the HTML gave it and nothing breaks.
 */
(function () {
  'use strict';

  var ADMIN_LABEL = 'All Designs';
  var OWN_LABEL   = 'My Designs';

  function tab() { return document.querySelector('.tab[data-view="designs"]'); }
  function pill() { return document.getElementById('whoRole'); }

  /* "Admin" when acting as one. view-as.js writes "Viewing as artist" into
   * the same pill, which must read as NOT admin — in that mode the designs
   * list really is scoped to you, so "My Designs" is the honest word. */
  function isAdminNow() {
    var p = pill();
    if (!p) return false;
    return /admin/i.test(p.textContent || '') &&
           !/viewing as/i.test(p.textContent || '');
  }

  function apply() {
    var t = tab();
    if (!t) return;

    var want = isAdminNow() ? ADMIN_LABEL : OWN_LABEL;

    /* The tab may carry a count badge (paintRequestBadge does this for
     * Requests, and nothing stops Designs gaining one). Replace only the
     * text node so any child element survives. */
    var textNode = null;
    for (var i = 0; i < t.childNodes.length; i++) {
      if (t.childNodes[i].nodeType === 3) { textNode = t.childNodes[i]; break; }
    }

    if (textNode) {
      if (textNode.nodeValue !== want) textNode.nodeValue = want;
    } else if (t.textContent !== want) {
      t.textContent = want;
    }
  }

  function start() {
    apply();

    var p = pill();
    if (p) {
      /* characterData + subtree because the pill's text is what changes;
       * childList because view-as.js may replace the node wholesale. */
      new MutationObserver(apply).observe(p, {
        childList: true, characterData: true, subtree: true,
      });
    }

    /* The pill does not exist until sign-in unhides the top bar, so watch for
     * that too. Cheap: it fires on tab switches and stops mattering the
     * moment the label is already right, since apply() is idempotent. */
    var bar = document.getElementById('topbar');
    if (bar) {
      new MutationObserver(function () { apply(); start_pill_once(); })
        .observe(bar, { attributes: true, attributeFilter: ['hidden'] });
    }
  }

  var pillWatched = false;
  function start_pill_once() {
    if (pillWatched) return;
    var p = pill();
    if (!p) return;
    pillWatched = true;
    new MutationObserver(apply).observe(p, {
      childList: true, characterData: true, subtree: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
