/* Kiosk artist headshots.
 *
 * Two jobs, both small:
 *
 *  1. Put the artist's face in the Follow panel, beside the QR. The panel is
 *     built inside gallery.js's artistPanel(); rather than reopen a 1700-line
 *     file to add twelve lines to it, this watches for the panel appearing
 *     and decorates it. That is a real trade and worth naming: it is a DOM
 *     hook, so if `.g-artistinfo` is ever renamed, the face silently stops
 *     appearing. It fails by doing nothing, which is the safe direction, and
 *     it lives in the repo (not in a frozen deployed base) so it is
 *     greppable. Folding it into gallery.js properly is a good follow-up for
 *     whoever next has that file open.
 *
 *  2. Guarantee the fallback. Every avatar renders initials FIRST and lays
 *     the photo on top, so a 404 or a dropped connection uncovers a monogram
 *     that was already painted. The kiosk must never show a broken image
 *     icon on a wall in a shop, and "no photo yet" is the normal state for
 *     most of the roster today.
 *
 * The artist-CARD avatars need nothing from this file: gallery.js already
 * renders `a.portrait` or initials, and catalog.js now points `portrait` at
 * the small derivative. avatars.css makes both circular.
 */
(function () {
  'use strict';

  function initials(name) {
    return String(name || '?')
      .trim().split(/\s+/).slice(0, 2)
      .map(s => s[0] || '').join('').toUpperCase() || '?';
  }

  /* The panel does not carry an artist id, so match on what it does show.
   * Handle first (unique by construction), name as the fallback. */
  function artistFor(panel) {
    const C = window.Catalog;
    if (!C || !C.artists) return null;
    const handleEl = panel.querySelector('.g-artistinfo-handle');
    const key = handleEl ? handleEl.textContent.trim() : '';
    if (!key) return null;
    const bare = key.replace(/^@/, '').toLowerCase();
    return C.artists.find(a =>
      (a.handle || '').replace(/^@/, '').toLowerCase() === bare ||
      (a.name || '').toLowerCase() === key.toLowerCase()) || null;
  }

  function decorate(panel) {
    if (panel.querySelector('.g-artistinfo-face')) return;   // already done
    const artist = artistFor(panel);
    if (!artist) return;

    const face = document.createElement('div');
    face.className = 'g-artistinfo-face';
    face.setAttribute('aria-hidden', 'true');   // the name is already read out

    const mono = document.createElement('span');
    mono.className = 'g-artistinfo-initials';
    mono.textContent = initials(artist.name);
    face.appendChild(mono);

    const src = artist.portrait || artist.portraitFull;
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.decoding = 'async';
      // Uncover the monogram rather than leaving a broken-image glyph.
      img.onerror = () => { img.remove(); };
      face.appendChild(img);
    }

    // Before the QR: face, then code, then words. Reading order matches the
    // order someone approaches it in.
    panel.insertBefore(face, panel.firstChild);
  }

  function sweep(root) {
    const panels = (root && root.querySelectorAll)
      ? root.querySelectorAll('.g-artistinfo') : [];
    for (let i = 0; i < panels.length; i++) {
      try { decorate(panels[i]); } catch (e) { /* never break the kiosk */ }
    }
  }

  function boot() {
    const host = document.getElementById('gallery');
    if (!host) return;

    sweep(host);

    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains('g-artistinfo')) {
            try { decorate(n); } catch (e) {}
          } else {
            sweep(n);
          }
        }
      }
    });
    obs.observe(host, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
