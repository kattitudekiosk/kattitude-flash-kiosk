/* Flash Gallery — script.js
 * Touch Events = primary (kiosk touchscreen)
 * Pointer Events = mouse/desktop fallback only (guarded by pointerType check)
 *
 * RESTING STATE: scale(1) translate(0,0)
 * CSS object-fit: contain on #sheetImg handles image fitting.
 * Transforms only apply when the user actively zooms/pans.
 */

(function () {
  'use strict';

  /* ── DOM refs ──────────────────────────────────────────────────────────── */
  const splash     = document.getElementById('splash');
  const fsExitBtn  = document.getElementById('fsExitBtn');
  const sheetLabel = document.getElementById('sheetLabel');
  const stage      = document.getElementById('stage');
  const stageInner = document.getElementById('stageInner');
  const img        = document.getElementById('sheetImg');
  const btnPrev    = document.getElementById('btnPrev');
  const btnNext    = document.getElementById('btnNext');
  const dotsEl     = document.getElementById('dots');

  const zoomBadge = document.createElement('div');
  zoomBadge.id    = 'zoomBadge';
  document.getElementById('viewer').appendChild(zoomBadge);

  /* ── State ─────────────────────────────────────────────────────────────── */
  // `let`, not `const`: the gallery can swap in a filtered list (one artist's
  // sheets, say) via SheetViewer.setSheets. Defaults to the full production
  // list from data.js, so with no gallery present nothing changes.
  let sheets = GALLERY_DATA.sheets;
  let current  = 0;

  // Resting state = scale 1, translate 0,0
  let scale = 1;
  let tx    = 0;
  let ty    = 0;
  const MIN_SCALE = 1;
  /* KIOSK_CONFIG.zoom false (the default) clamps every zoom path — tap,
   * pinch, wheel, keys — to 1x, because they all go through zoomAt(). */
  const ZOOM_ON = !!(window.KIOSK_CONFIG && window.KIOSK_CONFIG.zoom === true);
  const MAX_SCALE = ZOOM_ON ? 6 : 1;

  // Pinch-to-zoom is intentionally disabled (see onTouchStart) — a stray
  // second touch point (common on large capacitive panels) was being
  // misread as a pinch gesture mid-swipe, zooming instead of navigating.
  // Swipe threshold raised so small jitter during a real swipe can't be
  // misread either.
  const SWIPE_THRESHOLD   = 90;   // px of horizontal travel required to trigger nav
  const SWIPE_ANGLE_RATIO = 1.5;  // horizontal travel must dominate vertical by this much

  // A touch that moves less than this counts as a stationary TAP rather
  // than a swipe/drag — used to trigger tap-to-zoom (tap once to zoom in
  // centered on that point, tap again anywhere to zoom back out). Works
  // identically on the kiosk and on mobile; only pinch is disabled.
  const TAP_MOVE_TOLERANCE = 10;

  // Sheet slide-out/slide-in transition duration — slowed down from the
  // original 280ms so the flip between flash sheets feels smoother on the
  // kiosk touchscreen instead of feeling abrupt.
  const SLIDE_MS = 450;

  // Screensaver: after IDLE_TIMEOUT_MS with no touch, auto-cycle through the
  // sheets (burn-in prevention). Any tap during the screensaver wakes the
  // kiosk back to the logo/splash page rather than just pausing on a sheet.
  const IDLE_TIMEOUT_MS         = 120000; // 2 minutes
  const SCREENSAVER_INTERVAL_MS = 8000;   // ms per sheet while cycling (8s)

  let isDragging         = false;
  let dragStart          = null;  // { x, y, tx, ty }
  let swipeStart         = null;  // { x, y }
  let lastPinchDist      = 0;
  let multiTouchDetected = false; // a 2nd+ finger joined this gesture — see onTouchStart
  let trackedTouchId     = null;  // Touch.identifier of the finger driving the gesture —
                                   // touches[0] is NOT guaranteed to stay the same physical
                                   // contact across events (spec leaves array order
                                   // implementation-defined), so a ghost/phantom contact on
                                   // a noisy panel could silently swap into index 0 mid-
                                   // gesture and corrupt swipe tracking. Always resolve by id.

  let badgeTimer = null;

  // Mouse/desktop only
  let pointers = new Map();

  // Screensaver / idle state
  let idleTimer         = null;
  let screensaverTimer  = null;
  let screensaverActive = false;

  /* ── Design canvas scaling ────────────────────────────────────────────────
   * THE ONLY PLACE IN THE APP THAT READS THE REAL VIEWPORT.
   *
   * The whole UI is laid out at exactly 1080x1920 — the kiosk panel — and
   * this scales that canvas to fit whatever screen it is on. A phone shows a
   * literally identical composition, just smaller, because nothing inside can
   * see the real viewport: every clientWidth reads 1080.
   *
   * Any other viewport-conditional layout decision anywhere would reintroduce
   * the divergence this exists to prevent. tools/verify.js fails the build if
   * one appears.
   */
  const DESIGN_W = 1080;
  const DESIGN_H = 1920;

  function applyCanvasScale() {
    const canvas = document.getElementById('kioskCanvas');
    if (!canvas) return;
    const vw = window.innerWidth || document.documentElement.clientWidth || DESIGN_W;
    const vh = window.innerHeight || document.documentElement.clientHeight || DESIGN_H;

    // Contain, not cover: scaling past the shorter axis would crop the
    // composition, and "identical to the kiosk" has to include the edges.
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    document.documentElement.style.setProperty('--app-scale', String(scale));

    // The scaled canvas is 1920*scale tall; centre the leftover space so a
    // phone does not show all the slack at the bottom.
    const slack = Math.max(0, vh - DESIGN_H * scale);
    canvas.style.top = Math.round(slack / 2) + 'px';
  }

  applyCanvasScale();
  window.addEventListener('resize', applyCanvasScale);
  window.addEventListener('orientationchange', () => setTimeout(applyCanvasScale, 100));

  /* ── Fullscreen ─────────────────────────────────────────────────────────── */
  function requestFS() {
    // Some browsers (seen on kiosk hardware) throw SYNCHRONOUSLY here —
    // e.g. re-requesting while already fullscreen — rather than rejecting
    // a promise. Must never let that escape, or it aborts whatever caller
    // invoked this (see enterGallery, which now sequences its critical
    // splash-dismiss step before this call regardless).
    try {
      const el = document.documentElement;
      const fn = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fn) return Promise.resolve(fn.call(el)).catch(() => {});
    } catch (err) {
      console.log('[fullscreen] request failed (non-fatal):', err && err.message ? err.message : err);
    }
    return Promise.resolve();
  }

  function exitFS() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) fn.call(document);
  }

  function isFS() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // Diagnostic only — if this logs false, the Fullscreen API is blocked
  // outright for this page (e.g. no `allowfullscreen` on an embedding
  // iframe, or a Permissions-Policy disabling it), and no amount of
  // retrying requestFullscreen() from here will ever succeed; that would
  // need fixing in the kiosk browser/shell config, not this script.
  console.log('[fullscreen] document.fullscreenEnabled =', document.fullscreenEnabled);

  // Best-effort fullscreen attempt — used on page load and on visibility
  // regain, in addition to the splash tap (see enterGallery). Browsers
  // generally require a genuine user gesture for requestFullscreen() to
  // succeed, so these early/background attempts will often be silently
  // rejected outside a kiosk-mode browser — that's fine, requestFS()
  // already swallows both sync throws and promise rejections. The splash
  // tap remains the reliable path; this just grabs fullscreen immediately
  // wherever the browser/kiosk setup allows it.
  function tryEnterFullscreen() {
    if (!isFS()) requestFS();
  }

  document.addEventListener('fullscreenchange',       () => document.body.classList.toggle('in-fullscreen', isFS()));
  document.addEventListener('webkitfullscreenchange', () => document.body.classList.toggle('in-fullscreen', isFS()));

  /* ── Wake Lock (kiosk display must never dim/sleep) ───────────────────────
   * Requested on load and again when the splash is dismissed. Browsers
   * release the lock automatically when the tab is backgrounded, so it's
   * re-acquired on visibilitychange once the page is visible again.
   * Unsupported browsers are handled gracefully — logged, not fatal.
   */
  let wakeLock = null;

  async function requestWakeLock() {
    if (!('wakeLock' in navigator)) {
      console.log('[wake-lock] Not supported in this browser — screen may dim/sleep per OS settings.');
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[wake-lock] Acquired.');
      wakeLock.addEventListener('release', () => console.log('[wake-lock] Released.'));
    } catch (err) {
      console.log('[wake-lock] Request failed:', err && err.message ? err.message : err);
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      tryEnterFullscreen();
    }
  });

  /* ── Splash ─────────────────────────────────────────────────────────────── */
  let galleryEntered = false;

  function enterGallery(e) {
    if (galleryEntered) return;
    galleryEntered = true;
    if (e && e.cancelable) e.preventDefault();

    // Dismiss the splash and arm the idle timer FIRST and unconditionally.
    // Fullscreen/wake-lock are best-effort enhancements — if either throws
    // (seen on kiosk hardware re-requesting fullscreen), it must never be
    // able to leave the kiosk stuck showing the splash with no way to
    // dismiss it (galleryEntered would already be true, so every future
    // tap would silently no-op at the guard above).
    splash.classList.add('hidden');
    resetIdleTimer();

    // Hand off to the router, if one is present, so the splash can lead into
    // the gallery home screen instead of straight to sheets. Wrapped for the
    // same reason as fullscreen below: a fault in a later-loaded module must
    // never be able to strand the kiosk on an undismissable splash.
    try {
      if (window.KIOSK_ROUTER && typeof window.KIOSK_ROUTER.onSplashDismissed === 'function') {
        window.KIOSK_ROUTER.onSplashDismissed();
      }
    } catch (err) {
      console.log('[router] onSplashDismissed failed (non-fatal):', err && err.message ? err.message : err);
    }

    tryEnterFullscreen();
    requestWakeLock();
  }

  splash.addEventListener('touchstart', enterGallery, { passive: false });
  splash.addEventListener('pointerdown', e => { if (e.pointerType !== 'touch') enterGallery(e); });

  /* ── Screensaver (burn-in prevention) ─────────────────────────────────────
   * Idle countdown only runs while the gallery is being actively browsed
   * (after the splash has been dismissed). When it elapses, sheets auto-
   * cycle on a timer until the next touch, which sends the kiosk back to
   * the logo/splash page rather than just freezing the slideshow.
   */
  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(startScreensaver, IDLE_TIMEOUT_MS);
  }

  function startScreensaver() {
    if (screensaverActive || !galleryEntered) return;
    if (!sheets.length) return; // nothing to cycle through
    screensaverActive = true;
    document.body.classList.add('screensaver');
    if (isZoomed()) resetZoom();

    /* The mixed video+flash reel takes over ONLY if it has clips to play.
     * start() returns false when there are none, or when the catalog has no
     * stills, and then the original sheet cycle below runs exactly as it
     * always has. This is the whole degradation story: no clips, no change
     * to what is on the wall today. */
    try {
      if (window.Screensaver && window.Screensaver.start(document.getElementById('kioskCanvas'))) {
        return;
      }
    } catch (err) {
      console.log('[screensaver] reel failed to start, falling back to sheets:',
        err && err.message ? err.message : err);
    }

    screensaverTimer = setInterval(() => {
      navigate((current + 1) % sheets.length, 'left');
    }, SCREENSAVER_INTERVAL_MS);
  }

  function exitScreensaver() {
    if (!screensaverActive) return;
    screensaverActive = false;
    clearInterval(screensaverTimer);
    try { if (window.Screensaver) window.Screensaver.stop(); } catch (err) {}
    clearTimeout(idleTimer);
    document.body.classList.remove('screensaver');
    galleryEntered = false;
    // Intentionally does NOT call exitFS() — fullscreen must stay active
    // across the splash reset; Chrome UI should never reappear on the kiosk.

    // Splash must always reappear — do this before the best-effort sheet
    // reset so a failure there can never leave the kiosk stuck.
    splash.classList.remove('hidden');
    try {
      if (current === 0) resetZoom(); else loadSheet(0, 'none');
    } catch (err) {
      console.log('[screensaver] reset-to-sheet-1 failed (non-fatal):', err && err.message ? err.message : err);
    }
  }

  // The gallery UI (added later) needs real scrolling — a grid of designs and
  // a horizontal chip bar. The blanket preventDefault() below would kill it,
  // so surfaces that genuinely want native scrolling opt out by tagging
  // themselves [data-native-scroll]. Nothing in the legacy sheet viewer
  // carries that attribute, so its behaviour is unchanged.
  function wantsNativeScroll(e) {
    const t = e.target;
    return !!(t && t.closest && t.closest('[data-native-scroll]'));
  }

  // Capture phase so this always sees a touch first, before any component
  // (nav buttons, dots, the stage's own drag/swipe handling) can act on it —
  // stopping propagation here fully consumes the "wake up" tap so it can't
  // simultaneously trigger navigation or zoom underneath. preventDefault()
  // is unconditional (not just during screensaver) as a blanket "this app
  // owns all touch input" declaration — belt-and-suspenders against the
  // browser's native gesture handling (page pinch-zoom, edge-swipe
  // back/forward navigation, overscroll) ever claiming a gesture instead of
  // the page, independent of touch-action CSS or the per-element JS below.
  document.addEventListener('touchstart', e => {
    if (!wantsNativeScroll(e)) e.preventDefault();
    if (screensaverActive) {
      e.stopPropagation();
      exitScreensaver();
      return;
    }
    if (galleryEntered) resetIdleTimer();
    // Every touch is a valid user gesture — keep retrying fullscreen on
    // each one until it sticks, in case an earlier attempt (page load,
    // the very first splash tap) was rejected by this particular browser.
    tryEnterFullscreen();
  }, { capture: true, passive: false });

  // Same reasoning for touchmove: Chrome can mark a touchmove non-cancelable
  // if preventDefault() wasn't called on an earlier move in the same
  // gesture, so every touchmove is unconditionally prevented here, at the
  // earliest possible point (document, capture phase) — not just
  // multi-touch ones. Scrollable gallery surfaces are the sole exemption.
  document.addEventListener('touchmove', e => {
    if (!wantsNativeScroll(e)) e.preventDefault();
  }, { capture: true, passive: false });

  // WebKit-only pinch gesture events (Chrome never fires these, so this is
  // a no-op there, but it's a real vector on Safari-based kiosk browsers).
  document.addEventListener('gesturestart',  e => e.preventDefault());
  document.addEventListener('gesturechange', e => e.preventDefault());

  document.addEventListener('pointerdown', e => {
    if (e.pointerType === 'touch') return; // touch handled above
    if (screensaverActive) {
      e.preventDefault();
      e.stopPropagation();
      exitScreensaver();
      return;
    }
    if (galleryEntered) resetIdleTimer();
  }, { capture: true });

  /* ── Utility: dual touch+click binding for buttons ──────────────────────── */
  function addTap(el, fn) {
    el.addEventListener('touchstart', e => {
      e.stopPropagation();
      e.preventDefault();
      fn();
    }, { passive: false });
    el.addEventListener('click', fn);
  }

  /* ── QR code (links to the online gallery) ────────────────────────────── */
  function renderQrCode() {
    const badge = document.getElementById('qrBadge');
    if (!badge || typeof qrcode !== 'function') return;

    const qr = qrcode(0, 'M');
    /* One place decides where the wall's QR codes point: KIOSK_CONFIG.galleryUrl. */
    qr.addData((window.KIOSK_CONFIG && window.KIOSK_CONFIG.galleryUrl) || 'https://kattitude-flash-kiosk.vercel.app');
    qr.make();

    const count   = qr.getModuleCount();
    const svgNS   = 'http://www.w3.org/2000/svg';
    const svg     = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${count} ${count}`);
    svg.setAttribute('shape-rendering', 'crispEdges');

    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
      }
    }
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000000');
    svg.appendChild(path);
    badge.appendChild(svg);
  }

  /* ── Init ──────────────────────────────────────────────────────────────── */
  function init() {
    buildDots();
    renderQrCode();
    if (sheets.length) loadSheet(0, 'none');
    bindEventListeners();
    requestWakeLock();
    tryEnterFullscreen();
  }

  /* ── Dots ──────────────────────────────────────────────────────────────── */
  function buildDots() {
    dotsEl.innerHTML = '';
    sheets.forEach((_, i) => {
      const d = document.createElement('button');
      d.className = 'dot' + (i === 0 ? ' active' : '');
      d.setAttribute('aria-label', `Sheet ${i + 1}`);
      addTap(d, () => navigate(i));
      dotsEl.appendChild(d);
    });
  }

  function updateDots() {
    [...dotsEl.querySelectorAll('.dot')].forEach((d, i) =>
      d.classList.toggle('active', i === current));
  }

  /* ── Navigation ────────────────────────────────────────────────────────── */
  let navigating     = false;
  let loadGeneration = 0; // bumped on every loadSheet() call to cancel stale in-flight transitions

  function navigate(idx, dir) {
    if (idx < 0 || idx >= sheets.length || idx === current || navigating) return;
    loadSheet(idx, dir ?? (idx > current ? 'left' : 'right'));
  }

  function loadSheet(idx, direction) {
    const sheet = sheets[idx];
    const myGen = ++loadGeneration; // any earlier in-flight loadSheet's callbacks become no-ops

    if (direction === 'none') {
      img.src = sheet.file;
      current = idx;
      navigating = false;
      resetZoom();
      updateUI();
      return;
    }

    navigating = true;

    // Preload next image during slide-out
    const preload     = new Image();
    preload.src       = sheet.file;
    let preloadReady  = preload.complete && preload.naturalWidth > 0;
    let slideOutDone  = false;
    let started       = false;

    function trySlideIn() {
      if (myGen !== loadGeneration) return; // superseded by a newer load
      if (!slideOutDone || !preloadReady || started) return;
      started = true;
      doSlideIn();
    }

    // Slide current sheet out
    const sw   = stage.clientWidth;
    const outX = direction === 'left' ? -(sw + 40) : (sw + 40);
    stageInner.style.transition = `transform ${SLIDE_MS}ms ease-in`;
    stageInner.style.transform  = `translate(${outX}px, 0px) scale(${scale})`;

    setTimeout(() => { slideOutDone = true; trySlideIn(); }, SLIDE_MS + 30);

    if (!preloadReady) {
      preload.addEventListener('load',  () => { preloadReady = true; trySlideIn(); }, { once: true });
      preload.addEventListener('error', () => { preloadReady = true; trySlideIn(); }, { once: true });
      setTimeout(() => { if (!preloadReady) { preloadReady = true; trySlideIn(); } }, 2500);
    }

    function doSlideIn() {
      // Switch image source (cached — instantaneous)
      img.src = sheet.file;

      // Off-screen starting position at resting scale
      const startX = direction === 'left' ? (sw + 40) : -(sw + 40);

      stageInner.style.visibility = 'hidden';
      stageInner.style.transition = 'none';
      stageInner.style.transform  = `translate(${startX}px, 0px) scale(1)`;

      // Reset zoom/pan state
      scale = 1; tx = 0; ty = 0;
      isDragging = false; dragStart = null; swipeStart = null; lastPinchDist = 0; multiTouchDetected = false; trackedTouchId = null;
      current = idx;
      updateUI();

      // Force reflow
      stageInner.getBoundingClientRect();

      // Animate to resting position
      stageInner.style.visibility = 'visible';
      stageInner.style.transition = `transform ${SLIDE_MS}ms ease-out`;
      stageInner.style.transform  = 'translate(0px, 0px) scale(1)';

      function onDone() {
        if (myGen !== loadGeneration) return; // a newer load (e.g. a hard reset) already took over
        stageInner.style.transition = 'none';
        navigating = false;
      }
      stageInner.addEventListener('transitionend', onDone, { once: true });
      setTimeout(onDone, SLIDE_MS + 120);
    }
  }

  function updateUI() {
    sheetLabel.textContent = `SHEET ${current + 1} / ${sheets.length}`;
    btnPrev.classList.toggle('hidden', current === 0);
    btnNext.classList.toggle('hidden', current === sheets.length - 1);
    updateDots();
  }

  /* ── Zoom / Pan ────────────────────────────────────────────────────────── */

  /** Reset to resting state: scale(1) translate(0,0) */
  function resetZoom() {
    scale = 1;
    tx    = 0;
    ty    = 0;
    applyTransform(false);
  }

  function applyTransform(animate) {
    stageInner.style.transition = animate ? 'transform 0.25s ease-out' : 'none';
    stageInner.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
    clampPan();
    showZoomBadge();
  }

  function clampPan() {
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    // stage-inner is 100% of stage; at current scale its dimensions are:
    const iw = sw * scale;
    const ih = sh * scale;
    tx = iw <= sw ? 0 : Math.min(0, Math.max(sw - iw, tx));
    ty = ih <= sh ? 0 : Math.min(0, Math.max(sh - ih, ty));
    stageInner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function zoomAt(newScale, originX, originY) {
    newScale    = Math.max(MIN_SCALE, Math.min(MAX_SCALE, newScale));
    const ratio = newScale / scale;
    tx    = originX - ratio * (originX - tx);
    ty    = originY - ratio * (originY - ty);
    scale = newScale;
    clampPan();
    stageInner.style.transition = 'none';
    stageInner.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
    showZoomBadge();
  }

  function showZoomBadge() {
    if (!ZOOM_ON) return;
    zoomBadge.textContent = `${Math.round(scale * 100)}%`;
    zoomBadge.classList.add('visible');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => zoomBadge.classList.remove('visible'), 1400);
  }

  function isZoomed() { return scale > MIN_SCALE + 0.01; }

  /* ── Touch handlers (kiosk primary) ──────────────────────────────────────
   * Pinch-to-zoom is not supported here by design — only the finger that
   * STARTED the gesture is ever tracked, resolved by Touch.identifier (not
   * array position — the order of the `touches`/`changedTouches` lists is
   * implementation-defined, so a ghost/phantom contact, common on large
   * capacitive panels, could otherwise silently take over index 0 mid-
   * gesture and corrupt swipe tracking). Extra touch points are ignored for
   * driving the gesture, but multiTouchDetected remembers one joined at all,
   * so a real two-finger pinch attempt whose anchor finger barely moves
   * can't be misread as a stationary tap-to-zoom once everything lifts
   * (see onTouchEnd) — that would make pinch zoom by accident.
   *
   * The gesture resolves as soon as the TRACKED finger lifts — regardless
   * of whether some other (ghost) touch is still reported down — classified
   * by how far it travelled from touchstart:
   *   - <= TAP_MOVE_TOLERANCE and single-finger throughout -> tap -> toggle zoom
   *   - a real horizontal swipe (and not currently zoomed) -> navigate
   *   - anything else (e.g. a pan while zoomed, already applied live in
   *     onTouchMove, a multi-finger gesture, or a failed/ambiguous swipe
   *     attempt) -> no-op
   */
  function findTouch(touchList, id) {
    for (let i = 0; i < touchList.length; i++) {
      if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
  }

  function onTouchStart(e) {
    e.preventDefault();
    const t = e.touches;
    if (t.length === 0) return;

    if (dragStart) {
      if (t.length >= 2) multiTouchDetected = true; // extra finger joined — ignore it, but remember
      return;
    }

    isDragging     = false;
    multiTouchDetected = t.length >= 2;
    trackedTouchId = t[0].identifier;
    dragStart      = { x: t[0].clientX, y: t[0].clientY, tx, ty };
    swipeStart     = { x: t[0].clientX, y: t[0].clientY };
  }

  function onTouchMove(e) {
    e.preventDefault();
    if (!dragStart || trackedTouchId === null) return;
    const touch = findTouch(e.touches, trackedTouchId);
    if (!touch) return; // tracked finger not in this event (only a ghost/other touch moved)

    const dx = touch.clientX - dragStart.x;
    const dy = touch.clientY - dragStart.y;
    if (!isDragging && Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) isDragging = true;
    if (isDragging && isZoomed()) {
      tx = dragStart.tx + dx;
      ty = dragStart.ty + dy;
      clampPan();
      stageInner.style.transition = 'none';
      stageInner.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
    }
  }

  function onTouchEnd(e) {
    e.preventDefault();
    if (!dragStart || trackedTouchId === null) return;

    const ended = findTouch(e.changedTouches, trackedTouchId);
    if (!ended) return; // some other (ghost) touch ended; our tracked finger is still down

    if (swipeStart) {
      const dx = ended.clientX - swipeStart.x;
      const dy = ended.clientY - swipeStart.y;
      const moveDist = Math.hypot(dx, dy);

      if (moveDist <= TAP_MOVE_TOLERANCE && !multiTouchDetected) {
        handleTapZoom(ended.clientX, ended.clientY);
      } else if (!isZoomed() && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
        dx < 0 ? navigate(current + 1, 'left') : navigate(current - 1, 'right');
      }
    }

    isDragging         = false;
    dragStart          = null;
    swipeStart         = null;
    multiTouchDetected = false;
    trackedTouchId     = null;
  }

  /* ── Pointer handlers (mouse / desktop fallback — touch guarded) ─────────── */
  function onPointerDown(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      isDragging = false;
      dragStart  = { x: e.clientX, y: e.clientY, tx, ty };
      swipeStart = { x: e.clientX, y: e.clientY };
    }
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      lastPinchDist = dist(pts[0], pts[1]);
      isDragging = false; swipeStart = null;
    }
  }

  function onPointerMove(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2) {
      const pts  = [...pointers.values()];
      const d    = dist(pts[0], pts[1]);
      const m    = mid(pts[0], pts[1]);
      const rect = stage.getBoundingClientRect();
      if (lastPinchDist > 0) zoomAt(scale * (d / lastPinchDist), m.x - rect.left, m.y - rect.top);
      lastPinchDist = d;
      return;
    }

    if (pointers.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (!isDragging && Math.hypot(dx, dy) > TAP_MOVE_TOLERANCE) { isDragging = true; stage.classList.add('dragging'); }
      if (isDragging && isZoomed()) {
        tx = dragStart.tx + dx;
        ty = dragStart.ty + dy;
        clampPan();
        stageInner.style.transition = 'none';
        stageInner.style.transform  = `translate(${tx}px, ${ty}px) scale(${scale})`;
      }
    }
  }

  function onPointerUp(e) {
    if (e.pointerType === 'touch') return;
    e.preventDefault();
    const wasSingle = pointers.size === 1;
    const upX = e.clientX, upY = e.clientY;
    pointers.delete(e.pointerId);
    stage.classList.remove('dragging');

    if (pointers.size === 0 && wasSingle) {
      if (swipeStart) {
        const dx = upX - swipeStart.x;
        const dy = upY - swipeStart.y;
        const moveDist = Math.hypot(dx, dy);

        if (moveDist <= TAP_MOVE_TOLERANCE) {
          handleTapZoom(upX, upY);
        } else if (!isZoomed() && Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
          dx < 0 ? navigate(current + 1, 'left') : navigate(current - 1, 'right');
        }
      }
      isDragging = false; dragStart = null; swipeStart = null; lastPinchDist = 0;
    }
    if (pointers.size === 1) {
      const [ptr] = pointers.values();
      dragStart = { x: ptr.x, y: ptr.y, tx, ty };
      lastPinchDist = 0;
    }
  }

  /* ── Tap-to-zoom: tap a point to zoom in centered there, tap again to
   * zoom back out. Works on touch and mouse alike; pinch stays disabled. */
  function handleTapZoom(cx, cy) {
    const rect = stage.getBoundingClientRect();
    if (isZoomed()) {
      // Animate back to resting state
      scale = 1; tx = 0; ty = 0;
      applyTransform(true);
    } else {
      zoomAt(3, cx - rect.left, cy - rect.top);
    }
  }

  /* ── Helpers ────────────────────────────────────────────────────────────── */
  function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function mid(a, b)  { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

  /* ── Bind all event listeners ───────────────────────────────────────────── */
  function bindEventListeners() {
    addTap(btnPrev, () => navigate(current - 1));
    addTap(btnNext, () => navigate(current + 1));
    addTap(fsExitBtn, exitFS);

    // Only present when a sheet was opened from a gallery grid tile; CSS
    // keeps it hidden otherwise, so the sheets-only kiosk never shows it.
    const sheetBack = document.getElementById('sheetBackBtn');
    if (sheetBack) {
      addTap(sheetBack, () => {
        if (window.KIOSK_ROUTER && typeof window.KIOSK_ROUTER.leaveSheetViewer === 'function') {
          window.KIOSK_ROUTER.leaveSheetViewer();
        }
      });
    }

    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft')  navigate(current - 1);
      if (e.key === 'ArrowRight') navigate(current + 1);
      if (e.key === 'Escape' && isZoomed()) resetZoom();
    });

    // Stage — touch (primary)
    stage.addEventListener('touchstart',  onTouchStart,  { passive: false });
    stage.addEventListener('touchmove',   onTouchMove,   { passive: false });
    stage.addEventListener('touchend',    onTouchEnd,    { passive: false });
    stage.addEventListener('touchcancel', onTouchEnd,    { passive: false });

    // Stage — pointer (mouse fallback, touch guarded inside handlers)
    stage.addEventListener('pointerdown',   onPointerDown);
    stage.addEventListener('pointermove',   onPointerMove);
    stage.addEventListener('pointerup',     onPointerUp);
    stage.addEventListener('pointercancel', onPointerUp);

    // Wheel zoom (desktop preview only)
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      const rect  = stage.getBoundingClientRect();
      const delta = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      zoomAt(scale * delta, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });

    // On resize, reset to resting state if not zoomed
    window.addEventListener('resize', () => { if (!isZoomed()) resetZoom(); });
  }

  /* ── Public surface ──────────────────────────────────────────────────────
   * The gallery router drives this viewer for sheet browsing rather than
   * reimplementing it. Kept deliberately small: everything above — the touch
   * model, the ghost-contact handling, the slide transitions — stays private
   * and unchanged. */
  window.SheetViewer = {
    /* Replace the browsable set — e.g. only one artist's sheets. Pass nothing
     * to restore the full production list. Items need { title, file }. */
    setSheets(list) {
      sheets = (Array.isArray(list) && list.length) ? list : GALLERY_DATA.sheets;
      current = 0;
      buildDots();
      if (sheets.length) loadSheet(0, 'none');
    },
    openAt(idx) {
      if (!sheets.length) return;
      const i = Math.max(0, Math.min(sheets.length - 1, idx | 0));
      if (i === current) { resetZoom(); updateUI(); }
      else loadSheet(i, 'none');
    },
    get count() { return sheets.length; },
    get current() { return current; },
  };

  /* ── Start ──────────────────────────────────────────────────────────────── */
  init();

})();
