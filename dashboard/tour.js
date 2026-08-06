/* Guided tutorial — one script per role, shown a step at a time.
 *
 * Joshua's ask, verbatim: "make a tutorial for each user, for the admin
 * users, and then make a tutorial for the artist. Give them a way to learn
 * how to navigate the site... use thought bubbles or whatever."
 *
 * And later, which is what the step ids below are for: "when a new feature is
 * added and that person hasn't seen a tutorial about it, they get a tutorial
 * for the new feature. The tutorial walks into the new feature."
 *
 * SEVEN RULES THIS FILE KEEPS
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
 * 5. NOBODY IS TAUGHT THE SAME THING TWICE. Every step carries a stable id,
 *    and the ids somebody has been shown live in artists.tutorial_seen. A
 *    step whose id is not in that array is unseen, so a NEW FEATURE SHIPS
 *    WITH A NEW ID AND REACHES EVERYONE ON ITS OWN — no backfill, no version
 *    number to bump, nothing to remember on the day it goes out. They get a
 *    short run covering only what is new, not the whole walkthrough again.
 *    tutorial_seen_at = null overrides all of it and means "start over",
 *    which is what Kat's "Replay their tutorial" button sets.
 * 6. THE QUESTION MARK IS CONTEXTUAL. Somebody who is lost is lost on the
 *    screen they are looking at. Tapping it walks the steps for the tab they
 *    are on, seen or not, rather than restarting from step one on a different
 *    tab. If the current tab has no steps, it walks everything.
 * 7. NAME THE THING, SAY WHAT TO DO, STOP. Short and plain — these are
 *    tattoo artists on phones. No "row-level security", no "derivative", no
 *    "canonical key". And no commentary: not who is not allowed to do
 *    something, not why the rule exists, not a defence of a design decision.
 *    Nobody tapping Next asked. A rule that matters shows up as a refusal at
 *    the moment somebody hits it, in the error message, where it is an
 *    answer rather than an unprompted argument.
 *
 * AND AN EIGHTH, ABOUT LEAVING: SKIP MEANS "NOT NOW", NOT "NEVER". It used
 * to mark everything seen, so a feature waved away once was never explained
 * again. It now snoozes — the steps stay unseen, the tab keeps its dot, the
 * "?" still teaches them — it just stops the tour opening itself again
 * uninvited. And it puts you back on the tab you started from, rather than
 * abandoning you on whichever screen the tour had walked you to.
 *
 * NOTHING HERE SENDS EMAIL. The tour reads the roster and writes its own
 * progress. It never calls signInWithOtp and never touches an artist's email
 * address, so running it — or replaying it — cannot invite anybody.
 *
 * A STEP IS A PROMISE. Only teach what the database will actually allow. An
 * admin step once said "you can set anyone's photo"; portraits are now the
 * artist's own and that step is gone rather than reworded, because a lesson
 * left in this file reads as intent to somebody restoring it later.
 *
 * IDS ARE PERMANENT. Renaming one makes the step unseen for the entire shop
 * and everybody gets taught it again. Change the copy freely; leave the id.
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
 *
 * AND IT MUST NOT JUMP, BLINK, SNAP OR FLASH. Five causes, every one of them
 * timing rather than animation: measuring the anchor before the smooth
 * scroll had finished, measuring it before the tab's pane had finished
 * filling itself from the database, a debounce that froze the bubble
 * mid-drag, a fade-out interrupted by its own fade-in, and a veil and
 * spotlight that appeared at full strength before anything had been placed.
 * See settle(), fadeOut(), fadeIn() and the tracking block near the bottom.
 */
