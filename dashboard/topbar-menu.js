/* Top bar overflow menu.
 *
 * Joshua, looking at the header on his phone: "The header content here is not
 * rendering properly. It looks really messy... You need to fold them into a
 * menu."
 *
 * WHAT WENT WRONG. #topbar is a flex row of two things: the brand block and
 * .who. Neither had a min-width, and .who has been quietly growing — avatar,
 * name, role pill, Sign out, and now View as artist. On a 390px screen that
 * is more than the row can hold, so "View as artist" wrapped onto three
 * lines and "Sign out" ran off the right edge with no way to reach it. Every
 * future control added to the header would have made it worse.
 *
 * WHAT THIS DOES. Identity stays in the bar, because that is what a header is
 * for: photo, name, role. Every ACTION folds behind one "..." button that
 * opens a panel underneath. Adding a control to .who from now on costs the
 * header nothing — it lands in the panel and the bar stays the same width.
 *
 * IT MOVES REAL ELEMENTS, IT DOES NOT REBUILD THEM. Sign out keeps app.js's
 * handler, View as artist keeps view-as.js's; nothing here knows what any of
 * them do. That also means this file cannot break a control by getting its
 * behaviour wrong — it has no behaviour to get wrong.
 *
 * SELF-WIRING, like tour.js and view-as.js, and it OBSERVES rather than
 * assuming it runs last. view-as.js inserts its toggle after sign-in, which
 * is long after this file loads, so a one-shot sweep would leave that button
 * behind in the bar — the exact overflow this exists to stop. The observer
 * adopts anything that turns up later.
 */
window.TopbarMenu = (function () {
  'use strict';

  var who = null;
  var panel = null;
  var toggle = null;
  var open = false;

  /* A control belongs in the panel; the avatar, name and role pill do not.
   * Written as "is it a button that is not the avatar" rather than a list of
   * ids, so a control added next month is folded away without anybody having
   * to remember this file exists. */
  function isAction(el) {
    return el && el.nodeType === 1 &&
           el.tagName === 'BUTTON' &&
           el.id !== 'myAvatar' &&
           el.id !== 'whoMenuToggle';
  }

  function setOpen(next) {
    open = !!next;
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.classList.toggle('is-on', open);
  }

  /* Move one control into the panel. Idempotent: adopting something already
   * adopted is a no-op, which matters because the observer fires on every
   * mutation inside .who, including the ones this function causes. */
  function adopt(el) {
    if (!panel || !isAction(el)) return;
    if (el.parentNode === panel) return;
    panel.appendChild(el);
  }

  function sweep() {
    if (!who || !panel) return;
    Array.prototype.slice.call(who.children).forEach(adopt);
  }

  function build() {
    who = document.querySelector('#topbar .who');
    if (!who || panel) return;

    panel = document.createElement('div');
    panel.className = 'who-menu';
    panel.id = 'whoMenu';
    panel.hidden = true;

    toggle = document.createElement('button');
    toggle.id = 'whoMenuToggle';
    toggle.type = 'button';
    toggle.className = 'who-menu-toggle';
    toggle.setAttribute('aria-label', 'Account menu');
    toggle.setAttribute('aria-haspopup', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-controls', 'whoMenu');
    /* Three dots as three elements rather than a "..." character: a text
     * ellipsis inherits Inter's baseline and sits low in a 40px circle. */
    toggle.innerHTML = '<i></i><i></i><i></i>';
    toggle.onclick = function (e) {
      e.stopPropagation();
      setOpen(!open);
    };

    who.appendChild(toggle);
    who.appendChild(panel);
    sweep();

    /* Anything tapped inside the panel is a completed action — signing out,
     * switching view — so the panel has no reason to still be open behind
     * whatever happens next. */
    panel.addEventListener('click', function (e) {
      if (e.target.closest('button')) setOpen(false);
    });

    document.addEventListener('click', function (e) {
      if (!open) return;
      if (who.contains(e.target)) return;
      setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) { setOpen(false); toggle.focus(); }
    });

    /* The reason this is an observer and not a single call: view-as.js adds
     * its button whenever sign-in resolves, which can be seconds from now. */
    new MutationObserver(function () { sweep(); })
      .observe(who, { childList: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }

  return { adopt: adopt, close: function () { setOpen(false); }, _sweep: sweep };
})();
