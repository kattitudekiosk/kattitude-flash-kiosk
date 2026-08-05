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
 * SIX RULES THIS FILE KEEPS
 *
 * 1. EVERYONE gets it on their first sign-in — admin and artist alike, with
 *    no opt-in and nothing to click first. Admins get the artist walkthrough
 *    plus the admin one, because Kat uploads her own flash like everybody
 *    else and is the studio's busiest artist.
 * 2. It never blocks the app. The veil is pointer-events:none and the tour
 *    can be dismissed with Escape, the Skip button, or by ignoring it.
 * 3. It never traps focus. Tab still walks the page. We move focus to the
 *    bubble when a step opens so a keyboard user is not lost, and that is
 *    the whole of the focus handling.
 * 4. A missing target is skipped, not fatal. Steps point at real elements,
 *    and elements come and go — an empty Requests queue has no cards. A step
 *    whose anchor is absent is dropped silently and the tour continues.
 *    Because that can change the total, the count is computed from the steps
 *    that will ACTUALLY run, so "2 of 6" never turns out to be a lie.
 * 5. Completion lives in the DATABASE (artists.tutorial_seen_at), not
 *    localStorage. An artist who does the tour on her phone should not get
 *    it again on the shop iPad, and Kat needs to be able to clear it for
 *    someone who asks for a refresher.
 * 6. The copy is short and plain. These are tattoo artists on phones. No
 *    "row-level security", no "derivative", no "canonical key".
 *
 * NOTHING HERE SENDS EMAIL. The tour reads the roster and writes one
 * timestamp. It never calls signInWithOtp and never touches an artist's
 * email address, so running it — or replaying it — cannot invite anybody.
 *
 * THE BUBBLE MUST STAY REACHABLE. Three things below exist because it did
 * not, on the Artists tab, where the anchor is a card taller than a phone:
 *   - onReflow repositions but never re-renders, because render() scrolls
 *     and scrolling fires onReflow. That loop pinned the page in place and
 *     bounced the reader back every time they tried to scroll.
 *   - render() aligns a too-tall anchor to the top instead of centring it.
 *   - place() clamps the bubble inside the viewport no matter where the
 *     anchor ended up.
 * The bubble's buttons are the only way forward, so anything that can put
 * them off screen is a dead end, not a cosmetic flaw.
 */
