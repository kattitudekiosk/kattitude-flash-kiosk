/* Studio server — file storage on the Mac mini's disk
 *
 *   ~/Desktop/KIOSK MEDIA/<Artist>/Designs|Headshots/…  (see init() below)
 *
 * Same URL shape as Supabase Storage, so the dashboard's upload / list /
 * remove / getPublicUrl calls need no change:
 *
 *   PUT|POST /storage/v1/object/<bucket>/<path>     upload (x-upsert header)
 *   GET      /storage/v1/object/public/<bucket>/<path>
 *   POST     /storage/v1/object/list/<bucket>        { prefix, limit }
 *   DELETE   /storage/v1/object/<bucket>             { prefixes: [...] }
 *
 * SAFETY, because these files are served from the same origin as the
 * dashboard and the dashboard keeps its sign-in token in localStorage:
 *   - only media extensions are accepted, and the Content-Type served is
 *     decided by the extension, never by what the uploader claimed. An
 *     uploaded .html or .svg would be a script running as the dashboard.
 *   - every response carries nosniff and a sandbox CSP.
 *   - a path is a short list of plain segments: no "..", no leading "/",
 *     no backslashes, no dot-files. Resolved paths are re-checked to sit
 *     inside the bucket.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { httpError } = require('./db');
const { storageWrite, BUCKETS } = require('./policy');

/* WHERE FILES LIVE — Joshua, 2 Oct 2026: photos go in a Desktop folder named
 * "KIOSK MEDIA", one subfolder per artist, so the studio can see and back up
 * its own work in Finder:
 *
 *   ~/Desktop/KIOSK MEDIA/<Artist name>/Designs/…     flash bucket
 *   ~/Desktop/KIOSK MEDIA/<Artist name>/Headshots/…   avatars bucket
 *   ~/Desktop/KIOSK MEDIA/Flash Sales/…               sale-media bucket
 *
 * URLs stay keyed by artist ID (/storage/v1/object/public/flash/<id>/…), and
 * the ID is turned into the folder name on every request. Renaming an artist
 * renames their folder (renameArtistFolder) so nothing is orphaned. */
let MEDIA = null;
let artistName = () => null;
const SUB = { flash: 'Designs', avatars: 'Headshots' };

function folderName(name) {
  return String(name || '').replace(/[\/:\0]/g, '-').replace(/^\.+/, '').trim() || null;
}

function init(dataDir, opts) {
  opts = opts || {};
  MEDIA = opts.mediaDir || process.env.KT_MEDIA_DIR ||
    path.join(require('node:os').homedir(), 'Desktop', 'KIOSK MEDIA');
  if (opts.artistName) artistName = opts.artistName;
  fs.mkdirSync(path.join(MEDIA, 'Flash Sales'), { recursive: true });
}

/* Make sure every artist has their folder, so Kat sees all seven in Finder
 * before anybody uploads. */
function ensureArtistFolders(names) {
  for (const n of names) {
    const f = folderName(n);
    if (!f) continue;
    // Designs/ (work) and Headshots/ only. Sheets/ was retired 2 Oct 2026.
    for (const s of Object.values(SUB)) fs.mkdirSync(path.join(MEDIA, f, s), { recursive: true });
  }
}

function renameArtistFolder(oldName, newName) {
  const a = folderName(oldName), b = folderName(newName);
  if (!a || !b || a === b) return;
  const from = path.join(MEDIA, a), to = path.join(MEDIA, b);
  if (fs.existsSync(from) && !fs.existsSync(to)) fs.renameSync(from, to);
  else ensureArtistFolders([newName]);
}

/* bucket + object path → the real directory that holds it */
function bucketDir(bucket, firstSeg) {
  if (bucket === 'sale-media') return path.join(MEDIA, 'Flash Sales');
  const f = folderName(artistName(firstSeg));
  if (!f) throw httpError(404, 'No artist folder for that path', 'NoSuchKey');
  return path.join(MEDIA, f, SUB[bucket]);
}

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};
const MAX_BYTES = 80 * 1024 * 1024;   // a 4K phone video clip, with room

