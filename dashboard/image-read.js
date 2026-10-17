/* Reading and encoding photos picked on a phone.
 *
 * WHY THIS FILE EXISTS (17 Oct 2026). Miranda, on an iPhone in Chrome, picked
 * a profile photo from her camera roll and nothing happened — Supabase saw no
 * request at all. A photo she took with the camera from the same picker
 * worked. Three things were wrong, all before the upload:
 *
 *   1. A 4 MB cap on the FILE, checked before resizing. A camera-roll photo
 *      handed over by iOS is routinely bigger than that; the 1024×1024 we
 *      actually upload never is. Limits now apply to what is uploaded.
 *   2. The refusal was a toast drawn UNDER the photo sheet (z-index 50 vs
 *      900, and on a phone the sheet sits over the bottom of the screen
 *      where the toast is). So it was invisible. Callers now show every
 *      outcome inside the thing the artist is looking at.
 *   3. iOS cannot encode WebP from a canvas. toBlob('image/webp') quietly
 *      returns a PNG — Miranda's "avatar-….webp" is a 1.9 MB PNG. encode()
 *      below checks what it actually got and falls back.
 *
 * HEIC/HEIF: WebKit on iOS and macOS can usually decode them in an <img>;
 * desktop Chrome and Firefox cannot. load() tries an <img> with decode(),
 * then createImageBitmap, and only then gives up with a message that says
 * what to do. It never resolves to nothing and never hangs (timeout).
 */
window.ImageRead = (function () {
  'use strict';

  // iOS Safari refuses canvases over 16,777,216 px (4096²). Anything we draw
  // at full size is kept under it.
  const MAX_CANVAS_PX = 16777216;
  // A file this big is not a photo from a phone; decoding it would take the
  // tab down on an iPhone before it could say anything.
  const MAX_FILE_BYTES = 200 * 1024 * 1024;
  const TIMEOUT_MS = 30000;

  const HEIC_TYPE = /^image\/(heic|heif)(-sequence)?$/i;
  const HEIC_EXT = /\.(heic|heif|hif)$/i;

  const MSG = {
    none: 'No photo came through. Tap “Choose a photo” and pick it again.',
    empty: 'That photo is still downloading from iCloud. Open it in the Photos app ' +
           'so it finishes downloading, then choose it again — or pick a different one.',
    huge: 'That file is too big to open on a phone. Please choose a smaller JPEG or PNG.',
    heic: 'This photo is in Apple’s HEIC format, and this browser can’t open it. ' +
          'Please choose a JPEG or PNG instead, or try again in Safari.',
    bad: 'We couldn’t open that file as a picture. Please choose a JPEG or PNG photo.',
    slow: 'Opening that photo is taking too long. Please try again, or choose a JPEG or PNG.',
  };

  function isHeic(file) {
    return !!file && (HEIC_TYPE.test(file.type || '') || HEIC_EXT.test(file.name || ''));
  }

  function withTimeout(p, ms, msg) {
    let t;
    return Promise.race([
      p,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); }),
    ]).finally(() => clearTimeout(t));
  }

  function viaImg(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      let done = false;
      const ok = () => {
        if (done) return; done = true;
        if (!img.naturalWidth || !img.naturalHeight) reject(new Error('no pixels'));
        else resolve(img);
      };
      img.onload = () => {
        // decode() finishes the work WebKit defers; an image that "loads" but
        // cannot decode would otherwise fail later, inside drawImage, silently.
        if (img.decode) img.decode().then(ok, ok); else ok();
      };
      img.onerror = () => { if (!done) { done = true; reject(new Error('img error')); } };
      img.src = url;
    });
  }

  /* createImageBitmap can read some files <img> refuses. Its result is drawn
   * once into a JPEG so the rest of the code keeps working with a real
   * <img> (the crop preview needs a URL). */
  async function viaBitmap(file) {
    if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap');
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, Math.sqrt(MAX_CANVAS_PX / (bmp.width * bmp.height)));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.95));
    if (!blob) throw new Error('no blob');
    const url = URL.createObjectURL(blob);
    try { return { img: await viaImg(url), url }; }
    catch (e) { URL.revokeObjectURL(url); throw e; }
  }

  /**
   * Open a picked file as an <img>. Resolves { img, url, w, h, heic } or
   * rejects with an Error whose message is written for the artist.
   */
  async function load(file, opts) {
    const ms = (opts && opts.timeoutMs) || TIMEOUT_MS;
    if (!file) throw new Error(MSG.none);
    if (!file.size) throw new Error(MSG.empty);
    if (file.size > MAX_FILE_BYTES) throw new Error(MSG.huge);
    const heic = isHeic(file);

    const url = URL.createObjectURL(file);
    try {
      const img = await withTimeout(viaImg(url), ms, MSG.slow);
      return { img, url, w: img.naturalWidth, h: img.naturalHeight, heic };
    } catch (e) {
      URL.revokeObjectURL(url);
      if (e.message === MSG.slow) throw e;
    }
    try {
      const r = await withTimeout(viaBitmap(file), ms, MSG.slow);
      return { img: r.img, url: r.url, w: r.img.naturalWidth, h: r.img.naturalHeight, heic };
    } catch (e) {
      if (e.message === MSG.slow) throw e;
    }
    throw new Error(heic ? MSG.heic : MSG.bad);
  }

  function toBlob(canvas, type, q) {
    return new Promise(res => {
      try { canvas.toBlob(b => res(b || null), type, q); } catch (e) { res(null); }
    });
  }

  const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

  /**
   * Encode a canvas, honestly. Tries each type in `types` (default WebP then
   * JPEG) and keeps the first blob that really IS that type and is under
   * maxBytes, lowering quality for lossy types before moving on. Resolves
   * { blob, type, ext } or rejects with an artist-readable message.
   *
   * A JPEG has no transparency: callers that list it must have painted a
   * background first.
   */
  async function encode(canvas, opts) {
    const o = opts || {};
    const types = o.types || ['image/webp', 'image/jpeg'];
    const maxBytes = o.maxBytes || Infinity;
    const q0 = o.quality || 0.9;
    let smallest = null;
    for (const type of types) {
      const qs = type === 'image/png' ? [undefined] : [q0, 0.8, 0.7, 0.6];
      for (const q of qs) {
        const b = await toBlob(canvas, type, q);
        if (!b || (b.type && b.type !== type)) break;   // not supported here: next type
        if (!smallest || b.size < smallest.size) smallest = b;
        if (b.size <= maxBytes) return { blob: b, type, ext: EXT[type] };
      }
    }
    if (smallest) {
      throw new Error('This picture is still ' + (smallest.size / 1048576).toFixed(1) +
        ' MB after resizing, over the ' + (maxBytes / 1048576).toFixed(0) +
        ' MB limit. Please choose a smaller JPEG or PNG.');
    }
    throw new Error('This browser could not save the picture. Please try Safari or Chrome.');
  }

  /** A canvas at most MAX_CANVAS_PX, the image scaled into it (never up). */
  function fullCanvas(img, background) {
    const w = img.naturalWidth, h = img.naturalHeight;
    const k = Math.min(1, Math.sqrt(MAX_CANVAS_PX / (w * h)));
    const c = document.createElement('canvas');
    c.width = Math.round(w * k); c.height = Math.round(h * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  }

  return { load, encode, fullCanvas, isHeic, MSG, MAX_CANVAS_PX };
})();