window.Tour = (function () {
  'use strict';

  /* ── Scripts ───────────────────────────────────────────────────────────
   * `id`   permanent, never reused, never renamed. See rule 5.
   * `view` switches tab first (by clicking the real tab button, which is
   *        what a person would do).
   * `sel`  the element the bubble points at. */

  const ARTIST_STEPS = [
    {
      id: 'upload-start',
      view: 'upload', sel: '#view-upload .dropzone',
      title: 'Start here',
      body: 'Tap to pick your flash, or drag files in. You can add a whole ' +
            'batch at once — you do not have to do them one at a time.',
    },
    {
      id: 'upload-sizes',
      view: 'upload', sel: '#view-upload > .card',
      title: 'Sizes are strict',
      body: 'A single design has to be 2048×2048. A full sheet has to be ' +
            '2160×3840. Anything else is refused, and the message tells you ' +
            'the size it needs.',
    },
    {
      id: 'upload-tagging',
      view: 'upload', sel: '#view-upload .req-panel',
      title: 'Tag your work',
      body: 'Categories are how a customer finds you. Tap the chips on a file ' +
            'to tag it, or tag the whole batch in one go from the top.',
    },
    {
      id: 'upload-request-category',
      view: 'upload', sel: '#view-upload .req-panel .input',
      title: 'Missing a category?',
      body: 'Start typing and anything close already in the shop comes up — ' +
            'tap it to use that one. If nothing fits, send yours and Kat ' +
            'approves it.',
    },
    {
      id: 'designs-needs-category',
      view: 'designs', sel: '#view-designs',
      title: 'A design needs a category',
      body: 'Nothing goes on the kiosk untagged. Not ready to tag something? ' +
            'Save it as a draft — drafts are private, and you can publish ' +
            'them later.',
    },
    {
      id: 'designs-tab',
      view: 'designs', sel: '.tab[data-view="designs"]',
      title: 'Your work lives here',
      body: 'Everything you have uploaded. Publish, unpublish, reorder, or ' +
            'delete it from this tab.',
    },
    {
      id: 'my-photo',
      sel: '#myAvatar',
      title: 'Your photo',
      body: 'Tap your circle to upload or change your headshot. It shows ' +
            'next to your flash on the kiosk.',
    },
  ];

  const ADMIN_STEPS = [
    {
      id: 'artists-add',
      view: 'artists', sel: '#view-artists > .card:first-child',
      title: 'Adding an artist',
      body: 'Name, handle, email. That is the whole of it.',
    },
    {
      id: 'artists-invite',
      view: 'artists', sel: '#view-artists > .card:first-child .btn',
      title: 'Saving an email sends their link',
      body: 'Put an email on a card and save it, and that person gets their ' +
            'sign-in link. Changing an email sends a fresh one.',
    },
    {
      id: 'requests-review',
      view: 'requests', sel: '#view-requests .req-item',
      title: 'Category requests',
      body: 'Approve to create it. Merge if they meant one we already have. ' +
            'Reject with a note so they know why.',
    },
    {
      id: 'requests-kind',
      view: 'requests', sel: '#view-requests .req-actions select',
      title: 'What “kind” means',
      body: 'Style is how it is drawn — fine line, blackwork. Theme is the ' +
            'mood — summertime, Texas. Subject is what it shows — ' +
            'snakes, roses. A design can be all three.',
    },
    {
      id: 'flashsales-create',
      view: 'flashsales', sel: '#view-flashsales > .card:first-child',
      title: 'Flash sales',
      body: 'Make an event, set when it starts and ends, then add the price ' +
            'levels. Publish it and the kiosk switches over on its own when ' +
            'the start time arrives.',
    },
    {
      id: 'flashsales-photos',
      view: 'flashsales', sel: '#view-flashsales .sale-media',
      title: 'Event photos',
      body: 'Add your own photos for the event. They play in the slideshow ' +
            'on the kiosk while nobody is touching it.',
    },
    {
      id: 'review-queue',
      view: 'review', sel: '#view-review',
      title: 'The approval queue',
      body: 'Anything waiting on your yes lands here. Artists publish ' +
            'straight to the kiosk right now, so it is usually empty.',
    },
  ];

  const LAST_STEP = {
    id: 'help-button',
    sel: '#howThisWorks',
    title: 'Lost? Tap the question mark',
    body: 'It is always down here. One tap and it walks you through whatever ' +
          'screen you are on.',
  };

  /* ── Engine ─────────────────────────────────────────────────────────── */

  let steps = [];
  let i = 0;
  let ui = null;
  let me = null;          // the artists row of whoever is running it
  let running = false;
  let dotObs = null;      // keeps the tab dots alive across app.js repaints
  let startedOn = null;   // the tab this run began on — where Skip returns to

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

  /* Is this actually on screen? Not "does the element exist" — an element
   * can exist and be unreachable.
   *
   * THIS IS WHY A STAGED FEATURE STILL GOT TAUGHT. The Flash Sales tab was
   * held back for a test with an inline display:none, and the tour walked
   * straight into it anyway: the check below used to be `!tab.hidden`, and
   * app.js REMOVES the hidden attribute for admins, so the tab read as
   * available while being invisible on screen. The tour clicked it, the pane
   * rendered, the anchor resolved, and the step was marked seen — so the
   * follow-up run had nothing left to show.
   *
   * offsetWidth/offsetHeight/getClientRects covers every way of being
   * invisible at once: the hidden attribute, display:none on the element or
   * any ancestor, and a detached node. */
  function onScreen(node) {
    return !!(node && (node.offsetWidth || node.offsetHeight ||
                       node.getClientRects().length));
  }

  function switchView(view) {
    if (!view) return;
    const tab = document.querySelector('.tab[data-view="' + view + '"]');
    // Not on screen means this person does not have the tab — either their
    // role never gets it, or it is being deliberately withheld. Either way
    // the step is dropped when its anchor fails to resolve.
    if (onScreen(tab)) tab.click();
  }

  function fullScript(artist) {
    // Admins get the artist walkthrough AND the admin one. Kat uploads her
    // own flash like everybody else; a tour that skipped the upload screen
    // because she is an admin would skip the part she uses most.
    return (artist.role === 'admin')
      ? ARTIST_STEPS.concat(ADMIN_STEPS, [LAST_STEP])
      : ARTIST_STEPS.concat([LAST_STEP]);
  }

  function seenIds() {
    return (me && Array.isArray(me.tutorial_seen)) ? me.tutorial_seen : [];
  }

  function snoozedIds() {
    return (me && Array.isArray(me.tutorial_snoozed)) ? me.tutorial_snoozed : [];
  }

  /** Steps this person has never been shown. The whole of rule 5.
   *
   * This is what the NOTIFICATION DOT is computed from — deliberately not
   * filtered by snooze. Skipping a new feature must leave the dot up: it is
   * the only remaining signal that the thing is there and unexplained. */
  function unseen(script) {
    const seen = seenIds();
    return script.filter(function (s) { return seen.indexOf(s.id) === -1; });
  }

  /* What may AMBUSH somebody on sign-in: unseen, minus anything they have
   * already waved away. Skip means "not now", and answering that by opening
   * the same tour again on the next sign-in is not teaching, it is nagging.
   * The dot survives; the interruption does not. */
  function dueNow(script) {
    const snoozed = snoozedIds();
    return unseen(script).filter(function (s) {
      return snoozed.indexOf(s.id) === -1;
    });
  }

  /* ── THE NOTIFICATION DOT ──────────────────────────────────────────
   * Joshua: "you just put in the notification dot, the same dot that we used
   * on the request... and then that new feature comes up... If they hit
   * skip, then it bounces them back to the front page, and the notification
   * dot goes above in the tab."
   *
   * A tab wearing a dot means: there is something on this screen you have
   * never been shown. It is the same pink as the Requests count badge, minus
   * the number — a count would be answering a question nobody asked.
   *
   * REPAINTED FROM AN OBSERVER, not once. app.js rebuilds the Requests tab
   * wholesale every time the queue changes (paintRequestBadge does
   * `tab.innerHTML = ''`), which would silently eat a dot placed there. */
  function paintDots() {
    if (!me) return;
    const script = fullScript(me);
    const owed = {};
    unseen(script).forEach(function (st) { if (st.view) owed[st.view] = true; });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
      const view = tab.dataset.view;
      const want = !!owed[view] && onScreen(tab);
      const has = tab.querySelector('.new-dot');
      if (want && !has) {
        const d = el('span', 'new-dot');
        d.setAttribute('aria-label', 'New — not shown to you yet');
        tab.appendChild(d);
      } else if (!want && has) {
        has.remove();
      }
    });
  }

  function watchTabs() {
    const tabs = document.getElementById('tabs');
    if (!tabs || dotObs) return;
    dotObs = new MutationObserver(function () { paintDots(); });
    dotObs.observe(tabs, { childList: true, subtree: true });
  }

  /* Tapping a dotted tab runs what that tab owes you — including anything
   * you skipped, because tapping it IS asking. */
  function bindDotTabs() {
    const tabs = document.getElementById('tabs');
    if (!tabs || tabs.dataset.tourBound) return;
    tabs.dataset.tourBound = '1';
    tabs.addEventListener('click', function (e) {
      /* A HUMAN tap, not the tour's own navigation. resolve() and
       * switchView() drive the tabs with tab.click(), which fires this
       * handler with running still false — it would schedule a second tour
       * that tears the first one down mid-render. isTrusted is false for any
       * click dispatched from script, which is exactly the distinction. */
      if (!e.isTrusted) return;
      const tab = e.target.closest ? e.target.closest('.tab') : null;
      if (!tab || !tab.querySelector('.new-dot') || running || !me) return;
      const view = tab.dataset.view;
      // After app.js has switched the pane and rendered it.
      setTimeout(function () {
        start({ artist: me, mode: 'new', view: view });
      }, 350);
    });
  }

  function activeView() {
    const t = document.querySelector('.tab.is-active');
    return t ? t.dataset.view : null;
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
    script.forEach(function (s) {
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
    // All three start transparent — see the CSS. fadeIn() brings them up
    // together once the first step has actually been placed, so nothing is
    // ever visible in the wrong position or before there is anything to
    // look at.
    veil.classList.remove('is-visible');
    spot.classList.remove('is-visible');
    bubble.classList.remove('is-visible');

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

    // Viewport coordinates, because the bubble is position: fixed. It used to
    // be absolute with window.scrollY added, which had a second cost beyond
    // the arithmetic: a bubble placed low on a SHORT pane extended the
    // document, and the page lurched as the scrollbar appeared. Joshua called
    // that "making the page jolt". Fixed cannot grow the document at all.
    const top = below ? rect.bottom + pad : rect.top - h - pad;
    let left = rect.left;
    left = Math.max(12, Math.min(left, vw - w - 12));

    // Clamp into the viewport. An anchor taller than the screen puts its own
    // bottom edge below the fold, and a bubble pinned under it goes with it —
    // taking Next and Skip out of reach, which strands the reader on that
    // step. Being slightly detached from the anchor beats being unreachable.
    const minTop = 12;
    const maxTop = vh - h - 12;
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

  /* Wait for the ANCHOR to stop moving — not for the scroll to stop.
   *
   * This is the fix for the jump Joshua saw: "when it's switched to the tab,
   * it started at the top, and then it jumped down to the bottom."
   *
   * The previous version watched window.scrollY. That is the wrong thing to
   * watch, and a tab switch proves it. render() clicks the tab, app.js
   * re-renders that pane and fills it from the database a moment later, and
   * scrollIntoView often does not move the page at all because it is already
   * at the top. So scrollY was stable within three frames — about 50ms — the
   * anchor got measured against a pane that was still EMPTY, and the bubble
   * was placed near the top. Then the rows arrived, everything below the fold
   * shifted down, and the bubble was left somewhere that no longer meant
   * anything until the next reflow dragged it. That is the jump.
   *
   * Watching the anchor's own rectangle catches both causes at once: a scroll
   * in flight moves it, and a pane growing underneath it moves it too. It
   * does not care WHY the thing moved, which is the point.
   *
   * It also re-queries the anchor every frame. app.js rebuilds a pane's DOM
   * wholesale, so the element found before the tab switch is frequently
   * detached by the time the pane is ready — and a detached node reports a
   * rectangle of all zeros, which is perfectly "stable" and would have pinned
   * the bubble to the top-left corner. */
  function settle(step, cb) {
    var last = null;
    var still = 0;
    var frames = 0;
    (function tick() {
      if (!running) return;
      var node = target(step);

      // The pane is mid-rebuild and the anchor does not exist this frame.
      // Wait for it rather than measuring a corpse.
      if (!node || !node.isConnected) {
        last = null;
        still = 0;
        if (++frames > 90) { cb(null); return; }
        requestAnimationFrame(tick);
        return;
      }

      var r = node.getBoundingClientRect();
      var same = last && last.node === node &&
        Math.abs(r.top - last.top) < 0.5 &&
        Math.abs(r.left - last.left) < 0.5 &&
        Math.abs(r.width - last.width) < 0.5 &&
        Math.abs(r.height - last.height) < 0.5;

      still = same ? still + 1 : 0;
      last = { node: node, top: r.top, left: r.left, width: r.width, height: r.height };

      // Four still frames rather than three: a pane that renders in two
      // passes can be briefly stable between them.
      if (still >= 4 || ++frames > 90) { cb(node); return; }   // ~1.5s cap
      requestAnimationFrame(tick);
    })();
  }

  /* ── ONE FADE, THE SAME EVERY TIME ─────────────────────────────────
   * Joshua: "some are blinking, some just snap on, and some have a fade.
   * There are just different behaviors happening for each one."
   *
   * He was right, and the CSS was never the problem — there is one bubble
   * element, so every step shares the same rules. The variation came from
   * here. render() removed .is-visible and then added it back after settle(),
   * with NOTHING guaranteeing the fade-out had finished in between. settle()
   * takes as long as the anchor takes to stop moving: a step that scrolls
   * gives it 400ms and you see a real fade, a step whose anchor is already
   * still returns in four frames — so the fade-out was interrupted about 60ms
   * in, at roughly 77% opacity, and reversed. That dip is the blink, and its
   * depth varied per step, which is why no two looked alike.
   *
   * Measured on the deployed build across an eight-step run: six blinks that
   * never faded below 0.77, and two genuine fades.
   *
   * So visibility is now a sequence rather than two class changes that race:
   * fade fully OUT, and only then move, rebuild and fade back IN. Every step
   * goes through it, including a re-home. */
  function fadeOut(cb) {
    if (!ui) return;
    const bubble = ui.bubble;

    // Already hidden — the first step, or a step that follows a dropped one.
    // Nothing to wait for, and waiting would add a pause before the tour
    // even appears.
    if (!bubble.classList.contains('is-visible')) { cb(); return; }

    let done = false;
    function settled() {
      if (done) return;
      done = true;
      bubble.removeEventListener('transitionend', onEnd);
      clearTimeout(guard);
      cb();
    }
    // Only opacity. The transform finishes alongside it and would fire this
    // twice.
    function onEnd(e) { if (e.propertyName === 'opacity') settled(); }

    bubble.addEventListener('transitionend', onEnd);
    // transitionend does not fire if the element is display:none, if the tab
    // is backgrounded, or if reduced-motion has removed the transition
    // entirely. The tour must never stall waiting for an event that is not
    // coming. Comfortably longer than the 200ms fade-out.
    const guard = setTimeout(settled, 320);

    bubble.classList.remove('is-visible');
  }

  function fadeIn() {
    if (!running || !ui) return;
    // Flush the layout so the browser has actually painted the bubble at its
    // NEW position while still transparent. Without this the position change
    // and the opacity change are batched into one style recalculation, the
    // browser sees no "before" state to animate from, and the bubble snaps
    // on at full opacity instead of fading.
    void ui.bubble.offsetHeight;
    requestAnimationFrame(function () {
      if (!running || !ui) return;
      /* All three together. The veil and the spotlight are built before
       * anything has been measured, so they stay invisible until the first
       * step is actually placed — otherwise the screen darkens a beat early
       * and the spotlight paints its full-screen shadow from a 0x0 box in
       * the corner. Idempotent: after the first step these are already on
       * and the spotlight simply glides to the next anchor. */
      ui.veil.classList.add('is-visible');
      ui.spot.classList.add('is-visible');
      ui.bubble.classList.add('is-visible');
    });
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
    ui.spot.style.top = r.top + 'px';
    ui.spot.style.left = r.left + 'px';
    ui.spot.style.width = r.width + 'px';
    ui.spot.style.height = r.height + 'px';
    place(ui.bubble, r);
    homeRect = { top: r.top, left: r.left };
  }

  /* The anchor moved for a reason that was NOT the reader scrolling — a pane
   * finished loading, a card expanded, rows arrived. Following that instantly
   * is the jolt: the bubble teleports across the screen in full view while
   * nobody has touched anything.
   *
   * Scrolling is different and is handled elsewhere: there, moving every
   * frame is exactly right, because the bubble is staying glued to something
   * the reader is dragging. The difference is who moved it.
   *
   * So a content shift is treated like arriving at the step: fade out, bring
   * the anchor back on screen, wait for it to settle, fade back in. The
   * bubble is never seen travelling. */
  function rehome() {
    if (!running || !ui || tracking) return;
    const step = steps[i];
    if (!step) return;
    const node = target(step);
    if (!node) return;

    const r = node.getBoundingClientRect();
    // Ignore sub-pixel and cosmetic movement; only re-home for a shift big
    // enough to actually break the connection to the anchor.
    if (homeRect &&
        Math.abs(r.top - homeRect.top) < 24 &&
        Math.abs(r.left - homeRect.left) < 24) return;

    const tall = r.height > window.innerHeight * 0.7;

    // Exactly the same sequence render() uses, so a content shift is
    // indistinguishable from arriving at the step.
    fadeOut(function () {
      if (!running || !ui) return;
      node.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'smooth' });

      settle(step, function (live) {
        if (!running || !ui || !live) return;
        const rr = live.getBoundingClientRect();
        ui.spot.style.top = rr.top + 'px';
        ui.spot.style.left = rr.left + 'px';
        ui.spot.style.width = rr.width + 'px';
        ui.spot.style.height = rr.height + 'px';
        place(ui.bubble, rr);
        homeRect = { top: rr.top, left: rr.left };
        fadeIn();
      });
    });
  }

  function onContentReflow() {
    if (!running) return;
    clearTimeout(rehomeTimer);
    // One re-home for a burst of mutations, not one per row that lands.
    rehomeTimer = setTimeout(rehome, 150);
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
    if (i >= steps.length) { finish(); return; }

    const step = steps[i];
    const node = target(step);

    // An anchor taller than the viewport cannot be centred: centring puts its
    // middle at the middle, which pushes the bottom — and the bubble pinned
    // under it — off the screen. Align such an anchor to the top instead.
    const tall = node.getBoundingClientRect().height > window.innerHeight * 0.7;

    /* Fade out COMPLETELY before anything moves. The scroll is deliberately
     * inside the callback: a bubble that travels across the screen while
     * still partly opaque is the thing that reads as jumpy, and starting the
     * scroll alongside the fade meant the two overlapped by however long the
     * fade happened to take. */
    fadeOut(function () {
      if (!running || !ui) return;
      node.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'smooth' });

      /* Measure only once the ANCHOR has stopped moving — see settle(). It
       * hands back the anchor as it exists at that moment, which is not
       * necessarily the element we scrolled to: switching tabs makes app.js
       * rebuild the pane, so `node` above is often detached by now. Using the
       * stale reference is how the bubble ended up measuring a rectangle of
       * zeros and pinning itself to the corner. */
      settle(step, function (live) {
        if (!running) return;

        // The anchor never came back — the pane no longer contains it. Drop
        // the step rather than pointing at nothing.
        if (!live) { steps.splice(i, 1); render(); return; }

        const r = live.getBoundingClientRect();

        ui.spot.style.top = r.top + 'px';
        ui.spot.style.left = r.left + 'px';
        ui.spot.style.width = r.width + 'px';
        ui.spot.style.height = r.height + 'px';

        ui.bubble.innerHTML = '';
        ui.bubble.appendChild(progressRow());
        ui.bubble.appendChild(el('div', 'tour-title', step.title));
        ui.bubble.appendChild(el('p', 'tour-body', step.body));

        const actions = el('div', 'tour-actions');
        if (i > 0) {
          const back = el('button', 'btn btn-quiet', 'Back');
          back.onclick = function () { i--; render(); };
          actions.appendChild(back);
        }
        const skip = el('button', 'btn btn-quiet', 'Skip');
        skip.onclick = function () { finish({ skipped: true }); };
        actions.appendChild(skip);
        actions.appendChild(el('span', 'tour-spacer'));

        const next = el('button', 'btn btn-primary',
          i === steps.length - 1 ? 'Done' : 'Next');
        next.onclick = function () {
          if (i === steps.length - 1) return finish();
          i++; render();
        };
        actions.appendChild(next);
        ui.bubble.appendChild(actions);

        // Placed while still fully invisible, so the move is never seen.
        place(ui.bubble, r);
        homeRect = { top: r.top, left: r.left };
        fadeIn();

        // preventScroll: focusing a button the browser thinks is out of view
        // scrolls to it, which is another way back into the loop above.
        next.focus({ preventScroll: true });
      });
    });
  }

  function onKey(e) {
    if (!running) return;
    // Escape is a dismissal, same as Skip.
    if (e.key === 'Escape') { finish({ skipped: true }); return; }
    // Arrow keys only when focus is inside the bubble, so they do not fight
    // the app's own controls.
    if (!ui.bubble.contains(document.activeElement)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); if (i < steps.length - 1) { i++; render(); } else finish(); }
    if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); i--; render(); }
  }

  /* Following the page while it scrolls.
   *
   * reposition(), NOT render(). render() calls scrollIntoView, scrolling
   * fires this handler, and the page would fight every attempt to scroll —
   * the reader gets yanked back and can never reach the bottom of a long step.
   *
   * A 120ms debounce used to sit here, and it was the second source of
   * jumpiness: the bubble stayed frozen while you dragged and then snapped
   * to its new home a beat later. It now follows every frame while a scroll
   * is in progress, with the CSS easing switched OFF via .is-tracking —
   * easing a position that is already changing 60 times a second just adds
   * lag behind your thumb. The easing comes back when you stop. */
  let tracking = false;
  let trackRaf = null;
  let trackStop = null;
  let reflowObs = null;
  let rehomeTimer = null;
  let homeRect = null;      // where the anchor was when the bubble was placed

  function trackFrame() {
    reposition();
    if (tracking) trackRaf = requestAnimationFrame(trackFrame);
  }

  function endTracking() {
    tracking = false;
    if (trackRaf) cancelAnimationFrame(trackRaf);
    trackRaf = null;
    if (ui) {
      ui.spot.classList.remove('is-tracking');
      ui.bubble.classList.remove('is-tracking');
    }
    reposition();
  }

  function onReflow() {
    if (!running || !ui) return;
    if (!tracking) {
      tracking = true;
      ui.spot.classList.add('is-tracking');
      ui.bubble.classList.add('is-tracking');
      trackFrame();
    }
    clearTimeout(trackStop);
    trackStop = setTimeout(endTracking, 140);
  }

  /* Record what this run did. Two different things, and conflating them was
   * a real bug: FINISHING teaches, SKIPPING defers.
   *
   * Skipping used to mark every step seen, which cleared the tab's dot and
   * meant a feature waved away once was never explained again. */
  async function record(skipped) {
    try {
      if (!me || !me.id) return;
      const sb = await window.DashClient.client();
      if (!sb) return;

      const ids = steps.map(function (s) { return s.id; }).filter(Boolean);
      const now = new Date().toISOString();

      if (skipped) {
        /* SKIPPING IS NOT SEEING. The steps stay unseen, so the dot stays up
         * and the "?" and the tab still teach them — they just do not ambush
         * you on the next sign-in.
         *
         * tutorial_seen_at IS still stamped, and that matters: it is what
         * selects "new features only" mode. Leaving it null would replay the
         * entire walkthrough next time somebody skipped their first run. */
        const snoozed = snoozedIds().slice();
        ids.forEach(function (id) { if (snoozed.indexOf(id) === -1) snoozed.push(id); });
        await sb.from('artists')
          .update({ tutorial_snoozed: snoozed, tutorial_seen_at: now })
          .eq('id', me.id);
        me.tutorial_snoozed = snoozed;
        me.tutorial_seen_at = now;
        return;
      }

      const merged = seenIds().slice();
      ids.forEach(function (id) { if (merged.indexOf(id) === -1) merged.push(id); });
      // Finishing something clears its snooze — it is no longer deferred,
      // it is done.
      const snoozed = snoozedIds().filter(function (id) { return ids.indexOf(id) === -1; });

      await sb.from('artists')
        .update({ tutorial_seen: merged, tutorial_snoozed: snoozed, tutorial_seen_at: now })
        .eq('id', me.id);
      me.tutorial_seen = merged;
      me.tutorial_snoozed = snoozed;
      me.tutorial_seen_at = now;
    } catch (e) {
      // Failing to record it means someone sees a step twice, which is a
      // nuisance; throwing here would break the Done button, which is worse.
      console.warn('tour: could not record progress', e);
    }
  }

  function finish(opts) {
    if (!running) return;
    const skipped = !!(opts && opts.skipped);
    running = false;
    clearTimeout(trackStop);
    if (trackRaf) cancelAnimationFrame(trackRaf);
    tracking = false;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onReflow);
    window.removeEventListener('scroll', onReflow, true);
    if (reflowObs) { reflowObs.disconnect(); reflowObs = null; }
    clearTimeout(rehomeTimer);
    homeRect = null;
    if (ui) { ui.veil.remove(); ui.spot.remove(); ui.bubble.remove(); ui = null; }
    const q = document.getElementById('howThisWorks');
    if (q) q.classList.remove('is-touring');

    /* Skipping mid-way can leave you standing on a tab the tour walked you
     * to, which is a strange place to be dropped. Go back to where the run
     * began — see startedOn in start() — and leave the dot as the way back
     * to anything that went untaught. */
    if (skipped && startedOn) {
      const home = document.querySelector('.tab[data-view="' + startedOn + '"]');
      if (home && !home.classList.contains('is-active')) home.click();
    }
    startedOn = null;

    record(skipped).then(paintDots);
    paintDots();
  }

  /**
   * @param opts.artist  the artists row (needs id, role, name, tutorial_seen)
   * @param opts.mode    'all'    every step, ignoring what has been seen
   *                     'unseen' new steps they have not waved away (sign-in)
   *                     'new'    what one tab owes, snoozed or not (the dot)
   *                     'tab'    every step for the tab they are on (the ?)
   * @param opts.view    for mode 'new': which tab's steps to run
   */
  function start(opts) {
    const artist = (opts && opts.artist) || me;
    if (!artist) return;
    me = artist;
    const mode = (opts && opts.mode) || 'all';

    if (running) finish();

    let script = fullScript(artist);
    if (mode === 'unseen') {
      // Sign-in. Only what is genuinely new AND not already waved away.
      script = dueNow(script);
    } else if (mode === 'new') {
      /* A dotted tab was tapped. Everything that tab owes, snoozed or not —
       * tapping the dot is asking for it. */
      const v = (opts && opts.view) || activeView();
      script = unseen(script).filter(function (s) { return s.view === v; });
    } else if (mode === 'tab') {
      const view = activeView();
      const here = script.filter(function (s) { return s.view === view; });
      // Somewhere with nothing of its own to say falls back to everything,
      // rather than answering a request for help with silence.
      script = here.length ? here : script;
    }
    if (!script.length) return;

    /* Where Skip goes back to. Not "the front page" as a fixed destination —
     * the tab this run STARTED on, which gives the right answer for both
     * cases without special-casing either.
     *
     * Joshua: "if they started at the beginning of a fresh page load for the
     * first time, they're on the upload screen... that's where it is going
     * to bounce them back to. [But if] they click over to a tab, they click
     * the question mark button... and skip the step, it should just exit
     * right on top. The bubble should go away, and the tab should still be
     * on the same tab that they started this tutorial on."
     *
     * A sign-in run begins on Upload because that is the default tab and the
     * first thing anyone should be doing, so it lands on Upload. A "?" run
     * begins wherever they already were, so it lands right back there. Same
     * line of code. */
    startedOn = activeView();

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

    /* scroll and resize are not enough, and this is the other half of the
     * tab-switch jump. A pane that finishes loading and grows underneath the
     * bubble fires NEITHER event: the window did not resize and nobody
     * scrolled, the content simply got taller. The bubble then sat pointing
     * at where the anchor used to be until something incidental jogged it.
     *
     * Observing #app catches exactly that, and it is cheap — one callback
     * when a pane changes size, feeding the re-home path above. */
    if (window.ResizeObserver) {
      reflowObs = new ResizeObserver(function () { onContentReflow(); });
      const app = document.getElementById('app');
      if (app) reflowObs.observe(app);
      reflowObs.observe(document.documentElement);
    }

    render();
  }

  /** Called once the dashboard has signed someone in. */
  function attach(artist) {
    me = artist;

    // The question mark is permanent from here on, for everybody, and it is
    // contextual: it explains the screen you are looking at.
    const q = document.getElementById('howThisWorks');
    if (q) {
      q.hidden = false;
      q.onclick = function () { start({ artist: me, mode: 'tab' }); };
    }

    /* The dot goes up BEFORE the tour runs and stays up afterwards for
     * anything still unseen — so a skipped feature is still visibly waiting,
     * and a feature whose walkthrough cannot run yet (its anchor does not
     * exist) is still announced. */
    watchTabs();
    bindDotTabs();
    setTimeout(paintDots, 300);

    // Never been through it, or Kat reset them: the whole thing.
    // Otherwise: only what has been added since they last looked, which is
    // usually nothing and occasionally one new feature.
    // The delay lets app.js finish painting the first tab so the anchors
    // exist to point at.
    const mode = artist.tutorial_seen_at ? 'unseen' : 'all';
    setTimeout(function () { start({ artist: me, mode: mode }); }, 800);
  }

  return {
    start, attach, finish, paintDots,
    _steps: { artist: ARTIST_STEPS, admin: ADMIN_STEPS, last: LAST_STEP },
    _unseen: unseen,
  };
})();

