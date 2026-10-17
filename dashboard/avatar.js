/* Profile photos.
 *
 * Headshots are NOT artwork, and that difference is the whole design here.
 *
 * Flash is refused when it is off-size (invariant 3) because cropping
 * someone's drawing destroys the thing they made. A headshot has no such
 * claim on its own framing — it is a picture OF a person, and every avatar
 * on the kiosk is a circle, so something has to decide what lands inside
 * that circle. So this file DOES crop to square, and then shows the artist
 * exactly what will be kept and makes them press a button before anything
 * is uploaded. Cropping is fine. Cropping silently is not.
 *
 * STORAGE: bucket `avatars`, path `<artist_id>/avatar-<stamp>.webp`. The
 * first path segment is the authorization check — the bucket's policies let
 * an artist write only inside their own folder, and let an admin write
 * anywhere. That is enforced in Postgres, not here; this file only decides
 * what to show.
 *
 * Two objects are written per save:
 *   avatar-<stamp>.webp     1024x1024  profile + dashboard
 *   avatar-<stamp>-sm.webp   256x256   kiosk grid, artist cards, Follow panel
 *
 * The name carries a timestamp rather than being overwritten, because a
 * public bucket sits behind a CDN and an artist who changes her photo should
 * not have to explain why the old one is still on the wall.
 */
