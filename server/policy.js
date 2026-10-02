/* Studio server — who may read and write what
 *
 * This file is the server's row-level security. On Supabase these rules were
 * Postgres policies plus the `artists_guard` trigger; here they are plain
 * functions, and the REST layer calls them for every row it reads or writes.
 * The client still only decides what to SHOW — an artist who hand-crafted a
 * request would be refused here exactly as Postgres refused them.
 *
 * DEFAULT DENY. A table with no entry below cannot be read or written by
 * anyone. A new table is invisible until somebody decides who sees it.
 *
 * ctx = { me: <artists row> | null, isAdmin: boolean }
 *   me === null  is the kiosk, or a stranger who found the tunnel URL.
 */
'use strict';

const { httpError } = require('./db');

/* What the public (the kiosk, and anybody on the internet) may see of an
 * artist. Email, role, auth link and tutorial progress are not in it: the
 * kiosk is a public page and artist emails are personal data. */
const PUBLIC_ARTIST_COLS = ['id', 'name', 'handle', 'portrait_url', 'portrait_thumb_url',
  'bio', 'instagram_url', 'seniority', 'display_order', 'active'];

/* What another (non-admin) artist may see of a colleague's row. */
const COLLEAGUE_HIDDEN = ['email', 'auth_user_id', 'tutorial_seen', 'tutorial_snoozed',
  'tutorial_seen_at'];

/* Only the artist themselves may set these on their own row. Being an admin
 * is not a way past it — Kat cannot change someone else's face or bio. This
 * is the rule `artists_guard` enforced on Supabase. */
const SELF_ONLY = ['portrait_url', 'portrait_thumb_url', 'bio'];

/* Only an admin may set these. An artist cannot promote themselves, re-link
 * their login, or put themselves back on the wall after Kat took them off. */
const ADMIN_ONLY_ARTIST = ['role', 'active', 'kiosk_visible', 'display_order', 'seniority'];

/* Never writable through /rest by anybody. auth_user_id is set by the server
 * when a sign-in link is redeemed, and nowhere else. */
const NEVER = ['auth_user_id', 'id', 'created_at', 'updated_at'];

function deny(msg) { return httpError(403, msg || 'new row violates row-level security policy', '42501'); }

function mine(ctx, artistId) { return !!(ctx.me && artistId && ctx.me.id === artistId); }
function signedIn(ctx) { return !!ctx.me; }

/* ── helpers that need other tables ───────────────────────────────────── */
function liveDesign(design, artistsById) {
  if (!design || !design.published || !design.approved) return false;
  if (!design.artist_id) return true;               // studio-owned sheet
  const a = artistsById[design.artist_id];
  return !!(a && a.active);
}

/* ── READ ─────────────────────────────────────────────────────────────── *
 * Each entry returns the row as this caller may see it, or null to hide it. */
const read = {
  artists(ctx, row) {
    if (ctx.isAdmin) return row;
    if (mine(ctx, row.id)) return row;
    if (!row.active) return null;
    if (!signedIn(ctx)) {
      if (!row.kiosk_visible) return null;
      const out = {};
      PUBLIC_ARTIST_COLS.forEach(c => { out[c] = row[c]; });
      return out;
    }
    const out = Object.assign({}, row);
    COLLEAGUE_HIDDEN.forEach(c => { delete out[c]; });
    return out;
  },
  categories(ctx, row) { return row; },
  designs(ctx, row, env) {
    if (ctx.isAdmin || mine(ctx, row.artist_id)) return row;
    return liveDesign(row, env.artistsById()) ? row : null;
  },
  design_categories(ctx, row, env) {
    const d = env.designsById()[row.design_id];
    if (!d) return null;
    return read.designs(ctx, d, env) ? row : null;
  },
  category_requests(ctx, row) {
    if (ctx.isAdmin || mine(ctx, row.requested_by)) return row;
    return null;
  },
  flash_sales(ctx, row) {
    if (ctx.isAdmin) return row;
    return row.published ? row : null;
  },
  flash_sale_tiers(ctx, row, env) { return saleChild(ctx, row, env); },
  flash_sale_media(ctx, row, env) { return saleChild(ctx, row, env); },
  flash_sale_designs(ctx, row, env) { return saleChild(ctx, row, env); },
};

function saleChild(ctx, row, env) {
  if (ctx.isAdmin) return row;
  const s = env.salesById()[row.sale_id];
  return (s && s.published) ? row : null;
}

/* ── WRITE ────────────────────────────────────────────────────────────── *
 * insert(ctx, row, env)        → returns the row to insert (may force columns) or throws
 * update(ctx, old, patch, env) → returns the patch to apply or throws
 * remove(ctx, old, env)        → returns nothing or throws
 */
function stripNever(obj) {
  NEVER.forEach(c => {
    if (c in obj && !(c === 'id')) throw deny(`${c} cannot be set directly`);
  });
}

function adminOnly(ctx) { if (!ctx.isAdmin) throw deny(); }

function lastAdmin(row, env) {
  return !Object.values(env.artistsById())
    .some(a => a.id !== row.id && a.role === 'admin' && a.active);
}

function canWriteDesign(ctx, design) {
  return ctx.isAdmin || mine(ctx, design && design.artist_id);
}

