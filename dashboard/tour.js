/* Guided tutorial — one script per role.
 *
 * Joshua's ask, verbatim: "make a tutorial for each user, for the admin
 * users, and then make a tutorial for the artist. Give them a way to learn
 * how to navigate the site... use thought bubbles or whatever."
 *
 * So: speech bubbles pinned to real controls, in order, with Next / Back /
 * Skip. Not a video, not a docs page — the thing being explained is on
 * screen while it is explained.
 *
 * FIVE RULES THIS FILE KEEPS
 *
 * 1. It never blocks the app. The veil is pointer-events:none and the tour
 *    can be dismissed with Escape, the Skip button, or by ignoring it.
 * 2. It never traps focus. Tab still walks the page. We move focus to the
 *    bubble when a step opens so a keyboard user is not lost, and that is
 *    the whole of the focus handling.
 * 3. A missing target is skipped, not fatal. Steps point at real elements,
 *    and elements come and go — an empty Requests queue has no cards. A step
 *    whose anchor is absent is dropped silently and the tour continues.
 * 4. Completion lives in the DATABASE (artists.tutorial_seen_at), not
 *    localStorage. An artist who does the tour on her phone should not get
 *    it again on the shop iPad, and Kat needs to be able to clear it for
 *    someone who asks for a refresher.
 * 5. The copy is short and plain. These are tattoo artists on phones. No
 *    "row-level security", no "derivative", no "canonical key".
 */