window.AvatarKit = (function () {
  'use strict';

  const cfg = window.DASH_CONFIG;
  const BUCKET = 'avatars';
  const FULL = 1024;
  const SMALL = 256;
  // The avatars bucket refuses anything over 5 MB. That limit is checked on
  // what we UPLOAD (a 1024×1024 square), never on the file the phone hands
  // over — the old 4 MB cap on the picked file is what turned away every
  // camera-roll photo on iPhone (17 Oct 2026). See image-read.js.
  const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 - 64 * 1024;
  const UPLOAD_TIMEOUT_MS = 90000;
  const SAVED_MSG = 'Photo saved — it’ll show on the wall within the hour.';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ── The fallback ───────────────────────────────────────────────────────
   * Generated from the name, so it always exists and can never 404. The
   * kiosk must never show a broken image, and "no photo yet" is the normal
   * state for most of the roster today. */
  function initials(name) {
    return String(name || '?')
      .trim().split(/\s+/).slice(0, 2)
      .map(s => s[0] || '').join('').toUpperCase() || '?';
  }

  /**
   * A circle avatar element.
   * @param artist  row with { name, portrait_thumb_url, portrait_url }
   * @param size    'sm' | 'md' | 'lg'
   */
  function node(artist, size) {
    const a = artist || {};
    const wrap = el('span', 'avatar avatar-' + (size || 'md'));
    const src = a.portrait_thumb_url || a.portrait_url;

    // Initials are rendered FIRST and the image sits on top. If the image
    // 404s or the network is out, removing it uncovers a face that was
    // already there — there is no frame in which this is a broken icon.
    wrap.appendChild(el('span', 'avatar-initials', initials(a.name)));

    if (src) {
      const img = el('img', 'avatar-img');
      img.src = src;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.onerror = () => { img.remove(); };
      wrap.appendChild(img);
    }
    return wrap;
  }

  /* ── Image work ─────────────────────────────────────────────────────── */

  /**
   * Centre-crop to a square, offset along the long axis by `pan` (0..1).
   * pan 0.5 is dead centre, which is the default and is right most of the
   * time; the slider exists for the portrait where the face is not.
   */
  function cropRect(img, pan) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const side = Math.min(w, h);
    const p = Math.min(1, Math.max(0, pan == null ? 0.5 : pan));
    return {
      sx: (w > h) ? (w - side) * p : 0,
      sy: (h > w) ? (h - side) * p : 0,
      side,
    };
  }

  async function square(img, pan, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    // White under the crop: a transparent PNG headshot on a white card is
    // fine, but the same file over the kiosk's dark artist card is a hole.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    const r = cropRect(img, pan);
    ctx.drawImage(img, r.sx, r.sy, r.side, r.side, 0, 0, size, size);
    // WebP where the browser can make one, JPEG where it cannot (iOS) —
    // the white fill above is what makes JPEG safe here.
    return window.ImageRead.encode(c, { quality: 0.88, maxBytes: MAX_UPLOAD_BYTES });
  }

  function withTimeout(p, ms) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(
      'The upload is taking too long. Check your Wi-Fi or signal and tap “Use this photo” again.')), ms); })])
      .finally(() => clearTimeout(t));
  }

  /* ── The confirm-the-crop sheet ─────────────────────────────────────── */

  /**
   * @param opts.artist   artists row being edited
   * @param opts.canEdit  false renders nothing (RLS would refuse anyway)
   * @param opts.onSaved  called with the updated row
   * @param opts.toast    optional (msg, kind) reporter
   *
   * EVERY OUTCOME IS SHOWN IN THE SHEET ITSELF (17 Oct 2026). The toast sits
   * under this sheet, so anything said only there is said to nobody. The
   * status line below is the one place this sheet reports: opening,
   * uploading, saved, or what went wrong and what to do. Nothing here closes
   * the sheet except Cancel / Done / Escape — never a stray tap, never an
   * error.
   */
  function edit(opts) {
    const artist = opts.artist;
    const say = opts.toast || function (m) { console.log(m); };

    const back = el('div', 'sheet-backdrop');
    const card = el('div', 'sheet-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Profile photo');
    back.appendChild(card);

    card.appendChild(el('h2', null, 'Profile photo'));
    const intro = el('p', 'muted',
      'This is the picture customers see beside your work. A square photo ' +
      'about 1024×1024 looks best. If yours is not square we will cut a ' +
      'square out of the middle — you will see exactly what we are ' +
      'keeping before anything is saved.');
    card.appendChild(intro);

    const pickWrap = el('label', 'dropzone');
    const pickTitle = el('strong', null, 'Choose a photo');
    pickWrap.append(pickTitle, el('span', null, 'from your camera roll, or take one'));
    const input = el('input');
    input.type = 'file';
    // image/* — a narrower list makes iOS convert or refuse camera-roll
    // photos in ways that differ between Safari and Chrome. HEIC is handled
    // (or plainly refused) by ImageRead.load.
    input.accept = 'image/*';
    input.hidden = true;
    pickWrap.appendChild(input);
    card.appendChild(pickWrap);

    // The one status line. aria-live so a screen reader hears it too.
    const status = el('div', 'upl-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    card.appendChild(status);

    const preview = el('div', 'crop');
    preview.hidden = true;
    const cropBox = el('div', 'crop-box');
    const cropImg = el('img', 'crop-img');
    cropBox.appendChild(cropImg);
    cropBox.appendChild(el('div', 'crop-ring'));
    preview.appendChild(cropBox);

    const panLabel = el('label', 'field');
    panLabel.appendChild(el('span', 'muted small', 'Move the photo'));
    const pan = el('input', 'input');
    pan.type = 'range'; pan.min = '0'; pan.max = '100'; pan.value = '50';
    panLabel.appendChild(pan);
    preview.appendChild(panLabel);

    const note = el('p', 'muted small');
    preview.appendChild(note);
    card.appendChild(preview);

    // After a save: the new photo, fetched from where the wall will fetch it.
    const savedView = el('div', 'saved-photo');
    savedView.hidden = true;
    card.appendChild(savedView);

    const row = el('div', 'row sheet-actions');
    const save = el('button', 'btn btn-primary', 'Use this photo');
    save.type = 'button';
    save.disabled = true;
    const cancel = el('button', 'btn btn-quiet', 'Cancel');
    cancel.type = 'button';
    row.append(save, cancel);

    // Removing a photo is a real thing to want, and falling back to the
    // monogram is a supported state rather than a broken one.
    let clear = null;
    if (artist.portrait_url) {
      clear = el('button', 'btn btn-quiet', 'Remove photo');
      clear.type = 'button';
      clear.onclick = async () => {
        setBusy(true);
        show('busy', 'Removing your photo…');
        try {
          await writeRow(artist.id, { portrait_url: null, portrait_thumb_url: null });
          say('Photo removed. Your initials show instead.');
          if (opts.onSaved) opts.onSaved({ portrait_url: null, portrait_thumb_url: null });
          close();
        } catch (e) {
          setBusy(false);
          show('error', 'Could not remove it: ' + plain(e) + ' Please try again.');
        }
      };
      row.appendChild(clear);
    }
    card.appendChild(row);

    let chosen = null;   // { img, url, file }
    let busy = false;

    function show(kind, msg) {
      status.hidden = false;
      status.className = 'upl-status upl-' + kind;
      status.innerHTML = '';
      if (kind === 'busy') status.appendChild(el('span', 'spinner'));
      if (kind === 'ok') status.appendChild(el('span', 'upl-mark', '✓'));
      if (kind === 'error') status.appendChild(el('span', 'upl-mark', '!'));
      status.appendChild(el('span', 'upl-text', msg));
      status.dataset.state = kind;
      // On a phone the sheet can be taller than the screen; the message is
      // useless if it is below the fold.
      if (status.scrollIntoView) { try { status.scrollIntoView({ block: 'nearest' }); } catch (e) {} }
    }
    function hideStatus() { status.hidden = true; status.dataset.state = ''; }

    function setBusy(on) {
      busy = on;
      save.disabled = on || !chosen;
      cancel.disabled = on;
      if (clear) clear.disabled = on;
      input.disabled = on;
      pickWrap.classList.toggle('is-disabled', on);
    }

    function repaint() {
      if (!chosen) return;
      const r = cropRect(chosen.img, pan.value / 100);
      const box = cropBox.clientWidth || 320;   // max-width: 100% on a narrow phone
      const scale = box / r.side;
      cropImg.style.width = (chosen.img.naturalWidth * scale) + 'px';
      cropImg.style.height = (chosen.img.naturalHeight * scale) + 'px';
      cropImg.style.left = (-r.sx * scale) + 'px';
      cropImg.style.top = (-r.sy * scale) + 'px';

      const isSquare = chosen.img.naturalWidth === chosen.img.naturalHeight;
      note.textContent = isSquare
        ? 'Already square — nothing will be cut off.'
        : 'Only what is inside the circle is kept. Drag the slider if the ' +
          'face is not centred.';
      pan.disabled = isSquare;
    }
    pan.oninput = repaint;

    async function take(file) {
      if (busy) return;
      if (!file) { show('error', window.ImageRead.MSG.none); return; }
      setBusy(true);
      show('busy', 'Opening your photo…');
      let info;
      try { info = await window.ImageRead.load(file); }
      catch (e) {
        setBusy(false);
        show('error', e.message);
        return;
      }
      if (chosen) URL.revokeObjectURL(chosen.url);
      chosen = { img: info.img, url: info.url, file };
      cropImg.src = info.url;
      preview.hidden = false;
      savedView.hidden = true;
      pickTitle.textContent = 'Choose a different photo';
      setBusy(false);
      hideStatus();
      repaint();
      // Layout settles after the preview is shown; size the crop to it.
      requestAnimationFrame(repaint);
    }

    input.onchange = () => {
      const f = input.files && input.files[0];
      input.value = '';   // picking the same photo again must fire change again
      take(f);
    };
    ;['dragover', 'dragenter'].forEach(ev => pickWrap.addEventListener(ev, e => {
      e.preventDefault(); pickWrap.classList.add('is-over');
    }));
    ;['dragleave', 'drop'].forEach(ev => pickWrap.addEventListener(ev, e => {
      e.preventDefault(); pickWrap.classList.remove('is-over');
    }));
    pickWrap.addEventListener('drop', e => {
      if (e.dataTransfer && e.dataTransfer.files) take(e.dataTransfer.files[0]);
    });

    save.onclick = async () => {
      if (!chosen || busy) return;
      setBusy(true);
      save.textContent = 'Uploading…';
      show('busy', 'Uploading your photo…');
      try {
        const patch = await withTimeout(upload(artist.id, chosen.img, pan.value / 100), UPLOAD_TIMEOUT_MS);
        if (opts.onSaved) opts.onSaved(patch);
        say(SAVED_MSG);
        showSaved(patch);
      } catch (e) {
        setBusy(false);
        save.textContent = 'Use this photo';
        // The refusal an artist is most likely to hit is trying to change
        // somebody else's photo, and "row-level security" means nothing to
        // her. Translate it.
        const raw = (e && e.message) || '';
        const msg = /row-level security|violates|denied|unauthori[sz]ed|403/i.test(raw)
          ? 'You can only change your own photo. Ask Kat to change someone else’s.'
          : /fetch|network|load failed/i.test(raw)
            ? 'The upload didn’t reach the server. Check your Wi-Fi or signal and tap “Use this photo” again.'
            : plain(e) + ' Tap “Use this photo” to try again, or choose a different photo.';
        show('error', 'Your photo was not saved. ' + msg);
      }
    };

    function showSaved(patch) {
      chosen && URL.revokeObjectURL(chosen.url);
      chosen = null;
      preview.hidden = true;
      // .dropzone sets display, which beats [hidden]; say it outright.
      pickWrap.style.display = 'none';
      intro.hidden = true;
      savedView.hidden = false;
      savedView.innerHTML = '';
      // Cache-busted on purpose: this proves the file is really there, as
      // the wall will see it, not a copy the browser kept.
      const img = el('img', 'saved-img');
      img.alt = 'Your new profile photo';
      img.src = patch.portrait_url + (patch.portrait_url.indexOf('?') === -1 ? '?' : '&') + 'v=' + Date.now();
      savedView.appendChild(img);
      show('ok', SAVED_MSG);
      save.hidden = true;
      if (clear) clear.hidden = true;
      cancel.disabled = false;
      cancel.textContent = 'Done';
      cancel.classList.remove('btn-quiet');
      cancel.classList.add('btn-primary');
      busy = false;
      cancel.focus && cancel.focus();
    }

    function close() {
      if (chosen) URL.revokeObjectURL(chosen.url);
      document.removeEventListener('keydown', onKey);
      back.remove();
    }
    function onKey(e) { if (e.key === 'Escape' && !busy) close(); }

    cancel.onclick = () => { if (!busy) close(); };
    // No close on a backdrop tap. On iOS the photo picker can hand a tap back
    // to the page as it dismisses, and that tap landed on the backdrop — the
    // sheet vanished with the photo half-read. Cancel and Done are the exits.
    document.addEventListener('keydown', onKey);

    document.body.appendChild(back);
    // Keyboard users land on the control that does the thing.
    setTimeout(() => pickWrap.focus && pickWrap.focus(), 0);
    return { close, take, _status: status };
  }

  function plain(e) {
    const m = (e && e.message) || String(e || 'Something went wrong.');
    return /[.!?]$/.test(m) ? m : m + '.';
  }

  /* ── Writes ─────────────────────────────────────────────────────────── */

  async function upload(artistId, img, pan) {
    const sb = await window.DashClient.fresh();   // a token issued just now (see dash-client.js)
    if (!sb) throw new Error('Your sign-in has expired. Sign out, then sign in again with a new link.');

    const [big, small] = await Promise.all([
      square(img, pan, FULL),
      square(img, pan, SMALL),
    ]);

    // The extension follows what was really encoded: WebP on most browsers,
    // JPEG on iOS, which cannot make WebP (and used to upload a PNG named
    // .webp). The sync and the kiosk take any of the three.
    const stamp = Date.now().toString(36);
    const bigPath = artistId + '/avatar-' + stamp + '.' + big.ext;
    const smallPath = artistId + '/avatar-' + stamp + '-sm.' + small.ext;

    // Big first. If the small one fails there is a usable photo either way,
    // and the kiosk falls back to the full-size URL.
    await put(sb, bigPath, big.blob, big.type);
    let smallUrl = null;
    try { await put(sb, smallPath, small.blob, small.type); smallUrl = publicUrl(sb, smallPath); }
    catch (e) { console.warn('thumbnail failed, using full size', e); }

    const patch = {
      portrait_url: publicUrl(sb, bigPath),
      portrait_thumb_url: smallUrl,
    };
    await writeRow(artistId, patch);

    // Best effort tidy-up of the previous photo. A failure here is invisible
    // and harmless — the row already points at the new file.
    tidy(sb, artistId, [bigPath, smallPath]);

    return patch;
  }

  async function put(sb, path, blob, type) {
    const { error } = await sb.storage.from(BUCKET)
      .upload(path, blob, { contentType: type, upsert: true, cacheControl: '31536000' });
    if (error) throw error;
  }

  function publicUrl(sb, path) {
    return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  async function writeRow(artistId, patch) {
    const sb = await window.DashClient.client();
    if (!sb) throw new Error('You are signed out. Sign in again and retry.');
    const { error } = await sb.from('artists').update(patch).eq('id', artistId);
    if (error) throw error;
  }

  async function tidy(sb, artistId, keep) {
    try {
      const { data } = await sb.storage.from(BUCKET).list(artistId, { limit: 100 });
      const stale = (data || [])
        .map(f => artistId + '/' + f.name)
        .filter(p => keep.indexOf(p) === -1);
      if (stale.length) await sb.storage.from(BUCKET).remove(stale);
    } catch (e) { /* nothing depends on this */ }
  }

  return { initials, node, edit, _cropRect: cropRect };
})();
