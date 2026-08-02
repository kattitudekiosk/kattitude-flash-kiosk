/* Attract loop — a single reel of video clips and flash stills interleaved.
 *
 * ── The rule that governs this file ────────────────────────────────────────
 * With zero video clips it does not run AT ALL. script.js keeps its original
 * sheet-cycling screensaver and this module reports `false` from start(), so
 * the behaviour on the wall today is not merely preserved, it is literally
 * the same code path. Everything here is additive on top of something that
 * already works, which is the same discipline the gallery follows with the
 * sheets-only fallback.
 *
 * ── Why the video is played from a Blob ────────────────────────────────────
 * A looping <video> pointed at a URL may re-request its media. Safari in
 * particular re-issues Range requests, and whether it does is a cache
 * heuristic, not a guarantee. On a kiosk that idles for hours this is the
 * difference between ~2.7 GB of egress a month and ~540 GB — a 200x error
 * that would be completely silent until the bill arrived.
 *
 * So the clip is fetched exactly once, kept in Cache Storage so it survives a
 * reload or a reboot, and played from an in-memory object URL. A <video>
 * pointed at a blob physically cannot issue a network request, however many
 * times it loops. That is a structural guarantee rather than a hopeful header.
 *
 * netFetches() exposes the observed count so a test can assert it stays at 1.
 */