window.Tour = (function () {
  'use strict';

  /* ── Scripts ───────────────────────────────────────────────────────────
   * `view` switches tab first (by clicking the real tab button, which is
   * what a person would do). `sel` is the element the bubble points at.
   * `optional` marks a step whose anchor may legitimately not exist. */

  const ARTIST_STEPS = [
    {
      view: 'upload', sel: '#view-upload .dropzone',
      title: 'Start here',
      body: 'Tap to pick your flash, or drag files in. You can add a whole ' +
            'batch at once — you do not have to do them one at a time.',
    },
    {
      view: 'upload', sel: '#view-upload > .card',
      title: 'Sizes are strict',
      body: 'A single design has to be 2048×2048. A full sheet has to be ' +
            '2160×3840. Anything else is refused with the size it needs. ' +
            'We will not resize or crop your art to make it fit — that is ' +
            'your drawing, not ours to cut into.',
    },
    {
      view: 'upload', sel: '#view-upload .req-panel',
      title: 'Tag your work',
      body: 'Categories are how a customer finds you. Tap the chips on a file ' +
            'to tag it, or tag the whole batch in one go from the top.',
    },
    {
      view: 'upload', sel: '#view-upload .req-panel .input',
      title: 'Missing a category?',
      body: 'Type what you want here and send it. Kat says yes or points you ' +
            'at one we already have, so the shop does not end up with three ' +
            'spellings of the same thing.',
    },
    {
      view: 'designs', sel: '#view-designs',
      title: 'A design needs a category',
      body: 'Nothing goes on the kiosk untagged. If you are not ready to tag ' +
            'something, save it as a draft — drafts are private and you ' +
            'can publish them later.',
    },
    {
      view: 'designs', sel: '.tab[data-view="designs"]',
      title: 'Your work lives here',
      body: 'Everything you have uploaded. Publish, unpublish, reorder, or ' +
            'delete it from this tab.',
    },
    {
      sel: '#myAvatar',
      title: 'Your photo',
      body: 'Tap your circle to change your headshot. This is the picture ' +
            'customers see next to your flash on the wall.',
    },
    {
      sel: '#howThisWorks',
      title: 'Lost? Tap this',
      body: 'This walkthrough is always here. Nothing to remember.',
    },
  ];

  const ADMIN_STEPS = [
    {
      view: 'artists', sel: '#view-artists > .card:first-child',
      title: 'Adding an artist',
      body: 'Name, handle, email. That is the whole of it.',
    },
    {
      view: 'artists', sel: '#view-artists > .card:first-child .btn',
      title: 'Saving an email sends their link',
      body: 'There is no separate invite button. Put an email on a card and ' +
            'save it, and that person gets their sign-in link. Changing an ' +
            'email sends a fresh one; saving anything else does not.',
    },
    {
      view: 'artists', sel: '#view-artists .avatar-btn', optional: true,
      title: 'You can set anyone’s photo',
      body: 'Tap an artist’s circle to upload a headshot for them. ' +
            'Handy when someone has not got round to it.',
    },
    {
      view: 'requests', sel: '#view-requests .req-item', optional: true,
      title: 'Category requests',
      body: 'Approve to create it. Merge if they meant one we already have. ' +
            'Reject with a note so they know why. The “did you mean” ' +
            'suggestions are guesses about spelling — similar is not the ' +
            'same, so nothing merges on its own.',
    },
    {
      view: 'requests', sel: '#view-requests .req-actions select', optional: true,
      title: 'What “kind” means',
      body: 'Style is how it is drawn — fine line, blackwork. Theme is the ' +
            'mood — summertime, Texas. Subject is what it shows — ' +
            'snakes, roses. A design can be all three.',
    },
    {
      view: 'review', sel: '#view-review',
      title: 'The approval queue',
      body: 'Anything waiting on your yes lands here. Right now artists ' +
            'publish straight to the kiosk, so this is usually empty — ' +
            'it is here for the day you want to check work first.',
    },
  ];

  /* ── Engine ─────────────────────────────────────────────────────────── */

  let steps = [];
  let i = 0;
  let ui = null;
  let me = null;          // the artists row of whoever is running it
  let running = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function target(step) {
    if (!step.sel) return null;
    try { return document.querySelector(step.sel); }
    catch (e) { return null; }
  }

  function switchView(view) {
    if (!view) return;
    const tab = document.querySelector('.tab[data-view="' + view + '"]');
    // Hidden means this role does not have the tab; the step is dropped by
    // the caller when its anchor then fails to resolve.
    if (tab && !tab.hidden) tab.click();
  }

  function build() {
    const veil = el('div', 'tour-veil');
    const spot = el('div', 'tour-spot');
    const bubble = el('div', 'tour-bubble');
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-live', 'polite');
    bubble.setAttribute('aria-label', 'How this works');
    bubble.tabIndex = -1;

    document.body.append(veil, spot, bubble);
    return { veil, spot, bubble };
  }

  function place(node, rect) {
    const pad = 12;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const h = node.offsetHeight || 180;
    const w = node.offsetWidth || 320;

    const room = vh - (rect.bottom + pad);
    const below = room > h || rect.top < h + pad;

    const top = below ? rect.bottom + pad + window.scrollY
                      : rect.top - h - pad + window.scrollY;
    let left = rect.left + window.scrollX;
    left = Math.max(12, Math.min(left, vw - w - 12));

    node.style.top = Math.max(12 + window.scrollY, top) + 'px';
    node.style.left = left + 'px';
    node.classList.toggle('is-below', below);
    node.classList.toggle('is-above', !below);

    // Point the tail at the element, not at the corner of the bubble.
    const tail = Math.max(14, Math.min(rect.left + rect.width / 2 - left - 10, w - 30));
    node.style.setProperty('--tail', tail + 'px');
  }

  function render() {
    if (!running) return;

    // Drop steps whose anchor is gone rather than showing a bubble pointing
    // at nothing. This is what stops an empty Requests queue from stalling
    // the whole tour.
    while (i < steps.length) {
      const s = steps[i];
      switchView(s.view);
      if (target(s)) break;
      i++;
    }
    if (i >= steps.length) { finish(true); return; }

    const step = steps[i];
    const node = target(step);
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });

    // One frame for the smooth scroll to settle before measuring.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!running) return;
      const r = node.getBoundingClientRect();

      ui.spot.style.top = (r.top + window.scrollY) + 'px';
      ui.spot.style.left = (r.left + window.scrollX) + 'px';
      ui.spot.style.width = r.width + 'px';
      ui.spot.style.height = r.height + 'px';

      ui.bubble.innerHTML = '';
      ui.bubble.appendChild(el('div', 'tour-step',
        'Step ' + (i + 1) + ' of ' + steps.length));
      ui.bubble.appendChild(el('div', 'tour-title', step.title));
      ui.bubble.appendChild(el('p', 'tour-body', step.body));

      const actions = el('div', 'tour-actions');
      if (i > 0) {
        const back = el('button', 'btn btn-quiet', 'Back');
        back.onclick = () => { i--; render(); };
        actions.appendChild(back);
      }
      const skip = el('button', 'btn btn-quiet', 'Skip');
      skip.onclick = () => finish(false);
      actions.appendChild(skip);
      actions.appendChild(el('span', 'tour-spacer'));

      const next = el('button', 'btn btn-primary',
        i === steps.length - 1 ? 'Done' : 'Next');
      next.onclick = () => {
        if (i === steps.length - 1) return finish(true);
        i++; render();
      };
      actions.appendChild(next);
      ui.bubble.appendChild(actions);

      place(ui.bubble, r);
      next.focus();
    }));
  }

  function onKey(e) {
    if (!running) return;
    if (e.key === 'Escape') { finish(false); return; }
    // Arrow keys only when focus is inside the bubble, so they do not fight
    // the app's own controls.
    if (!ui.bubble.contains(document.activeElement)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (i < steps.length - 1) { i++; render(); } else finish(true); }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); i--; render(); }
  }

  let reflow = null;
  function onReflow() {
    clearTimeout(reflow);
    reflow = setTimeout(() => { if (running) render(); }, 120);
  }

  async function markSeen() {
    // Best effort. Failing to record it means someone sees the tour twice,
    // which is a nuisance; throwing here would break the Done button, which
    // is worse.
    try {
      if (!me || !me.id) return;
      const sb = await window.DashClient.client();
      if (!sb) return;
      await sb.from('artists')
        .update({ tutorial_seen_at: new Date().toISOString() })
        .eq('id', me.id);
      me.tutorial_seen_at = new Date().toISOString();
    } catch (e) { console.warn('tour: could not record completion', e); }
  }

  function finish(completed) {
    if (!running) return;
    running = false;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    if (ui) { ui.veil.remove(); ui.spot.remove(); ui.bubble.remove(); ui = null; }
    // Skipping still counts. Someone who skipped can replay from the
    // permanent link, and re-ambushing them every sign-in is not teaching.
    markSeen();
    if (completed) { /* nothing else to do */ }
  }

  /**
   * Run the tour.
   * @param opts.artist  the artists row (needs id, role, name)
   */
  function start(opts) {
    const artist = (opts && opts.artist) || me;
    if (!artist) return;
    me = artist;

    const isAdmin = artist.role === 'admin';
    // Admins get the artist tour too — they upload their own flash like
    // everyone else, and Kat is the studio's busiest artist.
    steps = isAdmin ? ARTIST_STEPS.concat(ADMIN_STEPS) : ARTIST_STEPS.slice();

    if (running) finish(false);
    i = 0;
    running = true;
    ui = build();
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    render();
  }

  /** Called once the dashboard has signed someone in. */
  function attach(artist) {
    me = artist;
    const launch = document.getElementById('howThisWorks');
    if (launch) {
      launch.hidden = false;
      launch.onclick = () => start({ artist: me });
    }
    // First sign-in: run it unprompted. Anyone who has seen it (or skipped
    // it) is left alone.
    if (!artist.tutorial_seen_at) {
      setTimeout(() => start({ artist: me }), 700);
    }
  }

  return {
    start, attach, finish,
    _steps: { artist: ARTIST_STEPS, admin: ADMIN_STEPS },
  };
})();