function safePath(bucket, p) {
  if (!BUCKETS[bucket]) throw httpError(404, 'Bucket not found', 'NoSuchBucket');
  const rel = String(p || '');
  const segs = rel.split('/');
  if (!rel || rel.length > 400 || segs.length > 6 ||
      segs.some(s => !s || s === '.' || s === '..' || s.startsWith('.') || !/^[A-Za-z0-9._-]+$/.test(s))) {
    throw httpError(400, 'Invalid file path', 'InvalidKey');
  }
  /* flash/<artist_id>/rest → KIOSK MEDIA/<Name>/Designs/rest; sale-media keeps
   * its sale-id folder inside Flash Sales. */
  const base = bucketDir(bucket, segs[0]);
  const rest = bucket === 'sale-media' ? segs : segs.slice(1);
  if (!rest.length) return base;
  const full = path.resolve(base, ...rest);
  if (!full.startsWith(path.resolve(base) + path.sep)) throw httpError(400, 'Invalid file path', 'InvalidKey');
  return full;
}

function typeOf(p) {
  const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1];
  return ext ? TYPES[ext.toLowerCase()] : undefined;
}

/* "/storage/v1/object/public/flash/a/b.webp" → true if that file is here. */
function existsPublicPath(urlPath) {
  const m = urlPath.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
  if (!m) return false;
  try { return fs.statSync(safePath(m[1], decodeURIComponent(m[2]))).isFile(); }
  catch (e) { return false; }
}

function upload(ctx, bucket, objectPath, buf, upsert) {
  const full = safePath(bucket, objectPath);
  storageWrite(ctx, bucket, objectPath);
  if (!typeOf(objectPath)) {
    throw httpError(415, 'Only photos and videos can be uploaded (jpg, png, webp, gif, heic, mp4, mov, webm)', 'InvalidMimeType');
  }
  if (buf.length > MAX_BYTES) throw httpError(413, 'File is too large', 'EntityTooLarge');
  if (!upsert && fs.existsSync(full)) throw httpError(409, 'The resource already exists', 'Duplicate');
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = full + '.part-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, full);           // atomic: a reader never sees half a file
  return { Key: bucket + '/' + objectPath, path: objectPath };
}

function list(ctx, bucket, prefix, limit) {
  if (!ctx.me) throw httpError(403, 'Sign in first', '42501');
  if (!BUCKETS[bucket]) throw httpError(404, 'Bucket not found', 'NoSuchBucket');
  if (!prefix) return [];
  let dir;
  try { dir = safePath(bucket, String(prefix).replace(/\/+$/, '')); } catch (e) { return []; }
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  return names.filter(d => !d.name.startsWith('.') && !d.name.includes('.part-'))
    .slice(0, Math.min(limit || 100, 1000))
    .map(d => {
      const st = fs.statSync(path.join(dir, d.name));
      return { name: d.name, id: d.isFile() ? d.name : null,
               updated_at: st.mtime.toISOString(),
               metadata: d.isFile() ? { size: st.size, mimetype: typeOf(d.name) || null } : null };
    });
}

function remove(ctx, bucket, paths) {
  const done = [];
  for (const p of (paths || [])) {
    const full = safePath(bucket, p);
    storageWrite(ctx, bucket, p);
    try { fs.unlinkSync(full); done.push({ name: p }); } catch (e) { /* already gone */ }
  }
  return done;
}

/* Public read. Returns { status, headers, file } for server.js to stream. */
function publicFile(bucket, objectPath) {
  let full;
  try { full = safePath(bucket, objectPath); } catch (e) { return { status: e.status || 400 }; }
  const type = typeOf(objectPath);
  let st;
  try { st = fs.statSync(full); } catch (e) { return { status: 404 }; }
  if (!st.isFile() || !type) return { status: 404 };
  return {
    status: 200, file: full, size: st.size,
    headers: {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      /* Revalidate rather than cache blind: an avatar is re-uploaded to a new
       * path today, but nothing stops a future upsert to the same one. An
       * If-None-Match round trip to localhost is free. */
      'Cache-Control': 'public, no-cache',
      ETag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
      'Last-Modified': st.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    },
  };
}

module.exports = { diskPath: safePath, init, ensureArtistFolders, renameArtistFolder, folderName, mediaDir: () => MEDIA, upload, list, remove, publicFile, existsPublicPath, typeOf, MAX_BYTES };