const write = {
  artists: {
    insert(ctx, row) {
      adminOnly(ctx);
      stripNever(row);
      SELF_ONLY.forEach(c => {
        if (row[c] !== undefined && row[c] !== null) throw deny(`${c} is set by the artist themselves`);
      });
      return row;
    },
    update(ctx, old, patch, env) {
      stripNever(patch);
      const self = mine(ctx, old.id);
      if (!self && !ctx.isAdmin) throw deny();
      for (const c of Object.keys(patch)) {
        if (SELF_ONLY.includes(c) && !self) throw deny(`Only ${old.name} can change their own ${c.replace(/_/g, ' ')}`);
        if (ADMIN_ONLY_ARTIST.includes(c) && !ctx.isAdmin) throw deny(`Only an admin can change ${c.replace(/_/g, ' ')}`);
      }
      /* An admin may not lock the studio out of its own dashboard. Demoting
       * or deactivating the LAST active admin is refused — on a server with
       * no Supabase console behind it, there would be no way back in short
       * of a command on the Mac mini. */
      const losesAdmin = old.role === 'admin' && old.active &&
        ((patch.role !== undefined && patch.role !== 'admin') || patch.active === false);
      if (losesAdmin && lastAdmin(old, env)) throw deny(`${old.name} is the only admin left — make someone else admin first`);
      return patch;
    },
    remove(ctx, old, env) {
      adminOnly(ctx);
      if (old.role === 'admin' && old.active && lastAdmin(old, env)) throw deny('Cannot remove the only admin');
    },
  },
  categories: {
    insert(ctx, row) { adminOnly(ctx); return row; },
    update(ctx, old, patch) { adminOnly(ctx); return patch; },
    remove(ctx) { adminOnly(ctx); },
  },
  designs: {
    insert(ctx, row) {
      if (!signedIn(ctx)) throw deny();
      if (!row.artist_id && !ctx.isAdmin) row.artist_id = ctx.me.id;
      if (!ctx.isAdmin && row.artist_id !== ctx.me.id) throw deny('You can only upload your own designs');
      return row;
    },
    update(ctx, old, patch) {
      if (!canWriteDesign(ctx, old)) throw deny();
      if ('artist_id' in patch && !ctx.isAdmin && patch.artist_id !== ctx.me.id) {
        throw deny('You cannot give a design to another artist');
      }
      if ('approved' in patch && !ctx.isAdmin) throw deny('Only an admin can approve');
      return patch;
    },
    remove(ctx, old) { if (!canWriteDesign(ctx, old)) throw deny(); },
  },
  design_categories: {
    insert(ctx, row, env) {
      if (!canWriteDesign(ctx, env.designsById()[row.design_id])) throw deny();
      return row;
    },
    update() { throw deny('Tags are added and removed, not edited'); },
    remove(ctx, old, env) {
      if (!canWriteDesign(ctx, env.designsById()[old.design_id])) throw deny();
    },
  },
  category_requests: {
    /* requested_by is the caller, always — the column default on Supabase was
     * current_artist_id() and the policy refused anything else. Status starts
     * pending and only the review RPCs move it. */
    insert(ctx, row) {
      if (!signedIn(ctx)) throw deny();
      if (row.requested_by && row.requested_by !== ctx.me.id) throw deny();
      for (const c of ['status', 'review_note', 'merged_into_category_id', 'reviewed_at']) {
        if (row[c] !== undefined && row[c] !== null && !(c === 'status' && row[c] === 'pending')) {
          throw deny(`${c} is set when Kat reviews it`);
        }
      }
      row.requested_by = ctx.me.id;
      row.status = 'pending';
      return row;
    },
    update() { throw deny('Requests are answered through review, not edited'); },
    remove(ctx) { adminOnly(ctx); },
  },
};
['flash_sales', 'flash_sale_tiers', 'flash_sale_media', 'flash_sale_designs'].forEach(t => {
  write[t] = {
    insert(ctx, row) { adminOnly(ctx); return row; },
    update(ctx, old, patch) { adminOnly(ctx); return patch; },
    remove(ctx) { adminOnly(ctx); },
  };
});

/* ── STORAGE ──────────────────────────────────────────────────────────── *
 * Every bucket is public to READ (the kiosk shows these files to anybody in
 * the shop). WRITES are scoped by the first folder of the path, exactly as
 * the Supabase storage policies were. */
const BUCKETS = {
  /* flash/<artist_id>/... — your own folder, or any folder if admin (Kat
   * uploading on someone's behalf). */
  flash(ctx, folder) { return ctx.isAdmin || mine(ctx, folder); },
  /* avatars/<artist_id>/... — your own folder ONLY. Admin is not enough;
   * nobody changes another artist's face. */
  avatars(ctx, folder) { return mine(ctx, folder); },
  /* sale-media/<sale_id>/... — flash sale branding, Kat's job. */
  'sale-media'(ctx) { return ctx.isAdmin; },
};

function storageWrite(ctx, bucket, objectPath) {
  const rule = BUCKETS[bucket];
  if (!rule) throw httpError(404, 'Bucket not found', 'NoSuchBucket');
  if (!signedIn(ctx)) throw deny('Sign in to upload');
  const folder = objectPath.split('/')[0];
  if (!rule(ctx, folder)) throw deny('You cannot write to that folder');
}

module.exports = { read, write, storageWrite, BUCKETS, PUBLIC_ARTIST_COLS, liveDesign, deny };