/* ── Self-wiring ─────────────────────────────────────────────────────────
 * app.js is deliberately untouched by this feature: it is the file with the
 * most to lose and the least to gain from being edited. Instead this watches
 * for the dashboard signing someone in (the top bar unhides), then reads the
 * artist row itself.
 *
 * The cost of that choice is honest: this is a DOM observation rather than a
 * function call, so if #topbar is ever renamed the tour stops appearing. It
 * fails by doing nothing, which is the right direction to fail in.
 */
(function () {
  'use strict';

  const bar = document.getElementById('topbar');
  if (!bar) return;

  let done = false;

  async function ready() {
    if (done || bar.hidden) return;
    done = true;
    obs.disconnect();
    try {
      const sb = await window.DashClient.client();
      if (!sb) return;
      const { data: session } = await sb.auth.getUser();
      if (!session || !session.user) return;
      const { data, error } = await sb.from('artists')
        .select('id, name, role, tutorial_seen_at, portrait_url, portrait_thumb_url')
        .eq('auth_user_id', session.user.id).maybeSingle();
      if (error || !data) return;
      window.Tour.attach(data);
      if (window.MyAvatar) window.MyAvatar.attach(data);
    } catch (e) { console.warn('tour: could not start', e); }
  }

  const obs = new MutationObserver(ready);
  obs.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  ready();
})();
