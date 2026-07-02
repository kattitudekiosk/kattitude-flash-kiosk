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
  const sheets = GALLERY_DATA.sheets;
  let current  = 0;

  // Resting state = scale 1, translate 0,0
  let scale = 1;
  let tx    = 0;
  let ty    = 0;
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;

  // Pinch-to-zoom is intentionally disabled on this kiosk (see onTouchStart) —
  // a stray second touch point (common on large capacitive panels) was being
  // misread as a pinch gesture mid-swipe, zooming instead of navigating.
  // Zoom is still reachable via double-tap. Swipe threshold raised so small
  // jitter during a real swipe can't be misread either.
  const SWIPE_THRESHOLD   = 90;   // px of horizontal travel required to trigger nav
  const SWIPE_ANGLE_RATIO = 1.5;  // horizontal travel must dominate vertical by this much

  // Sheet slide-out/slide-in transition duration — slowed down from the
  // original 280ms so the flip between flash sheets feels smoother on the
  // kiosk touchscreen instead of feeling abrupt.
  const SLIDE_MS = 450;

  // Screensaver: after IDLE_TIMEOUT_MS with no touch, auto-cycle through the
  // sheets (burn-in prevention). Any tap during the screensaver wakes the
  // kiosk back to the logo/splash page rather than just pausing on a sheet.
  const IDLE_TIMEOUT_MS         = 120000; // 2 minutes
  const SCREENSAVER_INTERVAL_MS = 8000;   // ms per sheet while cycling (8s)

  let isDragging    = false;
  let dragStart     = null;  // { x, y, tx, ty }
  let swipeStart    = null;  // { x, y }
  let lastPinchDist = 0;

  let lastTap    = 0;
  let lastTapPos = null;
  let badgeTimer = null;

  // Mouse/desktop only
  let pointers = new Map();

  // Screensaver / idle state
  let idleTimer         = null;
  let screensaverTimer  = null;
  let screensaverActive = false;

  /* ── Fullscreen ─────────────────────────────────────────────────────────── */
  function requestFS() {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fn) return Promise.resolve(fn.call(el)).catch(() => {});
    return Promise.resolve();
  }

  function exitFS() {
    const fn = document.exitFullscreen || document.webkitExitFullscreen;
    if (fn) fn.call(document);
  }

  function isFS() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  document.addEventListener('fullscreenchange',       () => document.body.classList.toggle('in-fullscreen', isFS()));
  document.addEventListener('webkitfullscreenchange', () => document.body.classList.toggle('in-fullscreen', isFS()));

  /* ── Splash ─────────────────────────────────────────────────────────────── */
  let galleryEntered = false;

  function enterGallery(e) {
    if (galleryEntered) return;
    galleryEntered = true;
    if (e && e.cancelable) e.preventDefault();
    requestFS();
    splash.classList.add('hidden');
    resetIdleTimer();
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
    screensaverActive = true;
    document.body.classList.add('screensaver');
    if (isZoomed()) resetZoom();

    screensaverTimer = setInterval(() => {
      navigate((current + 1) % sheets.length, 'left');
    }, SCREENSAVER_INTERVAL_MS);
  }

  function exitScreensaver() {
    if (!screensaverActive) return;
    screensaverActive = false;
    clearInterval(screensaverTimer);
    clearTimeout(idleTimer);
    document.body.classList.remove('screensaver');

    galleryEntered = false;
    if (current === 0) resetZoom(); else loadSheet(0, 'none');
    splash.classList.remove('hidden');
  }

  // Capture phase so this always sees a touch first, before any component
  // (nav buttons, dots, the stage's own drag/swipe handling) can act on it —
  // stopping propagation here fully consumes the "wake up" tap so it can't
  // simultaneously trigger navigation or zoom underneath.
  document.addEventListener('touchstart', e => {
    if (screensaverActive) {
      e.preventDefault();
      e.stopPropagation();
      exitScreensaver();
      return;
    }
    if (galleryEntered) resetIdleTimer();
  }, { capture: true, passive: false });

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
    qr.addData('https://flash-gallery.vercel.app');
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
    path.setAttribute('fill', '#1a1a1a');
    svg.appendChild(path);
    badge.appendChild(svg);
  }

  /* ── Init ──────────────────────────────────────────────────────────────── */
  function init() {
    buildDots();
    renderQrCode();
    loadSheet(0, 'none');
    bindEventListeners();
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
      isDragging = false; dragStart = null; swipeStart = null; lastPinchDist = 0;
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
    zoomBadge.textContent = `${Math.round(scale * 100)}%`;
    zoomBadge.classList.add('visible');
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => zoomBadge.classList.remove('visible'), 1400);
  }

  function isZoomed() { return scale > MIN_SCALE + 0.01; }

  /* ── Touch handlers (kiosk primary) ──────────────────────────────────────
   * Pinch-to-zoom is not supported here by design — only the FIRST touch
   * point of a gesture is ever tracked. Any extra/phantom touch points
   * (ghost contacts are common on large capacitive panels) are simply
   * ignored rather than being read as a second pinch finger, so they can
   * never hijack a swipe into a zoom. Zoom is still available via
   * double-tap.
   */
  function onTouchStart(e) {
    e.preventDefault();
    const t = e.touches;
    if (t.length === 0 || dragStart) return; // gesture already tracking a touch — ignore extra fingers

    isDragging = false;
    dragStart  = { x: t[0].clientX, y: t[0].clientY, tx, ty };
    swipeStart = { x: t[0].clientX, y: t[0].clientY };

    // Double-tap detection
    const now = Date.now();
    if (now - lastTap < 280 && lastTapPos) {
      const dx = t[0].clientX - lastTapPos.x;
      const dy = t[0].clientY - lastTapPos.y;
      if (Math.hypot(dx, dy) < 44) {
        handleDoubleTap(t[0].clientX, t[0].clientY);
        lastTap = 0; lastTapPos = null; return;
      }
    }
    lastTap    = now;
    lastTapPos = { x: t[0].clientX, y: t[0].clientY };
  }

  function onTouchMove(e) {
    e.preventDefault();
    const t = e.touches;
    if (t.length === 0 || !dragStart) return;

    // Always track touches[0] — the finger the gesture started with —
    // regardless of how many other fingers may also be on the glass.
    const dx = t[0].clientX - dragStart.x;
    const dy = t[0].clientY - dragStart.y;
    if (!isDragging && Math.hypot(dx, dy) > 6) isDragging = true;
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
    const t       = e.touches;
    const changed = e.changedTouches;

    if (t.length === 0) {
      if (swipeStart && !isZoomed() && changed.length > 0) {
        const dx = changed[0].clientX - swipeStart.x;
        const dy = changed[0].clientY - swipeStart.y;
        if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy) * SWIPE_ANGLE_RATIO) {
          dx < 0 ? navigate(current + 1, 'left') : navigate(current - 1, 'right');
        }
      }
      isDragging = false;
      dragStart  = null;
      swipeStart = null;
    }
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

      const now = Date.now();
      if (now - lastTap < 280 && lastTapPos) {
        const dx = e.clientX - lastTapPos.x;
        const dy = e.clientY - lastTapPos.y;
        if (Math.hypot(dx, dy) < 44) {
          handleDoubleTap(e.clientX, e.clientY);
          lastTap = 0; lastTapPos = null; return;
        }
      }
      lastTap    = now;
      lastTapPos = { x: e.clientX, y: e.clientY };
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
      if (!isDragging && Math.hypot(dx, dy) > 6) { isDragging = true; stage.classList.add('dragging'); }
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
      if (swipeStart && !isZoomed()) {
        const dx = upX - swipeStart.x;
        const dy = upY - swipeStart.y;
        if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.4) {
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

  /* ── Double-tap zoom ────────────────────────────────────────────────────── */
  function handleDoubleTap(cx, cy) {
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

  /* ── Start ──────────────────────────────────────────────────────────────── */
  init();

})();
