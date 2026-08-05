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

  const cfg = window.DASH_CONFIG;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: false,      // app.js is the only writer of the session
      autoRefreshToken: false,    // see above
      detectSessionInUrl: false,  // app.js already consumed the magic link
    },
  });

  /* app.js stores the session under supabase-js's default key. Reading it
   * here and handing it to this client keeps both talking to the same user
   * without either of them owning the other. */
  function storageKey() {
    try {
      return 'sb-' + new URL(cfg.supabaseUrl).hostname.split('.')[0] + '-auth-token';
    } catch (e) { return null; }
  }

  let adopted = false;

  /** Returns the supabase client with the current session attached, or null
   *  if nobody is signed in. Never throws — callers are UI. */
  async function client() {
    if (!adopted) {
      const key = storageKey();
      let raw = null;
      try { raw = key && window.localStorage.getItem(key); } catch (e) { raw = null; }
      if (!raw) return null;

      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { return null; }

      // supabase-js has stored this both bare and wrapped in { currentSession }
      // across versions. Accept either rather than pinning to one shape.
      const s = parsed && (parsed.access_token ? parsed : parsed.currentSession);
      if (!s || !s.access_token) return null;

      const { error } = await sb.auth.setSession({
        access_token: s.access_token,
        refresh_token: s.refresh_token,
      });
      if (error) return null;
      adopted = true;
    }
    return sb;
  }

  /* The session changes (sign out, magic-link landing) invalidate what we
   * adopted, so drop it and re-read on the next call. */
  window.addEventListener('storage', () => { adopted = false; });

  return { client, raw: sb };
})();