window.Screensaver = (function () {
  'use strict';

  const cfg = (window.KIOSK_CONFIG && window.KIOSK_CONFIG.screensaver) || {};
  const STILL_MS      = cfg.stillMs || 8000;
  const MAX_CLIP_MS   = cfg.maxClipMs || 45000;
  const STILLS_PER_CLIP = Math.max(1, cfg.stillsPerClip || 4);
  const FADE_MS       = cfg.fadeMs || 600;
  const CACHE_NAME    = 'kattitude-attract-v1';

  let layerA = null, layerB = null, stageEl = null;
  let front = null, back = null;
  let playlist = [];
  let pos = 0;
  let timer = null;
  let active = false;
  let onExit = null;

  /* Clips that failed to load. A dead clip is skipped for the rest of the
   * session rather than retried every cycle — a 404 in a loop would hammer
   * the network all night, which is the thing we are here to prevent. */
  const dead = new Set();
  const blobs = new Map();   // url -> object URL
  let observedFetches = 0;

  /* ── Instrumentation ───────────────────────────────────────────────────── */
  if (typeof PerformanceObserver === 'function') {
    try {
      new PerformanceObserver(list => {
        list.getEntries().forEach(e => {
          if (/\.(mp4|webm|mov)(\?|$)/i.test(e.name)) observedFetches++;
        });
      }).observe({ type: 'resource', buffered: true });
    } catch (err) { /* older engines — instrumentation only, never fatal */ }
  }

  function clips() {
    const list = (window.Catalog && window.Catalog.screensaverClips
      && window.Catalog.screensaverClips()) || cfg.clips || [];
    return list.filter(c => c && c.url && !dead.has(c.url));
  }

  /* Stills come from the catalog when it has content, and from the raw sheet
   * list otherwise. The studio has 4 sheets and no singles today, so the
   * second branch is the live one. */
  function stills() {
    const src = cfg.source || 'all';
    let items = [];
    if (window.Catalog && window.Catalog.query) {
      const types = src === 'sheets' ? ['sheet'] : null;
      items = window.Catalog.query({ types: types })
        .filter(i => src !== 'featured' || i.featured)
        .map(i => ({ image: i.image || i.thumb, title: i.title }));
    }
    if (!items.length && window.GALLERY_DATA && window.GALLERY_DATA.sheets) {
      items = window.GALLERY_DATA.sheets.map(s => ({ image: s.file, title: s.title }));
    }
    return items.filter(i => i.image);
  }

  /**
   * Weave the two together: one clip, then STILLS_PER_CLIP stills, repeat.
   * Runs until every still has been shown at least once, so nothing in the
   * catalog is silently left out of the loop, and the clips cycle round as
   * often as they need to.
   */
  function buildPlaylist() {
    const v = clips(), s = stills();
    if (!v.length || !s.length) return [];

    const out = [];
    let vi = 0, si = 0;
    while (si < s.length) {
      out.push({ kind: 'video', clip: v[vi % v.length] });
      vi++;
      for (let k = 0; k < STILLS_PER_CLIP && si < s.length; k++, si++) {
        out.push({ kind: 'still', still: s[si] });
      }
    }
    return out;
  }

  /* ── Media loading ─────────────────────────────────────────────────────── */
  function cachedBlobUrl(url) {
    if (blobs.has(url)) return Promise.resolve(blobs.get(url));
    const put = blob => {
      const obj = URL.createObjectURL(blob);
      blobs.set(url, obj);
      return obj;
    };
    if (!('caches' in window)) {
      return fetch(url).then(r => r.ok ? r.blob() : Promise.reject(new Error('HTTP ' + r.status))).then(put);
    }
    return caches.open(CACHE_NAME)
      .then(cache => cache.match(url).then(hit => {
        if (hit) return hit.blob().then(put);
        return fetch(url).then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          // Cache a clone so the bytes survive a reload; a kiosk restart
          // should not re-download 90MB.
          return cache.put(url, r.clone()).catch(() => {}).then(() => r.blob()).then(put);
        });
      }));
  }

  function preloadStill(item) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = img.onerror = () => resolve();
      img.src = item.still.image;
    });
  }

  function prepare(item) {
    if (!item) return Promise.resolve();
    if (item.kind === 'still') return preloadStill(item);
    return cachedBlobUrl(item.clip.url).then(
      obj => { item.objectUrl = obj; },
      err => {
        console.log('[attract] clip unavailable, skipping for this session:',
          item.clip.url, err && err.message);
        dead.add(item.clip.url);
        item.failed = true;
      });
  }

  /* ── Rendering ─────────────────────────────────────────────────────────── */
  function buildLayers(host) {
    stageEl = document.createElement('div');
    stageEl.className = 'attract-stage';
    layerA = document.createElement('div'); layerA.className = 'attract-layer is-front';
    layerB = document.createElement('div'); layerB.className = 'attract-layer';
    stageEl.appendChild(layerA); stageEl.appendChild(layerB);
    host.appendChild(stageEl);
    front = layerA; back = layerB;
  }

  function fill(layer, item) {
    while (layer.firstChild) layer.removeChild(layer.firstChild);
    if (item.kind === 'still') {
      const img = document.createElement('img');
      img.className = 'attract-media';
      img.src = item.still.image;
      layer.appendChild(img);
      return Promise.resolve(null);
    }
    const v = document.createElement('video');
    v.className = 'attract-media';
    v.muted = true;            // required for autoplay, and correct in a shop
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('muted', '');
    v.loop = false;            // the PLAYLIST loops, not the individual clip
    v.preload = 'auto';
    v.src = item.objectUrl;
    layer.appendChild(v);
    return v.play().catch(() => null).then(() => v);
  }

  /* Crossfade. The outgoing layer is never emptied until the incoming one has
   * painted — tearing down first is what produces the black flash between
   * items, and on a wall panel that reads as a fault. */
  function swap() {
    front.classList.remove('is-front');
    back.classList.add('is-front');
    const t = front; front = back; back = t;
  }

  function step() {
    if (!active || !playlist.length) return;

    const item = playlist[pos % playlist.length];
    pos++;

    if (item.failed) { step(); return; }   // dead clip — move on immediately

    fill(back, item).then(videoEl => {
      swap();

      // Get the NEXT item ready while this one plays, so the loop never
      // stalls on a decode or a cold image.
      const next = playlist[pos % playlist.length];
      prepare(next);

      clearTimeout(timer);
      if (item.kind === 'video' && videoEl) {
        let advanced = false;
        const go = () => { if (!advanced) { advanced = true; step(); } };
        videoEl.onended = go;
        // A clip that stalls, or one longer than the cap, must not own the
        // screen indefinitely.
        const dur = isFinite(videoEl.duration) && videoEl.duration > 0
          ? Math.min(videoEl.duration * 1000 + 250, MAX_CLIP_MS)
          : MAX_CLIP_MS;
        timer = setTimeout(go, dur);
      } else {
        timer = setTimeout(step, STILL_MS);
      }
    });
  }

  /* ── Public API ────────────────────────────────────────────────────────── */
  return {
    /**
     * Returns false if there is nothing to play, which is the signal for
     * script.js to run its original sheet cycle untouched.
     */
    start(host, exitFn) {
      if (active) return true;
      playlist = buildPlaylist();
      if (!playlist.length) return false;

      onExit = exitFn || null;
      active = true;
      pos = 0;
      if (!stageEl) buildLayers(host || document.body);
      stageEl.style.display = 'block';
      document.body.classList.add('attract');

      // First item ready before anything is shown — no blank frame on entry.
      const first = playlist[0];
      prepare(first).then(() => { if (active) step(); });
      return true;
    },

    stop() {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      document.body.classList.remove('attract');
      if (stageEl) {
        stageEl.style.display = 'none';
        [layerA, layerB].forEach(l => {
          const v = l && l.querySelector('video');
          if (v) { try { v.pause(); } catch (e) {} }
          while (l && l.firstChild) l.removeChild(l.firstChild);
        });
      }
      if (onExit) { const f = onExit; onExit = null; f(); }
    },

    isActive() { return active; },
    hasClips() { return clips().length > 0; },
    playlistLength() { return buildPlaylist().length; },
    /* Must stay at one per distinct clip no matter how long the loop runs.
     * If this climbs, the blob path has been bypassed and egress is leaking. */
    netFetches() { return observedFetches; },
    _playlist() { return buildPlaylist(); },
  };
})();
