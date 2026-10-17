/* tools/verify-image-read.js — dashboard/image-read.js's fallback paths, in
 * headless Chrome (no network, no Supabase).
 *
 *  1. <img> refuses a file but createImageBitmap reads it → load() still
 *     returns a real <img> (the bitmap path).
 *  2. Both refuse a .heic → the HEIC message ("choose a JPEG or PNG").
 *  3. A browser with no WebP encoder (iOS: toBlob('image/webp') hands back a
 *     PNG) → encode() returns a REAL JPEG named jpg, never a PNG called webp.
 *  4. Over maxBytes at every quality → a readable "MB … limit" error.
 *  5. A real HEIC (Apple's encoder, via sips) in Chrome → the HEIC message.
 *
 *   PUPPETEER_NODE_MODULES=<dir>/node_modules node tools/verify-image-read.js
 *   VERIFY_IMAGE_READ_BROKEN=1   negative control: the bitmap fallback is
 *                                removed from image-read.js; must FAIL.
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const from = id => require(require.resolve(id, { paths: [process.env.PUPPETEER_NODE_MODULES || __dirname] }));
const puppeteer = from('puppeteer-core');
const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
setTimeout(() => { console.error('verify-image-read.js: timed out'); process.exit(2); }, 60000).unref();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

(async () => {
  let src = fs.readFileSync(path.join(ROOT, 'dashboard/image-read.js'), 'utf8');
  if (process.env.VERIFY_IMAGE_READ_BROKEN === '1') src = src.replace(/const r = await withTimeout\(viaBitmap\(file\)[^;]*;/, "throw new Error('no fallback');");
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-imgread-'));
  const png = path.join(TMP, 'a.png'), heic = path.join(TMP, 'a.heic');
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-z', '600', '800', path.join(ROOT, 'assets/brand/kattitude-logo-2026.png'), '--out', png], { stdio: 'ignore' });
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', png, '--out', heic], { stdio: 'ignore' });
  check('the sample is a real HEIC (ftyp heic box)', /ftyp(heic|mif1)/.test(fs.readFileSync(heic).slice(4, 12).toString()));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body></body>');
    await page.addScriptTag({ content: src });
    const b64 = f => fs.readFileSync(f).toString('base64');
    const r = await page.evaluate(async (pngB64, heicB64) => {
      const R = window.ImageRead, out = {};
      const file = (b64, name, type) => new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], name, { type });
      const RealImage = window.Image;
      // 1: <img> fails for blobs of the original file only; bitmap path succeeds.
      let firstUrl = null;
      window.Image = function () { const i = new RealImage(); const set = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src').set;
        Object.defineProperty(i, 'src', { set(v) { if (!firstUrl) { firstUrl = v; setTimeout(() => i.onerror && i.onerror(), 0); } else set.call(i, v); } }); return i; };
      try { const x = await R.load(file(pngB64, 'photo.heic', 'image/heic')); out.bitmap = { w: x.w, h: x.h, tag: x.img.tagName }; }
      catch (e) { out.bitmap = { error: e.message }; }
      window.Image = RealImage;
      // 2 + 5: a real HEIC in Chrome (which has no HEIC decoder).
      try { await R.load(file(heicB64, 'IMG_0001.HEIC', 'image/heic')); out.heic = 'opened'; } catch (e) { out.heic = e.message; }
      // 3: no WebP encoder, as on iOS.
      const c = document.createElement('canvas'); c.width = c.height = 64;
      const g = c.getContext('2d'); g.fillStyle = '#E91E8C'; g.fillRect(0, 0, 64, 64);
      const realToBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, q) { return realToBlob.call(this, cb, type === 'image/webp' ? 'image/png' : type, q); };
      const enc = await R.encode(c, {});
      const head = new Uint8Array(await enc.blob.slice(0, 3).arrayBuffer());
      out.ios = { type: enc.type, ext: enc.ext, blobType: enc.blob.type, jpegMagic: head[0] === 0xff && head[1] === 0xd8 };
      HTMLCanvasElement.prototype.toBlob = realToBlob;
      // 4: limit.
      try { await R.encode(c, { maxBytes: 10 }); out.limit = 'no error'; } catch (e) { out.limit = e.message; }
      return out;
    }, b64(png), b64(heic));
    check('<img> refuses, createImageBitmap reads it → a real <img> 800×600', r.bitmap.tag === 'IMG' && r.bitmap.w === 800 && r.bitmap.h === 600, JSON.stringify(r.bitmap));
    check('a real HEIC in Chrome → "HEIC … choose a JPEG or PNG"', /HEIC/.test(r.heic) && /JPEG or PNG/.test(r.heic), r.heic);
    check('no WebP encoder (iOS) → a real JPEG, typed and named jpg', r.ios.type === 'image/jpeg' && r.ios.ext === 'jpg' && r.ios.blobType === 'image/jpeg' && r.ios.jpegMagic, JSON.stringify(r.ios));
    check('over the size limit at every quality → "MB … limit" message', /MB limit/.test(r.limit), r.limit);
  } finally { await browser.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