/* ── Self-wiring ─────────────────────────────────────────────────────────
 * app.js is deliberately untouched by this feature: it is the file with the
 * most to lose and the least to gain from being edited. Instead this watches
 * for the dashboard signing someone in (the top bar unhides), then reads the
 * artist row itself.
 *
 * IT MUST NOT GIVE UP. An earlier version set done = true before awaiting the
 * session, so when localStorage did not have it yet — exactly what happens
 * while app.js is still exchanging a magic link — it returned and never ran
 * again, and the tour simply never appeared. Only mark done once a row is in
 * hand, and retry on a short timer until then.
 */
(function () {
  'use strict';

  const bar = document.getElementById('topbar');
  if (!bar) return;

  let done = false;
  let tries = 0;
  const MAX = 40;            // ~10s at 250ms, then stop asking

  async function attempt() {
    if (done) return true;
    if (bar.hidden) return false;
    try {
      const sb = await window.DashClient.client();
      if (!sb) return false;
      const { data: session } = await sb.auth.getUser();
      if (!session || !session.user) return false;
      const { data, error } = await sb.from('artists')
        .select('id, name, role, tutorial_seen, tutorial_snoozed, tutorial_seen_at, portrait_url, portrait_thumb_url')
        .eq('auth_user_id', session.user.id).maybeSingle();
      if (error || !data) return false;

      done = true;
      window.Tour.attach(data);
      if (window.MyAvatar) window.MyAvatar.attach(data);
      return true;
    } catch (e) {
      console.warn('tour: could not start', e);
      return false;
    }
  }

  function poll() {
    attempt().then(function (ok) {
      if (ok || ++tries >= MAX) return;
      setTimeout(poll, 250);
    });
  }

  const obs = new MutationObserver(function () { poll(); });
  obs.observe(bar, { attributes: true, attributeFilter: ['hidden'] });
  poll();
})();