window.Tour = (function () {
  'use strict';

  /* ── Scripts ───────────────────────────────────────────────────────────
   * `view` switches tab first (by clicking the real tab button, which is
   * what a person would do). `sel` is the element the bubble points at. */

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
            '2160×3840. Anything else is refused, and the message tells you ' +
            'the size it needs. We will not resize or crop your art to make ' +
            'it fit — that is your drawing, not ours to cut into.',
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
      view: 'artists', sel: '#view-artists .avatar-btn',
      title: 'You can set anyone’s photo',
      body: 'Tap an artist’s circle to upload a headshot for them. ' +
            'Handy when someone has not got round to it.',
    },
    {
      view: 'requests', sel: '#view-requests .req-item',
      title: 'Category requests',
      body: 'Approve to create it. Merge if they meant one we already have. ' +
            'Reject with a note so they know why. The “did you mean” ' +
            'suggestions are guesses about spelling — similar is not the ' +
            'same, so nothing merges on its own.',
    },
    {
      view: 'requests', sel: '#view-requests .req-actions select',
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

  const LAST_STEP = {
    sel: '#howThisWorks',
    title: 'Lost? Tap the question mark',
    body: 'It is always down here. One tap and this walkthrough starts again ' +
          'from the beginning. Nothing to remember.',
  };

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
    // Hidden means this role does not have the tab; the step is then dropped
    // when its anchor fails to resolve.
    if (tab && !tab.hidden) tab.click();
  }

  /* Walk the whole script once up front, visiting each tab, and keep only the
   * steps whose anchor actually exists right now.
   *
   * This is what makes "2 of 6" honest. Counting the authored steps instead
   * would promise six and deliver four the moment the Requests queue is
   * empty, and a progress indicator that lies is worse than none. */
  function resolve(script) {
    const kept = [];
    const startTab = document.querySelector('.tab.is-active');
    script.forEach(s => {
      switchView(s.view);
      if (target(s)) kept.push(s);
    });
    if (startTab) startTab.click();
    return kept;
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

    // Clamp into the viewport. An anchor taller than the screen puts its own
    // bottom edge below the fold, and a bubble pinned under it goes with it —
    // taking Next and Skip out of reach, which strands the reader on that
    // step. Being slightly detached from the anchor beats being unreachable.
    const minTop = 12 + window.scrollY;
    const maxTop = window.scrollY + vh - h - 12;
    node.style.top = Math.min(Math.max(minTop, top), Math.max(minTop, maxTop)) + 'px';
    node.style.left = left + 'px';
    node.classList.toggle('is-below', below);
    node.classList.toggle('is-above', !below);

    // Point the tail at the element, not at the corner of the bubble.
    const tail = Math.max(14, Math.min(rect.left + rect.width / 2 - left - 10, w - 30));
    node.style.setProperty('--tail', tail + 'px');
  }

  function progressRow() {
    const row = el('div', 'tour-progress');
    row.appendChild(el('span', 'tour-count', (i + 1) + ' of ' + steps.length));
    const dots = el('div', 'tour-dots');
    for (let n = 0; n < steps.length; n++) {
      dots.appendChild(el('span', 'tour-dot' +
        (n < i ? ' is-done' : n === i ? ' is-now' : '')));
    }
    row.appendChild(dots);
    return row;
  }

  /* Move the spotlight and the bubble onto wherever the anchor is NOW.
   * Deliberately does no scrolling and rebuilds nothing, so it is safe to
   * call from a scroll handler. */
  function reposition() {
    if (!running || !ui) return;
    const step = steps[i];
    if (!step) return;
    const node = target(step);
    if (!node) return;
    const r = node.getBoundingClientRect();
    ui.spot.style.top = (r.top + window.scrollY) + 'px';
    ui.spot.style.left = (r.left + window.scrollX) + 'px';
    ui.spot.style.width = r.width + 'px';
    ui.spot.style.height = r.height + 'px';
    place(ui.bubble, r);
  }

  function render() {
    if (!running) return;

    // Belt to the braces of resolve(): a step's anchor can still disappear
    // between resolving and arriving at it. Skip rather than stall.
    while (i < steps.length) {
      switchView(steps[i].view);
      if (target(steps[i])) break;
      steps.splice(i, 1);
    }
    if (i >= steps.length) { finish(true); return; }

    const step = steps[i];
    const node = target(step);

    // An anchor taller than the viewport cannot be centred: centring puts its
    // middle at the middle, which pushes the bottom — and the bubble pinned
    // under it — off the screen. Align such an anchor to the top instead.
    const tall = node.getBoundingClientRect().height > window.innerHeight * 0.7;
    node.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'smooth' });

    // One frame for the smooth scroll to settle before measuring.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!running) return;
      const r = node.getBoundingClientRect();

      ui.spot.style.top = (r.top + window.scrollY) + 'px';
      ui.spot.style.left = (r.left + window.scrollX) + 'px';
      ui.spot.style.width = r.width + 'px';
      ui.spot.style.height = r.height + 'px';

      ui.bubble.innerHTML = '';
      ui.bubble.appendChild(progressRow());
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
      // preventScroll: focusing a button the browser thinks is out of view
      // scrolls to it, which is another way back into the loop above.
      next.focus({ preventScroll: true });
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
    // reposition(), NOT render(). render() calls scrollIntoView, scrolling
    // fires this handler, and the page fights every attempt to scroll — the
    // reader gets yanked back and can never reach the bottom of a long step.
    reflow = setTimeout(reposition, 120);
  }

  async function markSeen() {
    // Best effort. Failing to record it means someone sees the tour twice,
    // which is a nuisance; throwing here would break the Done button, which
    // is worse.
    try {
      if (!me || !me.id) return;
      const sb = await window.DashClient.client();
      if (!sb) return;
      const now = new Date().toISOString();
      await sb.from('artists').update({ tutorial_seen_at: now }).eq('id', me.id);
      me.tutorial_seen_at = now;
    } catch (e) { console.warn('tour: could not record completion', e); }
  }

  function finish() {
    if (!running) return;
    running = false;
    clearTimeout(reflow);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    if (ui) { ui.veil.remove(); ui.spot.remove(); ui.bubble.remove(); ui = null; }
    const q = document.getElementById('howThisWorks');
    if (q) q.classList.remove('is-touring');
    // Skipping counts too. Someone who skipped can restart from the question
    // mark, and re-ambushing them on every sign-in is not teaching.
    markSeen();
  }

  /**
   * Run the tour from step one.
   * @param opts.artist  the artists row (needs id, role, name)
   */
  function start(opts) {
    const artist = (opts && opts.artist) || me;
    if (!artist) return;
    me = artist;

    if (running) finish();

    // Admins get the artist walkthrough AND the admin one. Kat uploads her
    // own flash like everybody else; a tour that skipped the upload screen
    // because she is an admin would skip the part she uses most.
    const script = (artist.role === 'admin')
      ? ARTIST_STEPS.concat(ADMIN_STEPS, [LAST_STEP])
      : ARTIST_STEPS.concat([LAST_STEP]);

    steps = resolve(script);
    if (!steps.length) return;      // nothing on screen to point at yet

    i = 0;
    running = true;
    ui = build();
    const q = document.getElementById('howThisWorks');
    if (q) q.classList.add('is-touring');
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    render();
  }

  /** Called once the dashboard has signed someone in. */
  function attach(artist) {
    me = artist;

    // The question mark is permanent from here on, for everybody.
    const q = document.getElementById('howThisWorks');
    if (q) {
      q.hidden = false;
      q.onclick = () => start({ artist: me });
    }

    // First visit: it just runs. No opt-in, no "would you like a tour",
    // same for admins and artists. The delay lets app.js finish painting
    // the first tab so the anchors exist to point at.
    if (!artist.tutorial_seen_at) {
      setTimeout(() => start({ artist: me }), 800);
    }
  }

  return {
    start, attach, finish,
    _steps: { artist: ARTIST_STEPS, admin: ADMIN_STEPS, last: LAST_STEP },
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
