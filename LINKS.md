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

Supabase project `tovydesiocfgmasvzjvt` (`kattitude-flash-gallery`, us-east-1)
until Kat has her own Supabase account.

| | |
|---|---|
| API URL | https://tovydesiocfgmasvzjvt.supabase.co |
| Project dashboard | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt |
| Auth → SMTP (needed so artists can get sign-in links) | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/smtp |
| Auth → URL config | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/url-configuration |
| Auth → users | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/users |

## Source

| | |
|---|---|
| GitHub (**public**) | https://github.com/kattitudekiosk/kattitude-flash-kiosk |
