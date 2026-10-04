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
  const MAX_BYTES = 4 * 1024 * 1024;

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

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({ img, url });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
      img.src = url;
    });
  }

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

  function square(img, pan, size) {
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
    return new Promise(res => c.toBlob(res, 'image/webp', 0.88));
  }

  /* ── The confirm-the-crop sheet ─────────────────────────────────────── */

  /**
   * @param opts.artist   artists row being edited
   * @param opts.canEdit  false renders nothing (RLS would refuse anyway)
   * @param opts.onSaved  called with the updated row
   * @param opts.toast    optional (msg, kind) reporter
   */
  function edit(opts) {
    const artist = opts.artist;
    const say = opts.toast || function (m) { console.log(m); };

    const back = el('div', 'sheet-backdrop');
    const card = el('div', 'sheet-card');
    back.appendChild(card);

    card.appendChild(el('h2', null, 'Profile photo'));
    card.appendChild(el('p', 'muted',
      'This is the picture customers see beside your work. A square photo ' +
      'about 1024×1024 looks best. If yours is not square we will cut a ' +
      'square out of the middle — you will see exactly what we are ' +
      'keeping before anything is saved.'));

    const pickWrap = el('label', 'dropzone');
    pickWrap.innerHTML = '<strong>Choose a photo</strong><span>or drag one here</span>';
    const input = el('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp';
    input.hidden = true;
    pickWrap.appendChild(input);
    card.appendChild(pickWrap);

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

    const row = el('div', 'row sheet-actions');
    const save = el('button', 'btn btn-primary', 'Use this photo');
    save.disabled = true;
    const cancel = el('button', 'btn btn-quiet', 'Cancel');
    row.append(save, cancel);

    // Removing a photo is a real thing to want, and falling back to the
    // monogram is a supported state rather than a broken one.
    if (artist.portrait_url) {
      const clear = el('button', 'btn btn-quiet', 'Remove photo');
      clear.onclick = async () => {
        clear.disabled = true;
        try {
          await writeRow(artist.id, { portrait_url: null, portrait_thumb_url: null });
          say('Photo removed. Their initials show instead.');
          close();
          if (opts.onSaved) opts.onSaved({ portrait_url: null, portrait_thumb_url: null });
        } catch (e) {
          clear.disabled = false;
          say('Could not remove it: ' + e.message, 'error');
        }
      };
      row.appendChild(clear);
    }
    card.appendChild(row);

    let chosen = null;   // { img, url, file }

    function repaint() {
      if (!chosen) return;
      const r = cropRect(chosen.img, pan.value / 100);
      const scale = 320 / r.side;
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
      if (!file) return;
      if (file.size > MAX_BYTES) {
        say('That photo is over 4 MB. Try a smaller one.', 'error');
        return;
      }
      let info;
      try { info = await readImage(file); }
      catch (e) { say(e.message, 'error'); return; }

      if (chosen) URL.revokeObjectURL(chosen.url);
      chosen = { img: info.img, url: info.url, file };
      cropImg.src = info.url;
      preview.hidden = false;
      save.disabled = false;
      repaint();
    }

    input.onchange = () => take(input.files && input.files[0]);
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
      if (!chosen) return;
      save.disabled = true;
      save.textContent = 'Saving…';
      try {
        const patch = await upload(artist.id, chosen.img, pan.value / 100);
        say('Photo updated.');
        close();
        if (opts.onSaved) opts.onSaved(patch);
      } catch (e) {
        save.disabled = false;
        save.textContent = 'Use this photo';
        // The refusal an artist is most likely to hit is trying to change
        // somebody else's photo, and "row-level security" means nothing to
        // her. Translate it.
        const msg = /row-level security|violates|denied/i.test(e.message || '')
          ? 'You can only change your own photo. Ask Kat to change someone else’s.'
          : e.message;
        say('Could not save that: ' + msg, 'error');
      }
    };

    function close() {
      if (chosen) URL.revokeObjectURL(chosen.url);
      document.removeEventListener('keydown', onKey);
      back.remove();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    cancel.onclick = close;
    back.onclick = e => { if (e.target === back) close(); };
    document.addEventListener('keydown', onKey);

    document.body.appendChild(back);
    // Keyboard users land on the control that does the thing.
    setTimeout(() => pickWrap.focus && pickWrap.focus(), 0);
    return { close };
  }

  /* ── Writes ─────────────────────────────────────────────────────────── */

  async function upload(artistId, img, pan) {
    const sb = await window.DashClient.fresh();   // a token issued just now (see dash-client.js)
    if (!sb) throw new Error('Your sign-in has expired. Sign out, then sign in again with a new link.');

    const stamp = Date.now().toString(36);
    const bigPath = artistId + '/avatar-' + stamp + '.webp';
    const smallPath = artistId + '/avatar-' + stamp + '-sm.webp';

    const [big, small] = await Promise.all([
      square(img, pan, FULL),
      square(img, pan, SMALL),
    ]);
    if (!big || !small) throw new Error('This browser could not make a WebP. Try Safari or Chrome.');

    // Big first. If the small one fails there is a usable photo either way,
    // and the kiosk falls back to the full-size URL.
    await put(sb, bigPath, big);
    let smallUrl = null;
    try { await put(sb, smallPath, small); smallUrl = publicUrl(sb, smallPath); }
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

  async function put(sb, path, blob) {
    const { error } = await sb.storage.from(BUCKET)
      .upload(path, blob, { contentType: 'image/webp', upsert: true, cacheControl: '31536000' });
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
