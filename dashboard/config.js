/* Kattitude Flash Dashboard — configuration
 *
 * The publishable key is meant to be public; it is in this page's source on
 * every load. What protects the catalog is row-level security in Postgres,
 * not secrecy of the key:
 *
 *   - anonymous  → SELECT live content only
 *   - artist     → CRUD their OWN designs, edit their own profile card
 *   - admin      → everything, plus artists and categories
 *
 * Writes here go out with the signed-in user's JWT, so every one of them is
 * evaluated against those policies. There is no service-role key in this app
 * and there must never be — it would bypass RLS entirely and it would be
 * sitting in a static file.
 */
window.DASH_CONFIG = {
  supabaseUrl: 'https://tovydesiocfgmasvzjvt.supabase.co',
  supabaseAnonKey: 'sb_publishable_2z_wow-2gSEvs4ng-YxyrA_Mytp7XaD',

  storageBucket: 'flash',

  /* PRD §4.1. Enforced on upload — an off-size file is rejected with the
   * exact size required rather than being silently resized, because
   * automatically cropping someone's artwork is not ours to do. */
  spec: {
    design: { w: 2048, h: 2048, label: 'single design' },
    sheet:  { w: 2160, h: 3840, label: 'flash sheet' },
  },

  /* Derivatives generated in the browser at upload time. */
  derivatives: [
    { name: 'thumb',  w: 512,  h: 512,  fit: 'cover'   },
    { name: 'medium', w: 1024, h: 1536, fit: 'contain' },
  ],

  /* Whether the studio owner must approve a design before it reaches the
   * kiosk. The schema carries `approved` alongside `published` either way.
   *
   * TODO(joshua): PRD §6.6 is still undecided. Defaulting to NOT required —
   * artists publish directly. Flip this to true and admins get a review
   * queue that gates the kiosk; no migration needed, the column already
   * exists and kiosk_catalog already filters on it.
   */
  requireApproval: false,

};
