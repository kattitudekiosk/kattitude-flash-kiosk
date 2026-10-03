# LINKS

Every live URL for the Kattitude flash gallery, in one place. **Update this
file whenever a URL changes.** No personal email addresses in this file — the
repository is public.

Last updated: 3 October 2026

---

## The wall (the kiosk in the shop)

| | |
|---|---|
| **The wall** | http://localhost:8787 — served by the Mac mini itself; works with the internet down. The desktop **KIOSK** icon opens this. |
| Photos | `~/Desktop/KIOSK MEDIA/<Artist>/Designs/` on the Mac mini |
| Data | `~/KattitudeData/` (database, backups, logs) on the Mac mini |

## Online (Kat's Vercel, team `kattitudekiosk-1141`)

| | |
|---|---|
| **Gallery for phones** (the wall's QR codes) | https://kattitude-flash-kiosk.vercel.app — project `kattitude-flash-kiosk`, builds from `main` |
| Dashboard files | https://kattitude-flash-kiosk.vercel.app/dashboard/ — served (200) because `main` carries `dashboard/`, but **signing in there waits on the Supabase move** to Kat's project `hnwyoglbmhvafxnzizqe`. Not yet a separate Vercel project. |

## Old addresses (Joshua's Vercel) — being retired

| | |
|---|---|
| `flash-gallery` (old production) | **STALE.** Nothing in the code or on the wall points at it any more. |
| `kattitude-flash-dashboard` (old hosted dashboard) | **STALE** once Kat's Supabase is live. Do not give either address to anyone. |
| `flash-gallery-mobilefix-…`, `flash-gallery-preview-…`, `kattitude-dash-assets-…` | **STALE** previews and overlays. |

---

## Backend

Kat's Supabase project `hnwyoglbmhvafxnzizqe` (`supabase-blue-cave`, Vercel-managed
org) since 3 Oct 2026. Schema, data and proofs: `db/kat-project/`. Joshua's old
project `tovydesiocfgmasvzjvt` is retired; only `server/cli.js` (the one-time
importer) still names it.

| | |
|---|---|
| API URL | https://hnwyoglbmhvafxnzizqe.supabase.co |
| Project dashboard | https://supabase.com/dashboard/project/hnwyoglbmhvafxnzizqe |
| Auth → URL config (Site URL still to set) | https://supabase.com/dashboard/project/hnwyoglbmhvafxnzizqe/auth/url-configuration |
| Auth → SMTP (needed so artists get sign-in links) | https://supabase.com/dashboard/project/hnwyoglbmhvafxnzizqe/auth/smtp |
| Auth → users | https://supabase.com/dashboard/project/hnwyoglbmhvafxnzizqe/auth/users |

## Source

| | |
|---|---|
| GitHub (**public**) | https://github.com/kattitudekiosk/kattitude-flash-kiosk |
