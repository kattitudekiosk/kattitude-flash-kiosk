#!/usr/bin/env node
/* Studio server — verification
 *
 *   node server/test.js
 *
 * Boots a real server on a throwaway data directory and a random port, and
 * drives it over HTTP exactly as the kiosk and dashboard do.
 *
 * CLAUDE.md: "A test where everything is refused proves nothing — it passes
 * just as happily when the claim is malformed." So every refusal below sits
 * next to the neighbouring request that MUST succeed, made with the same
 * session. If sessions were broken, the success half fails and so does the
 * suite. And `--sabotage` swaps in an open policy (every rule allows) and
 * the refusal checks must then FAIL — proving they can.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-studio-test-'));
process.env.KT_DATA_DIR = DATA;

const SABOTAGE = process.argv.includes('--sabotage');
if (SABOTAGE) {
  const policy = require('./policy');
  const open = { insert: (c, r) => r, update: (c, o, p) => p, remove: () => {} };
  Object.keys(policy.write).forEach(t => { policy.write[t] = open; });
  Object.keys(policy.read).forEach(t => { policy.read[t] = (c, r) => r; });
  policy.storageWrite = () => {};
  Object.keys(policy.BUCKETS).forEach(b => { policy.BUCKETS[b] = () => true; });
}

const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');
const { makeServer } = require('./server');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? '' : (detail || '') });
}

let BASE;
async function req(method, p, { token, body, raw, headers } = {}) {
  const h = Object.assign({}, headers || {});
  if (token) h.Authorization = 'Bearer ' + token;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers: h,
    body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { json = null; }
  return { status: res.status, json, text: buf.toString('utf8'), headers: res.headers, buf };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5fae0a20000000049454e44ae426082', 'hex');

(async () => {
  const conn = db.open(path.join(DATA, 'kattitude.db'));
  storage.init(DATA, { mediaDir: path.join(DATA, 'KIOSK MEDIA'),
                      artistName: id => (db.getByKey(conn, 'artists', [id]) || {}).name });
  const server = makeServer(conn);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ── fixture ── */
  const mk = (row) => db.insertRow(conn, 'artists', row);
  const kat = mk({ name: 'Kat', role: 'admin', email: 'kat@example.test', display_order: 0 });
  const barbie = mk({ name: 'Barbie', email: 'barbie@example.test', display_order: 1, bio: 'hi' });
  const miranda = mk({ name: 'Miranda', email: 'miranda@example.test', display_order: 2 });
  const gone = mk({ name: 'Gone', active: false, display_order: 3 });
  const hidden = mk({ name: 'Hidden', kiosk_visible: false, display_order: 4 });
  const sign = async (a) => {
    const l = auth.createLink(conn, a.id, 'test');
    const r = await req('POST', '/auth/v1/redeem', { body: { token: l.token } });
    return { token: r.json && r.json.access_token, link: l.token, status: r.status, user: r.json && r.json.user };
  };
  const K = await sign(kat), B = await sign(barbie), M = await sign(miranda);
  check('sign-in link redeems to a session', K.token && B.token && M.token, JSON.stringify(K));

  const cat = db.insertRow(conn, 'categories', require('./rpc').withKeys({ name: 'Floral', kind: 'style' }));
  const mDraft = db.insertRow(conn, 'designs', { artist_id: miranda.id, image_url: '/x', published: false });
  const mLive = db.insertRow(conn, 'designs', { artist_id: miranda.id, image_url: '/y', published: true });
  const goneLive = db.insertRow(conn, 'designs', { artist_id: gone.id, image_url: '/z', published: true });
  db.insertRow(conn, 'design_categories', { design_id: mLive.id, category_id: cat.id });

  /* ── links ── */
  const reuse = await req('POST', '/auth/v1/redeem', { body: { token: K.link } });
  check('a sign-in link works only once', reuse.status === 401, reuse.status);
  const junk = await req('POST', '/auth/v1/redeem', { body: { token: 'nope' } });
  check('a made-up link is refused', junk.status === 401, junk.status);
  const stored = conn.prepare('SELECT token_hash FROM sessions').all().map(r => r.token_hash);
  check('session tokens are stored hashed, never raw', !stored.includes(K.token) && stored.includes(auth.hash(K.token)));
  const meK = await req('GET', '/auth/v1/user', { token: K.token });
  check('/auth/v1/user answers with the signed-in user', meK.status === 200 && meK.json.id === K.user.id, meK.text);

  /* ── the public (kiosk / stranger on the tunnel) ── */
  const pub = await req('GET', '/rest/v1/artists?select=*&order=display_order');
  const pubNames = (pub.json || []).map(a => a.name);
  check('anon sees active, wall-visible artists', pub.status === 200 && pubNames.join() === 'Kat,Barbie,Miranda', pubNames.join());
  check('anon never receives email / role / auth link',
    (pub.json || []).every(a => !('email' in a) && !('role' in a) && !('auth_user_id' in a)), JSON.stringify(pub.json && pub.json[0]));
  const adm = await req('GET', '/rest/v1/artists?select=*&order=display_order', { token: K.token });
  check('...while admin does receive them (so the check above can fail)',
    adm.json && adm.json.length === 5 && adm.json[0].email === 'kat@example.test', adm.text.slice(0, 200));
  const oracle = await req('GET', '/rest/v1/artists?email=eq.barbie%40example.test');
  const oracleAdm = await req('GET', '/rest/v1/artists?email=eq.barbie%40example.test', { token: K.token });
  check('anon cannot probe for an email by filtering on it', oracle.json && oracle.json.length === 0, oracle.text);
  check('...while the same filter works for admin', oracleAdm.json && oracleAdm.json.length === 1, oracleAdm.text);
  const coll = await req('GET', `/rest/v1/artists?id=eq.${miranda.id}`, { token: B.token });
  check('an artist cannot read a colleague\'s email', coll.json && coll.json.length === 1 && !('email' in coll.json[0]), coll.text);
  const self = await req('GET', `/rest/v1/artists?id=eq.${barbie.id}`, { token: B.token });
  check('...but can read their own', self.json && self.json[0].email === 'barbie@example.test', self.text);

  const kc = await req('GET', '/rest/v1/kiosk_catalog?select=*');
  check('kiosk_catalog: only published designs of active artists',
    kc.json && kc.json.length === 1 && kc.json[0].id === mLive.id && kc.json[0].categories[0] === 'Floral', kc.text);
  const anonDesigns = await req('GET', '/rest/v1/designs?select=*');
  check('anon cannot see drafts', anonDesigns.json && !anonDesigns.json.some(d => d.id === mDraft.id) &&
    !anonDesigns.json.some(d => d.id === goneLive.id), anonDesigns.text);
  const anonIns = await req('POST', '/rest/v1/designs', { body: { image_url: '/a', artist_id: barbie.id } });
  check('anon insert is refused', anonIns.status === 403, anonIns.status);
  const anonCat = await req('POST', '/rest/v1/categories', { body: { name: 'Hack' } });
  check('anon cannot add a category', anonCat.status === 403, anonCat.status);
  const anonReq = await req('GET', '/rest/v1/category_requests?select=*');
  check('anon sees no category requests', anonReq.json && anonReq.json.length === 0, anonReq.text);
  const anonUp = await req('POST', `/storage/v1/object/flash/${barbie.id}/a.png`, { body: PNG, raw: true });
  check('anon upload is refused', anonUp.status === 403, anonUp.status);

  /* ── an artist ── */
  const own = await req('POST', '/rest/v1/designs?select=*', { token: B.token,
    body: { artist_id: barbie.id, image_url: '/mine.png', published: true, type: 'design' } });
  check('artist can upload their own design', own.status === 201 && own.json[0].artist_id === barbie.id, own.text);
  const forge = await req('POST', '/rest/v1/designs', { token: B.token,
    body: { artist_id: miranda.id, image_url: '/forged.png' } });
  check('...but not one credited to another artist', forge.status === 403, forge.status);
  const editOther = await req('PATCH', `/rest/v1/designs?id=eq.${mLive.id}`, { token: B.token, body: { title: 'mine now' } });
  check('artist cannot edit another artist\'s live design', editOther.status === 403, editOther.status + editOther.text);
  const editOwn = await req('PATCH', `/rest/v1/designs?id=eq.${own.json[0].id}`, { token: B.token, body: { title: 'Rose' } });
  check('...and can edit their own', editOwn.status === 200 && editOwn.json[0].title === 'Rose', editOwn.text);
  const editDraft = await req('PATCH', `/rest/v1/designs?id=eq.${mDraft.id}`, { token: B.token, body: { title: 'x' } });
  check('artist cannot even see another artist\'s draft to edit it', editDraft.status === 200 && editDraft.json.length === 0 &&
    db.getByKey(conn, 'designs', [mDraft.id]).title === null, editDraft.text);
  const delOther = await req('DELETE', `/rest/v1/designs?id=eq.${mLive.id}`, { token: B.token });
  check('artist cannot delete another artist\'s design', delOther.status === 403 && db.getByKey(conn, 'designs', [mLive.id]), delOther.status);
  const tagOther = await req('POST', '/rest/v1/design_categories', { token: B.token, body: { design_id: mLive.id, category_id: cat.id } });
  check('artist cannot re-tag another artist\'s design', tagOther.status === 403, tagOther.status);
  const tagOwn = await req('POST', '/rest/v1/design_categories', { token: B.token, body: { design_id: own.json[0].id, category_id: cat.id } });
  check('...and can tag their own', tagOwn.status === 201, tagOwn.text);
  const promote = await req('PATCH', `/rest/v1/artists?id=eq.${barbie.id}`, { token: B.token, body: { role: 'admin' } });
  check('artist cannot make themselves admin', promote.status === 403 && db.getByKey(conn, 'artists', [barbie.id]).role === 'artist', promote.status);
  const bio = await req('PATCH', `/rest/v1/artists?id=eq.${barbie.id}`, { token: B.token, body: { bio: 'Fine line since 2015' } });
  check('...and can change their own bio', bio.status === 200 && bio.json[0].bio === 'Fine line since 2015', bio.text);
  const claim = await req('PATCH', `/rest/v1/artists?id=eq.${barbie.id}`, { token: B.token, body: { auth_user_id: crypto.randomUUID() } });
  check('nobody can re-link a login through the API', claim.status === 403, claim.status);
  const approveSelf = await req('PATCH', `/rest/v1/designs?id=eq.${own.json[0].id}`, { token: B.token, body: { approved: true } });
  check('artist cannot approve their own design', approveSelf.status === 403, approveSelf.status);

  /* ── admin limits ── */
  const face = await req('PATCH', `/rest/v1/artists?id=eq.${barbie.id}`, { token: K.token, body: { portrait_url: '/x.webp' } });
  check('admin cannot change another artist\'s face', face.status === 403, face.status);
  const order = await req('PATCH', `/rest/v1/artists?id=eq.${barbie.id}`, { token: K.token, body: { display_order: 9 } });
  check('...but can reorder them', order.status === 200 && order.json[0].display_order === 9, order.text);
  const demote = await req('PATCH', `/rest/v1/artists?id=eq.${kat.id}`, { token: K.token, body: { role: 'artist' } });
  check('the last admin cannot demote themselves', demote.status === 403 && db.getByKey(conn, 'artists', [kat.id]).role === 'admin', demote.status);
  const noWhere = await req('PATCH', '/rest/v1/designs', { token: K.token, body: { title: 'all' } });
  check('an update with no filter is refused, not applied to every row', noWhere.status === 400, noWhere.status);
  const badCol = await req('PATCH', `/rest/v1/designs?id=eq.${mLive.id}`, { token: K.token, body: { nonsense: 1 } });
  check('an unknown column is an error, not silently dropped', badCol.status === 400 && badCol.json.code === 'PGRST204', badCol.text);

  /* ── storage ── */
  const up = (tok, p, body) => req('POST', `/storage/v1/object/${p}`, { token: tok, body: body || PNG, raw: true,
    headers: { 'Content-Type': 'image/png', 'x-upsert': 'true' } });
  const a1 = await up(B.token, `avatars/${barbie.id}/me.png`);
  const a2 = await up(B.token, `avatars/${miranda.id}/me.png`);
  const a3 = await up(K.token, `avatars/${barbie.id}/k.png`);
  check('artist can upload their own headshot', a1.status === 200, a1.text);
  check('...not a colleague\'s', a2.status === 403, a2.status);
  check('...and admin cannot replace anyone\'s face either', a3.status === 403, a3.status);
  const f1 = await up(B.token, `flash/${barbie.id}/x/original.png`);
  const f2 = await up(B.token, `flash/${miranda.id}/x/original.png`);
  const f3 = await up(K.token, `flash/${miranda.id}/k/original.png`);
  check('flash: own folder yes', f1.status === 200, f1.text);
  const onDisk = path.join(DATA, 'KIOSK MEDIA', 'Barbie', 'Designs', 'x', 'original.png');
  check('an upload lands in KIOSK MEDIA/<artist name>/Designs', fs.existsSync(onDisk) &&
    fs.readFileSync(onDisk).equals(PNG), onDisk);
  check('a headshot lands in KIOSK MEDIA/<artist name>/Headshots',
    fs.existsSync(path.join(DATA, 'KIOSK MEDIA', 'Barbie', 'Headshots', 'me.png')));
  check('flash: someone else\'s folder no', f2.status === 403, f2.status);
  check('flash: admin may upload on someone\'s behalf', f3.status === 200, f3.text);
  const s1 = await up(B.token, 'sale-media/s1/a.png');
  const s2 = await up(K.token, 'sale-media/s1/a.png');
  check('flash-sale media: artists no, admin yes', s1.status === 403 && s2.status === 200, `${s1.status}/${s2.status}`);
  const html = await up(K.token, `flash/${kat.id}/evil.html`, Buffer.from('<script>alert(1)</script>'));
  const svg = await up(K.token, `flash/${kat.id}/evil.svg`, Buffer.from('<svg onload="alert(1)"/>'));
  check('html and svg uploads are refused (would run as the dashboard)', html.status === 415 && svg.status === 415, `${html.status}/${svg.status}`);
  const trav = await up(K.token, `flash/${kat.id}/..%2F..%2F..%2Fescape.png`);
  check('path traversal is refused', trav.status === 400 && !fs.existsSync(path.join(DATA, 'escape.png')), trav.status);
  const noOver = await req('POST', `/storage/v1/object/flash/${barbie.id}/x/original.png`, { token: B.token, body: PNG, raw: true,
    headers: { 'x-upsert': 'false' } });
  check('upload without upsert does not overwrite', noOver.status === 409, noOver.status);
  const get = await req('GET', `/storage/v1/object/public/flash/${barbie.id}/x/original.png`);
  check('files are public to read, typed by extension, nosniff + sandboxed',
    get.status === 200 && get.buf.equals(PNG) && get.headers.get('content-type') === 'image/png' &&
    get.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(get.headers.get('content-security-policy')),
    get.status + ' ' + get.headers.get('content-type'));
  const range = await req('GET', `/storage/v1/object/public/flash/${barbie.id}/x/original.png`, { headers: { Range: 'bytes=0-7' } });
  check('Range requests work (Safari needs them for video)', range.status === 206 && range.buf.length === 8, range.status);
  const lst = await req('POST', '/storage/v1/object/list/avatars', { token: B.token, body: { prefix: barbie.id } });
  check('list returns the folder\'s files', lst.status === 200 && lst.json.some(f => f.name === 'me.png'), lst.text);
  const rmOther = await req('DELETE', '/storage/v1/object/avatars', { token: B.token, body: { prefixes: [`${miranda.id}/me.png`] } });
  check('cannot delete a file in someone else\'s folder', rmOther.status === 403, rmOther.status);

  /* ── URLs are stored as paths, served with the caller's host ── */
  const pubUrl = `${BASE}/storage/v1/object/public/flash/${barbie.id}/x/original.png`;
  const withUrl = await req('POST', '/rest/v1/designs?select=*', { token: B.token,
    body: { artist_id: barbie.id, image_url: pubUrl, published: true } });
  const storedUrl = db.getByKey(conn, 'designs', [withUrl.json[0].id]).image_url;
  check('an image URL is stored as a path, not tied to one hostname', storedUrl.startsWith('/storage/v1/object/public/'), storedUrl);
  const viaTunnel = await req('GET', `/rest/v1/designs?id=eq.${withUrl.json[0].id}`,
    { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'tunnel.example.test' } });
  check('...and comes back with whichever host the caller used',
    viaTunnel.json[0].image_url === `https://tunnel.example.test${storedUrl}` && withUrl.json[0].image_url === pubUrl, viaTunnel.text);
  const kcUrl = await req('GET', '/rest/v1/kiosk_catalog?select=*');
  const kcRow = (kcUrl.json || []).find(r => r.id === withUrl.json[0].id);
  check('kiosk_catalog hands out full URLs too, not bare paths', kcRow && kcRow.image_url === pubUrl,
    kcRow && kcRow.image_url);
  const foreign = await req('POST', '/rest/v1/designs?select=*', { token: B.token,
    body: { artist_id: barbie.id, image_url: 'https://tovydesiocfgmasvzjvt.supabase.co/storage/v1/object/public/flash/a/b.png' } });
  check('a URL to a file NOT on this machine is kept as given',
    db.getByKey(conn, 'designs', [foreign.json[0].id]).image_url.startsWith('https://tovydesiocfgmasvzjvt'), foreign.text);

  /* ── category requests ── */
  const rq = await req('POST', '/rest/v1/category_requests', { token: B.token, body: { requested_name: 'Snakes' } });
  check('artist can request a category', rq.status === 201 && rq.json[0].requested_by === barbie.id && rq.json[0].status === 'pending', rq.text);
  const rqForge = await req('POST', '/rest/v1/category_requests', { token: B.token, body: { requested_name: 'Moths', requested_by: miranda.id } });
  check('...but not in someone else\'s name', rqForge.status === 403, rqForge.status);
  const rqDupe = await req('POST', '/rest/v1/category_requests', { token: B.token, body: { requested_name: 'floral' } });
  check('requesting an existing category is refused', rqDupe.status === 409, rqDupe.status);
  const chk = await req('POST', '/rest/v1/rpc/check_category_name', { token: B.token, body: { p_name: 'Florals' } });
  check('check_category_name finds near matches', chk.json && chk.json.reason === 'available' && chk.json.near[0].name === 'Floral', chk.text);
  const q = await req('GET', '/rest/v1/category_request_queue?select=*', { token: K.token });
  check('request queue carries who asked', q.json && q.json[0].requested_by_name === 'Barbie' && q.json[0].pending_duplicates === 1, q.text);
  const apB = await req('POST', '/rest/v1/rpc/approve_category_request', { token: B.token, body: { p_request_id: rq.json[0].id, p_kind: 'subject' } });
  check('artist cannot approve requests', apB.status === 403, apB.status);
  const apK = await req('POST', '/rest/v1/rpc/approve_category_request', { token: K.token, body: { p_request_id: rq.json[0].id, p_kind: 'subject' } });
  check('admin approval creates the category', apK.status === 200 && apK.json.name === 'Snakes' &&
    db.all(conn, 'categories').some(c => c.name === 'Snakes'), apK.text);

  /* ── flash sales ── */
  const saleB = await req('POST', '/rest/v1/flash_sales', { token: B.token, body: { name: 'x' } });
  const saleK = await req('POST', '/rest/v1/flash_sales?select=*', { token: K.token, body: { name: 'Friday 13th', published: false } });
  check('only admin creates flash sales', saleB.status === 403 && saleK.status === 201, `${saleB.status}/${saleK.status}`);
  const tier = await req('POST', '/rest/v1/flash_sale_tiers', { token: K.token, body: { sale_id: saleK.json[0].id, price_cents: 10000 } });
  const tier2 = await req('POST', '/rest/v1/flash_sale_tiers', { token: K.token, body: { sale_id: saleK.json[0].id, price_cents: 10000 } });
  check('duplicate price level reports "duplicate" (flash-sales.js matches on it)', tier.status === 201 && tier2.status === 409 &&
    /duplicate/.test(tier2.json.message), tier2.text);
  const anonSale = await req('GET', '/rest/v1/flash_sales?select=*,flash_sale_tiers(*)');
  const admSale = await req('GET', '/rest/v1/flash_sales?select=*,flash_sale_tiers(*)', { token: K.token });
  check('an unpublished sale is hidden from the public, embeds work for admin',
    anonSale.json.length === 0 && admSale.json[0].flash_sale_tiers.length === 1, admSale.text);

  /* ── switching someone off ── */
  const off = await req('PATCH', `/rest/v1/artists?id=eq.${miranda.id}`, { token: K.token, body: { active: false } });
  const after = await req('GET', '/auth/v1/user', { token: M.token });
  check('switching an artist off ends their session', off.status === 200 && after.status === 401, after.status);
  const offLink = await req('POST', '/auth/v1/link', { token: K.token, body: { artist_id: miranda.id } });
  check('...and no new link can be made for them', offLink.status === 409, offLink.status);
  const linkB = await req('POST', '/auth/v1/link', { token: B.token, body: { artist_id: barbie.id } });
  const linkK = await req('POST', '/auth/v1/link', { token: K.token, body: { artist_id: barbie.id,
    redirect_to: 'https://evil.example.test/steal' } });
  check('only admin makes links, and a link never points off-site',
    linkB.status === 403 && linkK.status === 200 && linkK.json.url.startsWith(BASE + '/dashboard/#kt_signin='), linkK.text);
  const first = auth.createLink(conn, hidden.id, 'test');
  const second = auth.createLink(conn, hidden.id, 'test');
  const r1 = await req('POST', '/auth/v1/redeem', { body: { token: first.token } });
  const r2 = await req('POST', '/auth/v1/redeem', { body: { token: second.token } });
  check('making a new link cancels the previous unused one (the dashboard promises this)',
    r1.status === 401 && r2.status === 200, `${r1.status}/${r2.status}`);
  const otp = await req('POST', '/auth/v1/otp', { body: { email: 'a@b.c' } });
  check('email sign-in explains itself instead of pretending to send', otp.status === 400 && /text it to you/.test(otp.json.message), otp.text);

  /* ── the site itself ── */
  const git = await req('GET', '/.git/config');
  const src = await req('GET', '/server/db.js');
  const md = await req('GET', '/CLAUDE.md');
  const trav2 = await req('GET', '/..%2f..%2fetc/passwd');
  check('no .git, server code, docs or traversal over HTTP',
    git.status === 404 && src.status === 404 && md.status === 404 && trav2.status === 404,
    [git.status, src.status, md.status, trav2.status].join());
  const home = await req('GET', '/');
  check('kiosk is served with the studio-server override injected after config.js',
    home.status === 200 && /<script src="config.js"><\/script>\s*<script src="studio-server.js">/.test(home.text), home.text.slice(0, 120));
  const dash = await fetch(BASE + '/dashboard/', { redirect: 'manual' });
  check('the studio server sends /dashboard/ to the ONE hosted dashboard (no split brain)',
    dash.status === 302 && /kattitude-flash-kiosk\.vercel\.app\/dashboard\//.test(dash.headers.get('location') || ''),
    dash.status + ' ' + dash.headers.get('location'));
  const ovr = await req('GET', '/studio-server.js');
  check('kiosk override switches the catalog to live, on this server', /catalogSource = 'live'/.test(ovr.text) &&
    /\/rest\/v1\/kiosk_catalog/.test(ovr.text), ovr.text);
  const kioskArtists = await req('GET', '/rest/v1/artists?active=eq.true&order=display_order' +
    '&select=id,name,handle,portrait_url,portrait_thumb_url,bio,instagram_url,seniority,display_order');
  check('the kiosk\'s exact artists URL answers', kioskArtists.status === 200 && kioskArtists.json.length >= 2, kioskArtists.text);

  /* ── files dropped into KIOSK MEDIA (server/folder-sync.js) ── */
  {
    const { execFileSync } = require('node:child_process');
    const sync = require('./folder-sync');
    const media = path.join(DATA, 'KIOSK MEDIA');
    const md5 = f => fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') : 'missing:' + f;
    const ls = d => { try { return fs.readdirSync(d); } catch (e) { return []; } };
    const mk = (file, w, h, label) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tiny = path.join(DATA, 'tiny.png');
      fs.writeFileSync(tiny, PNG);
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-z', String(h), String(w), tiny, '--out', file], { stdio: 'ignore' });
      if (label) fs.appendFileSync(file, Buffer.from(label));
      const t = new Date(Date.now() - 10000); fs.utimesSync(file, t, t);   // settled, not mid-copy
      return md5(file);
    };
    const B = (...p) => path.join(media, 'Barbie', ...p);
    const sheetMd5 = mk(B('Designs', 'IMG_1705.JPEG'), 2550, 3300);
    mk(B('Designs', 'exact-2048.jpg'), 2048, 2048);
    mk(B('loose-in-artist-folder.jpg'), 1320, 1700);
    mk(B('Designs', 'tiny.jpg'), 800, 800);
    mk(B('Designs', 'some-upload', 'original.jpg'), 2048, 2048);
    mk(B('Headshots', 'face.jpg'), 1500, 1500);

    const r1 = sync.syncOnce(conn);
    const bySrc = () => Object.fromEntries(db.all(conn, 'designs').filter(d => d.source_file).map(d => [d.source_file, d]));
    let S = bySrc();
    const sh = S['Barbie/Designs/IMG_1705.JPEG'];
    check('a file in <artist>/Designs is imported as a published flash sheet under that artist',
      sh && sh.type === 'sheet' && sh.published && sh.artist_id === barbie.id, JSON.stringify(r1));
    check('...resized to fit 2160×3840, never cropped (aspect kept)',
      sh && sh.width === 2160 && sh.height === Math.round(3300 * 2160 / 2550), sh && sh.width + 'x' + sh.height);
    check('...and the dropped original is untouched', md5(B('Designs', 'IMG_1705.JPEG')) === sheetMd5);
    const kioskFile = sh ? storage.diskPath('flash', sh.image_url.replace(/^\/storage\/v1\/object\/public\/flash\//, '')) : '/nonexistent';
    check('...with a kiosk copy in Designs/_kiosk', fs.existsSync(kioskFile) && /\/Designs\/_kiosk\//.test(kioskFile), kioskFile);
    const ex = S['Barbie/Designs/exact-2048.jpg'];
    check('a 2048×2048 file is a flash SHEET too (everything is a sheet)', ex && ex.type === 'sheet', ex && ex.type);
    const loose = S['Barbie/loose-in-artist-folder.jpg'];
    check('a file loose in <artist>/ counts, as a sheet', loose && loose.type === 'sheet' && loose.artist_id === barbie.id);
    check('Headshots/ is never imported', !Object.keys(S).some(k => /Headshots/.test(k)));
    check('a too-small file is skipped, not stretched', !S['Barbie/Designs/tiny.jpg']);
    check('files inside subfolders (dashboard uploads, _kiosk) are not re-imported',
      !Object.keys(S).some(k => /some-upload|_kiosk/.test(k)));
    const kc2 = await req('GET', '/rest/v1/kiosk_catalog?select=*');
    check('imported sheet is on the wall\'s catalog, with its file name',
      kc2.json.some(r => r.source_name === 'IMG_1705.JPEG' && r.artist_name === 'Barbie' && r.type === 'sheet'));
    check('a second scan with nothing changed imports nothing', sync.syncOnce(conn).imported.length === 0);

    /* ── Sheets/ is emptied into Designs/ and removed ── */
    const M = (...p) => path.join(media, 'Miranda', ...p);
    const ivMd5 = mk(M('Sheets', 'Untitled_Artwork_2_web.JPEG'), 3000, 3000, 'iv');
    fs.mkdirSync(M('Designs', '_kiosk-sheets', 'Untitled_Artwork_2_web'), { recursive: true });   // stale old copy
    const preRow = db.insertRow(conn, 'designs', { artist_id: miranda.id, title: 'old', type: 'sheet',
      image_url: '/x', published: true, source_file: 'Miranda/Sheets/Untitled_Artwork_2_web.JPEG', source_sig: 'old' });
    const clashA = mk(M('Designs', 'clash.jpg'), 1320, 1700, 'a');
    const clashB = mk(M('Sheets', 'clash.jpg'), 1320, 1700, 'b');
    mk(M('Designs', 'dupe.jpg'), 1320, 1700, 'same');
    fs.copyFileSync(M('Designs', 'dupe.jpg'), M('Sheets', 'dupe.jpg'));
    const t = new Date(Date.now() - 10000); fs.utimesSync(M('Sheets', 'dupe.jpg'), t, t);

    const r4 = sync.syncOnce(conn);
    S = bySrc();
    check('Sheets/ is emptied into Designs/ and removed', !fs.existsSync(M('Sheets')), JSON.stringify(r4.moved));
    check('the moved file is byte-identical in Designs/', md5(M('Designs', 'Untitled_Artwork_2_web.JPEG')) === ivMd5);
    const iv = S['Miranda/Designs/Untitled_Artwork_2_web.JPEG'];
    check('its design keeps the same id — re-pointed, not duplicated',
      iv && iv.id === preRow.id && iv.type === 'sheet' &&
      db.all(conn, 'designs').filter(d => /Untitled_Artwork_2_web/.test(d.source_file || '')).length === 1);
    check('...and its wall copy is rebuilt in Designs/_kiosk; the old _kiosk-sheets copy is gone',
      iv && /\/_kiosk\/Untitled_Artwork_2_web\//.test(iv.image_url) && !fs.existsSync(M('Designs', '_kiosk-sheets')));
    const names = ls(M('Designs')).filter(n => /clash/.test(n)).sort();
    check('a name clash keeps BOTH files, nothing overwritten',
      names.length === 2 && names.map(n => md5(M('Designs', n))).sort().join() === [clashA, clashB].sort().join(), names.join(', '));
    check('an exact duplicate is stored once', ls(M('Designs')).filter(n => /dupe/.test(n)).length === 1);
    check('no other folders are created (Designs + Headshots only)',
      ls(M()).filter(n => !n.startsWith('.')).sort().join() === 'Designs', ls(M()).join());

    fs.unlinkSync(B('Designs', 'IMG_1705.JPEG'));
    const r3 = sync.syncOnce(conn);
    check('deleting the file takes the sheet off the wall',
      r3.removed.includes('Barbie/Designs/IMG_1705.JPEG') && !bySrc()['Barbie/Designs/IMG_1705.JPEG'] &&
      !fs.existsSync(kioskFile), JSON.stringify(r3));
  }

  /* ── Supabase → KIOSK MEDIA sync (server/supabase-sync.js) ──
   * A stand-in Supabase on a local port: same URL shapes, real image bytes. */
  {
    const http = require('node:http');
    const { execFileSync } = require('node:child_process');
    const sync = require('./supabase-sync');
    const folderSync = require('./folder-sync');
    const media = path.join(DATA, 'KIOSK MEDIA');
    const img = (w, h, label) => {
      const f = path.join(DATA, 'remote-' + label + '.jpg'); fs.writeFileSync(path.join(DATA, 't.png'), PNG);
      execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-z', String(h), String(w), path.join(DATA, 't.png'), '--out', f], { stdio: 'ignore' });
      return Buffer.concat([fs.readFileSync(f), Buffer.from(label)]);
    };
    let catalog = [], files = {}, down = false, requests = 0;
    let remoteArtists = null;   // null = this stand-in has no artists list (404), as before
    const mock = http.createServer((q, r) => {
      requests++;
      if (down) { r.socket.destroy(); return; }
      if (q.url.startsWith('/rest/v1/kiosk_catalog')) { r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(catalog)); }
      if (q.url.startsWith('/rest/v1/artists')) {
        if (remoteArtists === null) { r.writeHead(404); return r.end(); }
        r.writeHead(200, { 'Content-Type': 'application/json' }); return r.end(JSON.stringify(remoteArtists));
      }
      const f = files[q.url];
      if (f) { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(f); }
      r.writeHead(404); r.end();
    });
    await new Promise(res => mock.listen(0, '127.0.0.1', res));
    const SB = `http://127.0.0.1:${mock.address().port}`;
    const opts = { url: SB, key: 'test' };
    const J = (...p) => path.join(media, 'Jen', ...p);
    const jen = db.insertRow(conn, 'artists', { name: 'Jen', display_order: 9 });
    const md5f = f => fs.existsSync(f) ? crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex') : null;

    files['/storage/v1/object/public/flash/x/a.jpg'] = img(2160, 2795, 'a');
    files['/storage/v1/object/public/flash/x/b.jpg'] = img(2048, 2048, 'b');
    catalog = [
      { id: 'aaaaaaaa-1111', artist_id: jen.id, title: 'Rose sheet', type: 'sheet', image_url: SB + '/storage/v1/object/public/flash/x/a.jpg' },
      { id: 'bbbbbbbb-2222', artist_id: jen.id, title: 'Square', type: 'design', image_url: SB + '/storage/v1/object/public/flash/x/b.jpg' },
    ];
    // A sheet Joshua dropped in by hand, which the sync must never touch.
    fs.mkdirSync(J('Designs'), { recursive: true });
    fs.writeFileSync(J('Designs', 'hand-drop.jpg'), img(1320, 1700, 'hand'));
    { const t = new Date(Date.now() - 10000); fs.utimesSync(J('Designs', 'hand-drop.jpg'), t, t); }   // settled, as a real drop would be
    const handMd5 = md5f(J('Designs', 'hand-drop.jpg'));

    const r1 = await sync.syncOnce(conn, opts);
    check('a published dashboard upload is downloaded into <artist>/Designs',
      r1.ok && fs.existsSync(J('Designs', 'Rose sheet (aaaaaaaa).jpg')) && fs.existsSync(J('Designs', 'Square (bbbbbbbb).jpg')),
      JSON.stringify(r1));
    check('...byte-for-byte what Supabase holds', md5f(J('Designs', 'Rose sheet (aaaaaaaa).jpg')) ===
      crypto.createHash('md5').update(files['/storage/v1/object/public/flash/x/a.jpg']).digest('hex'));
    check('the first successful query of the day is logged as the keep-alive', r1.keepalive === true &&
      conn.prepare("SELECT value FROM meta WHERE key='supabase_keepalive_day'").get().value === db.nowIso().slice(0, 10));
    const r1b = await sync.syncOnce(conn, opts);
    check('...once a day, not every run; and an unchanged catalog downloads nothing',
      r1b.ok && !r1b.keepalive && r1b.downloaded.length === 0, JSON.stringify(r1b));
    folderSync.syncOnce(conn);
    const onWall = db.all(conn, 'designs').filter(d => d.artist_id === jen.id);
    // [CHANGED 3 Oct 2026, two sizes] The square was uploaded as a single
    // ('design') and stays one; the tall upload and the hand drop are sheets.
    const typeOf = name => (onWall.find(d => d.source_file === 'Jen/Designs/' + name) || {}).type;
    check('the folder importer puts them on the wall with the type the dashboard chose',
      onWall.length === 3 && onWall.every(d => d.published) && typeOf('Rose sheet (aaaaaaaa).jpg') === 'sheet' &&
      typeOf('Square (bbbbbbbb).jpg') === 'design' && typeOf('hand-drop.jpg') === 'sheet',
      onWall.map(d => d.source_file + ':' + d.type).join(', '));

    // Offline: Supabase unreachable. Nothing may be deleted.
    down = true;
    const r2 = await sync.syncOnce(conn, opts);
    check('offline: the run fails safely and deletes NOTHING',
      !r2.ok && r2.removed.length === 0 && fs.existsSync(J('Designs', 'Rose sheet (aaaaaaaa).jpg')), JSON.stringify(r2));
    down = false;
    const r3 = await sync.syncOnce(conn, opts);
    check('...and the next run after the network returns succeeds', r3.ok, JSON.stringify(r3));

    // Re-uploaded image (new URL) → replaced.
    files['/storage/v1/object/public/flash/x/a2.jpg'] = img(2160, 2795, 'a2');
    catalog[0].image_url = SB + '/storage/v1/object/public/flash/x/a2.jpg';
    await sync.syncOnce(conn, opts);
    check('a changed upload replaces the local copy', md5f(J('Designs', 'Rose sheet (aaaaaaaa).jpg')) ===
      crypto.createHash('md5').update(files['/storage/v1/object/public/flash/x/a2.jpg']).digest('hex'));

    // Deleted / unpublished in the dashboard → it leaves the folder and the wall.
    catalog = catalog.filter(d => d.id !== 'bbbbbbbb-2222');
    const r4 = await sync.syncOnce(conn, opts);
    folderSync.syncOnce(conn);
    check('deleted or unpublished in the dashboard → removed from the folder and the wall',
      r4.removed.includes('Jen/Designs/Square (bbbbbbbb).jpg') && !fs.existsSync(J('Designs', 'Square (bbbbbbbb).jpg')) &&
      !db.all(conn, 'designs').some(d => /Square \(bbbbbbbb\)/.test(d.source_file || '')), JSON.stringify(r4));

    // A synced file someone edited on the Mac is kept even when unpublished.
    fs.appendFileSync(J('Designs', 'Rose sheet (aaaaaaaa).jpg'), Buffer.from('edited'));
    catalog = [];
    const r5 = await sync.syncOnce(conn, opts);
    check('a synced file that was edited on this Mac is kept, not deleted',
      r5.kept.includes('Jen/Designs/Rose sheet (aaaaaaaa).jpg') && fs.existsSync(J('Designs', 'Rose sheet (aaaaaaaa).jpg')), JSON.stringify(r5));
    check('a hand-dropped file is never touched by the sync', md5f(J('Designs', 'hand-drop.jpg')) === handMd5);
    check('every run reached the database (that is the keep-alive traffic)', requests >= 7, requests + ' requests');

    // A sheet that STARTED on this Mac and was copied to Supabase with the
    // same id (the move to Kat's project) is already on the wall: no download.
    const homegrown = db.insertRow(conn, 'designs', { artist_id: jen.id, title: 'Studio sheet', type: 'sheet',
      image_url: '/storage/v1/object/public/flash/x/studio.jpg', published: true });
    files['/storage/v1/object/public/flash/x/studio.jpg'] = img(2160, 2795, 'studio');
    catalog = [{ id: homegrown.id, artist_id: jen.id, title: 'Studio sheet', type: 'sheet',
                 image_url: SB + '/storage/v1/object/public/flash/x/studio.jpg' }];
    const wallBefore = db.all(conn, 'designs').length;
    const r6 = await sync.syncOnce(conn, opts);
    folderSync.syncOnce(conn);
    check('a sheet that came FROM this Mac is not downloaded back (no duplicate on the wall)',
      r6.ok && r6.downloaded.length === 0 && r6.alreadyHere.includes(homegrown.id) &&
      !fs.existsSync(J('Designs', `Studio sheet (${homegrown.id.slice(0, 8)}).jpg`)) &&
      db.all(conn, 'designs').length === wallBefore, JSON.stringify(r6));
    catalog = [];

    /* ── two sizes (3 Oct 2026): a square can be a single OR a sheet ── */
    files['/storage/v1/object/public/flash/x/sq.jpg'] = img(2048, 2048, 'sq');
    catalog = [{ id: 'eeeeeeee-5555', artist_id: jen.id, title: 'Square single', type: 'design',
                 image_url: SB + '/storage/v1/object/public/flash/x/sq.jpg' }];
    const sq = () => db.all(conn, 'designs').find(d => d.source_file === 'Jen/Designs/Square single (eeeeeeee).jpg');
    await sync.syncOnce(conn, opts);
    folderSync.syncOnce(conn);
    check('a square SINGLE from the dashboard lands on the wall as a single design (2048×2048)',
      sq() && sq().type === 'design' && sq().width === 2048 && sq().height === 2048, JSON.stringify(sq() && { type: sq().type, w: sq().width }));
    catalog[0].type = 'sheet';
    const r8 = await sync.syncOnce(conn, opts);
    folderSync.syncOnce(conn);
    check('switched to a flash sheet in My Designs → the wall follows, with no re-download',
      r8.retyped.length === 1 && r8.downloaded.length === 0 && sq().type === 'sheet', JSON.stringify({ retyped: r8.retyped, type: sq().type }));
    catalog[0].type = 'design';
    await sync.syncOnce(conn, opts);
    folderSync.syncOnce(conn);
    check('...and back to a single', sq().type === 'design');
    check('a type switch changes the cheap-check fingerprint (so the next screensaver start sees it)',
      sync.fingerprint([{ id: 'a', image_url: 'u', type: 'design' }]) !== sync.fingerprint([{ id: 'a', image_url: 'u', type: 'sheet' }]));
    fs.writeFileSync(J('Designs', 'hand-square.jpg'), img(2048, 2048, 'hand-square'));
    { const t = new Date(Date.now() - 10000); fs.utimesSync(J('Designs', 'hand-square.jpg'), t, t); }
    folderSync.syncOnce(conn);
    const hs = db.all(conn, 'designs').find(d => d.source_file === 'Jen/Designs/hand-square.jpg');
    check('a square dropped into Designs/ by hand is still a flash sheet (folder drops unchanged)',
      hs && hs.type === 'sheet', JSON.stringify(hs && hs.type));
    catalog = [];
    await sync.syncOnce(conn, opts);

    /* ── artists and headshots (9 Oct 2026: "When does the Kiosk refresh profile pics?") ── */
    {
      const others = db.all(conn, 'artists').filter(a => a.id !== jen.id);
      const pub = a => ({ id: a.id, name: a.name, handle: a.handle || null, bio: a.bio || null,
        instagram_url: a.instagram_url || null, seniority: a.seniority || null, display_order: a.display_order,
        portrait_url: null, portrait_thumb_url: null });
      const NEW_ID = '11111111-2222-4333-8444-555555555555';
      files[`/storage/v1/object/public/avatars/${jen.id}/avatar-a1.webp`] = Buffer.from('jen-photo-big');
      files[`/storage/v1/object/public/avatars/${jen.id}/avatar-a1-sm.webp`] = Buffer.from('jen-photo-small');
      remoteArtists = [...others.map(pub),
        Object.assign(pub(jen), { handle: '@jen.new', display_order: 2,
          portrait_url: `${SB}/storage/v1/object/public/avatars/${jen.id}/avatar-a1.webp`,
          portrait_thumb_url: `${SB}/storage/v1/object/public/avatars/${jen.id}/avatar-a1-sm.webp` }),
        { id: NEW_ID, name: 'Newbie', handle: '@newbie', bio: null, instagram_url: 'https://instagram.com/newbie',
          seniority: 'Junior Artist', display_order: 9, portrait_url: null, portrait_thumb_url: null }];
      const a1 = await sync.syncOnce(conn, opts);
      const J2 = db.getByKey(conn, 'artists', [jen.id]);
      const nb = db.getByKey(conn, 'artists', [NEW_ID]);
      check('a new artist added in the dashboard appears on the Mac with the SAME id',
        nb && nb.name === 'Newbie' && nb.handle === '@newbie' && nb.kiosk_visible && a1.artistsAdded.includes('Newbie'), JSON.stringify(a1.artistsAdded));
      check('...with their KIOSK MEDIA folders made', fs.existsSync(path.join(media, 'Newbie', 'Designs')) && fs.existsSync(path.join(media, 'Newbie', 'Headshots')));
      check('a changed handle / order reaches the Mac\'s card', J2.handle === '@jen.new' && J2.display_order === 2, JSON.stringify({ h: J2.handle, o: J2.display_order }));
      check('a new profile photo is downloaded into <Artist>/Headshots, byte for byte',
        fs.readFileSync(J('Headshots', 'avatar-a1.webp'), 'utf8') === 'jen-photo-big' &&
        fs.readFileSync(J('Headshots', 'avatar-a1-sm.webp'), 'utf8') === 'jen-photo-small');
      check('...and the card points at it, as a path (never a host)',
        J2.portrait_url === `/storage/v1/object/public/avatars/${jen.id}/avatar-a1.webp` &&
        J2.portrait_thumb_url === `/storage/v1/object/public/avatars/${jen.id}/avatar-a1-sm.webp`, J2.portrait_url);
      const pr = await req('GET', `/storage/v1/object/public/avatars/${jen.id}/avatar-a1.webp`);
      check('...and the wall can load it from this server', pr.status === 200 && pr.text === 'jen-photo-big', pr.status);

      const a2 = await sync.syncOnce(conn, opts);
      check('nothing changed → no artist changes, no re-download', !a2.artistsAdded.length && !a2.artistsUpdated.length && !a2.photos.length && !a2.artistsHidden.length,
        JSON.stringify([a2.artistsAdded, a2.artistsUpdated, a2.photos, a2.artistsHidden]));

      // Photo changed again
      files[`/storage/v1/object/public/avatars/${jen.id}/avatar-b2.webp`] = Buffer.from('jen-photo-2');
      remoteArtists.find(a => a.id === jen.id).portrait_url = `${SB}/storage/v1/object/public/avatars/${jen.id}/avatar-b2.webp`;
      remoteArtists.find(a => a.id === jen.id).portrait_thumb_url = null;
      await sync.syncOnce(conn, opts);
      check('a replaced photo replaces the card\'s photo', db.getByKey(conn, 'artists', [jen.id]).portrait_url.endsWith('/avatar-b2.webp') &&
        fs.readFileSync(J('Headshots', 'avatar-b2.webp'), 'utf8') === 'jen-photo-2');

      // Taken off the wall in the dashboard: no longer in the public list.
      remoteArtists = remoteArtists.filter(a => a.id !== NEW_ID);
      const a3 = await sync.syncOnce(conn, opts);
      check('an artist taken off the wall (or made inactive) is hidden on the Mac — not deleted',
        a3.artistsHidden.includes('Newbie') && db.getByKey(conn, 'artists', [NEW_ID]) && !db.getByKey(conn, 'artists', [NEW_ID]).kiosk_visible);
      remoteArtists.push({ id: NEW_ID, name: 'Newbie', handle: '@newbie', bio: null, instagram_url: 'https://instagram.com/newbie',
        seniority: 'Junior Artist', display_order: 9, portrait_url: null, portrait_thumb_url: null });
      await sync.syncOnce(conn, opts);
      check('...and comes back when they are put back', db.getByKey(conn, 'artists', [NEW_ID]).kiosk_visible === true);

      // Renamed in the dashboard → the folder moves with them.
      remoteArtists.find(a => a.id === NEW_ID).name = 'Newbie Ink';
      await sync.syncOnce(conn, opts);
      check('a renamed artist\'s KIOSK MEDIA folder is renamed with them',
        db.getByKey(conn, 'artists', [NEW_ID]).name === 'Newbie Ink' && fs.existsSync(path.join(media, 'Newbie Ink', 'Headshots')) &&
        !fs.existsSync(path.join(media, 'Newbie')));

      // An outage that returns an empty list must not wipe the wall.
      const keep = remoteArtists; remoteArtists = [];
      const a4 = await sync.syncOnce(conn, opts);
      check('an EMPTY artist list hides nobody', a4.artistsHidden.length === 0 && db.getByKey(conn, 'artists', [jen.id]).kiosk_visible);
      remoteArtists = keep;

      // The cheap check sees a photo change on its own.
      process.env.KT_SUPABASE_URL = SB; process.env.KT_SUPABASE_KEY = 'test'; process.env.KT_CHECK_GAP_MS = '0';
      await req('POST', '/api/sync-now');                       // settle on the current state
      const quiet = await req('POST', '/api/sync-now');
      files[`/storage/v1/object/public/avatars/${jen.id}/avatar-c3.webp`] = Buffer.from('jen-photo-3');
      remoteArtists.find(a => a.id === jen.id).portrait_url = `${SB}/storage/v1/object/public/avatars/${jen.id}/avatar-c3.webp`;
      const loud = await req('POST', '/api/sync-now');
      check('a screensaver start notices a photo change alone and syncs it',
        quiet.json.reason === 'nothing new' && loud.json.ran && loud.json.changed &&
        db.getByKey(conn, 'artists', [jen.id]).portrait_url.endsWith('/avatar-c3.webp'), JSON.stringify([quiet.json, loud.json]));
      delete process.env.KT_SUPABASE_URL; delete process.env.KT_SUPABASE_KEY; delete process.env.KT_CHECK_GAP_MS;
      remoteArtists = null;
    }

    /* ── triggers: the screensaver start → POST /api/sync-now ── */
    process.env.KT_SUPABASE_URL = SB; process.env.KT_SUPABASE_KEY = 'test';
    process.env.KT_CHECK_GAP_MS = '0';   // the 30s guard has its own check below
    files['/storage/v1/object/public/flash/x/c.jpg'] = img(2160, 2795, 'c');
    catalog = [{ id: 'cccccccc-3333', artist_id: jen.id, title: 'From phone', type: 'sheet',
                 image_url: SB + '/storage/v1/object/public/flash/x/c.jpg' }];
    const before = requests;
    const t1 = await req('POST', '/api/sync-now');
    check('a screensaver start triggers a sync, which downloads AND imports at once',
      t1.status === 200 && t1.json.ran && t1.json.changed && fs.existsSync(J('Designs', 'From phone (cccccccc).jpg')) &&
      db.all(conn, 'designs').some(d => d.source_file === 'Jen/Designs/From phone (cccccccc).jpg'), t1.text);
    // Every screensaver start now asks the cheap question; the full sync runs
    // only when the answer changed. The 30s guard is off here (it has its own
    // check below).
    process.env.KT_CHECK_GAP_MS = '0';
    const r0 = requests;
    const t2 = await req('POST', '/api/sync-now');
    // Two small requests since 9 Oct 2026: the designs list and the artist cards.
    check('a screensaver start with nothing new makes TWO small requests (designs, artists) and downloads nothing',
      t2.status === 200 && t2.json.ran === false && t2.json.reason === 'nothing new' && requests - r0 === 2,
      t2.text + ' requests ' + (requests - r0));

    // Naomi's case: something is published straight after a sync. The very
    // next screensaver start must bring it in — no 10-minute wait.
    files['/storage/v1/object/public/flash/x/d.jpg'] = img(2160, 2795, 'd');
    catalog.push({ id: 'dddddddd-4444', artist_id: jen.id, title: 'Just uploaded', type: 'sheet',
                   image_url: SB + '/storage/v1/object/public/flash/x/d.jpg' });
    const t2b = await req('POST', '/api/sync-now');
    check('an upload published right after a sync reaches the wall at the NEXT screensaver start',
      t2b.status === 200 && t2b.json.ran && t2b.json.changed && fs.existsSync(J('Designs', 'Just uploaded (dddddddd).jpg')) &&
      db.all(conn, 'designs').some(d => d.source_file === 'Jen/Designs/Just uploaded (dddddddd).jpg'), t2b.text);

    // Unpublished in the dashboard → the next start takes it off the wall.
    catalog = catalog.filter(d => d.id !== 'dddddddd-4444');
    const t2c = await req('POST', '/api/sync-now');
    check('...and an unpublish is picked up at the next start too',
      t2c.json.ran && !fs.existsSync(J('Designs', 'Just uploaded (dddddddd).jpg')), t2c.text);

    // Back-to-back pings (the screensaver flapping) are answered without asking Supabase.
    process.env.KT_CHECK_GAP_MS = '30000';
    await req('POST', '/api/sync-now');
    const rGuard = requests;
    const t2d = await req('POST', '/api/sync-now');
    check('a second ping within 30 seconds does not even make the small request',
      t2d.json.ran === false && t2d.json.reason === 'just checked' && requests === rGuard, t2d.text);
    delete process.env.KT_CHECK_GAP_MS;
    const t3 = await req('POST', '/api/sync-now', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    check('a sync request arriving through a tunnel is refused', t3.status === 403, t3.status);
    /* ── hourly, for insurance (9 Oct 2026) ── */
    {
      process.env.KT_CHECK_GAP_MS = '0';
      const logs = [], realLog = console.log;
      console.log = (...a) => { logs.push(a.join(' ')); realLog(...a); };
      const before = requests;
      process.env.KT_HOURLY_MS = '120';
      const timer = require('./server').startHourly(conn);
      await new Promise(r => setTimeout(r, 420));
      const quietRuns = logs.filter(l => /hourly check: nothing new \(Supabase saw activity\)/.test(l)).length;
      files['/storage/v1/object/public/flash/x/h.jpg'] = img(2160, 2795, 'h');
      catalog.push({ id: 'hhhhhhhh-8888', artist_id: jen.id, title: 'Hourly', type: 'sheet',
                     image_url: SB + '/storage/v1/object/public/flash/x/h.jpg' });
      await new Promise(r => setTimeout(r, 400));
      clearInterval(timer);
      console.log = realLog;
      delete process.env.KT_HOURLY_MS;
      check('the hourly check logs a line every run, "nothing new" included', quietRuns >= 2, quietRuns + ' quiet runs logged');
      check('...and every run queries Supabase (keep-alive activity)', requests - before >= quietRuns * 2, (requests - before) + ' requests');
      check('...and a new upload is pulled at the next hourly run, without any screensaver',
        logs.some(l => /sync \(hourly check, something new\): 1 new/.test(l)) && fs.existsSync(J('Designs', 'Hourly (hhhhhhhh).jpg')),
        logs.filter(l => /hourly/.test(l)).slice(-3).join(' | '));
    }

    delete process.env.KT_SUPABASE_URL; delete process.env.KT_SUPABASE_KEY;
    mock.close();
  }

  server.close();
  conn.close();
  fs.rmSync(DATA, { recursive: true, force: true });

  const pass = results.filter(r => r.ok).length;
  results.forEach(r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '   → ' + String(r.detail).slice(0, 300)}`));
  console.log(`\n${pass}/${results.length} passed${SABOTAGE ? '  (SABOTAGE MODE: policies opened up — refusal checks are expected to FAIL)' : ''}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
