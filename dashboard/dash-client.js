/* One Supabase client for the modules that live beside app.js.
 *
 * WHY THIS FILE EXISTS: avatar.js and tour.js both need the signed-in user,
 * and app.js keeps its client private inside an IIFE. Rather than reach into
 * app.js (or edit it, which is the file with the most to lose), they share
 * one client from here.
 *
 * `autoRefreshToken` is FALSE on purpose. app.js's client already owns the
 * refresh timer for this session; a second one on the same storage key means
 * two timers racing to swap the same refresh token, and the loser gets a
 * 400 that silently signs the artist out mid-upload. This client reads the
 * session app.js maintains and never writes one.
 *
 * There is no service-role key here either. Every request below goes out with
 * the user's own JWT and is judged by RLS.
 */
window.DashClient = (function () {
  'use strict';

  /* [CHANGED 3 Oct 2026] ONE auth client per page: app.js's.
   *
   * This used to build a second Supabase client and copy app.js's session
   * into it with setSession(). Two auth clients holding one session race for
   * its refresh token, and Supabase rotates refresh tokens — each works once —
   * so when the hour-long access token expired, one of the two was refused
   * and signed out (tools/verify-storage-auth.js, KT_RACE=1). Uploads were
   * reaching Storage as anon and being refused by RLS. Now every module
   * borrows the client app.js made, and nothing copies a session. */
  function app() { return window.__ktDashSb || null; }

  async function ready() {
    for (let i = 0; i < 200 && !app(); i++) await new Promise(r => setTimeout(r, 50));
    return app();
  }

  /** The dashboard's client if somebody is signed in, else null. Never
   *  throws — callers are UI. */
  async function client() {
    const sb = await ready();
    if (!sb) return null;
    try {
      const { data } = await sb.auth.getSession();
      return data && data.session ? sb : null;
    } catch (e) { return null; }
  }

  /** Before a storage write: a token the server issued a moment ago, so an
   *  expired or stale one (or a phone whose clock is wrong) can never send an
   *  upload out as anon. null means the sign-in is gone — say so. */
  async function fresh() {
    const sb = await ready();
    if (!sb) return null;
    // The studio server's stand-in client (local-backend.js) has no refresh
    // tokens to rotate; there the session check is the whole job.
    if (typeof sb.auth.refreshSession !== 'function') return client();
    try {
      const { data, error } = await sb.auth.refreshSession();
      return !error && data && data.session ? sb : null;
    } catch (e) { return null; }
  }

  return { client, fresh };
})();
