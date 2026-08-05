# LINKS

Every live URL for the Kattitude flash gallery, in one place. Joshua works
from his phone and should never have to dig back through a conversation for a
link. **Update this file whenever a URL changes.**

Last updated: 5 August 2026

---

## ⏳ AWAITING DEPLOY — no preview URL yet

| | |
|---|---|
| Branch | `tutorials-and-avatars` |
| Head commit | `c4065e9` |
| Branched from | `category-requests` @ `ba0327e` |
| Contains | guided tutorial (per role) + profile photos as circle avatars |

**There is no URL for this yet, and that is not a formality.** The session
that built it had no Vercel connector at all, so nothing was deployed and
nothing was fetched back. Deploying `kattitude-flash-dashboard` from this
branch is what makes it viewable.

The database side IS live — migration `artist_avatars_and_tutorial_state` is
applied to `tovydesiocfgmasvzjvt`, so the columns and the `avatars` bucket
exist regardless of when the front end ships.

---

## 🔴 PRODUCTION — do not deploy without Joshua's explicit say-so

| | |
|---|---|
| **Kiosk (live on the shop wall)** | https://flash-gallery.vercel.app |

This is running on the shop's wall panel right now, in a working business.
Every build goes to a preview project instead. Promoting to production is a
decision Joshua makes out loud, never an assumption.

---

## Kiosk previews

| Project | URL | Notes |
|---|---|---|
| **flash-gallery-mobilefix** (newest) | https://flash-gallery-mobilefix-canyouseeus-joshua-greenes-projects.vercel.app | **Stable alias — always the latest build. Use this one.** Does NOT yet include the circle avatars. |
| flash-gallery-mobilefix (this build) | https://flash-gallery-mobilefix-6lhxupsnl-joshua-greenes-projects.vercel.app | Rounded-module QRs, card QRs, new Follow copy |
| flash-gallery-mobilefix (previous) | https://flash-gallery-mobilefix-23izi0eyz-joshua-greenes-projects.vercel.app | **STALE** — artist QR hidden on phones. Do not use. |
| flash-gallery-preview | https://flash-gallery-preview-fm9ssbqlg-joshua-greenes-projects.vercel.app | Holds the **images**. mobilefix loads assets from here via `<base href>`, so this must stay up. Its CSS/JS are older than the repo. |

`flash-gallery-mobilefix` is a thin overlay: one `index.html` that pulls
images and most scripts from `flash-gallery-preview`. That is why a change can
be correct in the repo and absent from the preview — the images are far too
large to re-upload through the deploy connector, so the base deployment's
`gallery.js` and `styles.css` stay frozen and the overlay patches on top.

---

## Dashboard

| Project | URL | Notes |
|---|---|---|
| **kattitude-flash-dashboard** | https://kattitude-flash-dashboard-canyouseeus-joshua-greenes-projects.vercel.app | **Stable alias. This is the sign-in URL.** Also the Supabase Site URL. Currently serving `category-requests` — the tutorial and avatars are NOT on it yet. |
| kattitude-dash-assets | https://kattitude-dash-assets-gvzde9o00-joshua-greenes-projects.vercel.app | `dashboard.css` + `config.js` only |

Sign in with **thelostandunfounds@gmail.com** — that address is attached to
Kat's artist card with the admin role, and the card is already claimed.

---

## Backend

| | |
|---|---|
| Supabase project ref | `tovydesiocfgmasvzjvt` (`kattitude-flash-gallery`, us-east-1) |
| API URL | https://tovydesiocfgmasvzjvt.supabase.co |
| Project dashboard | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt |
| Storage → avatars bucket | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/storage/buckets/avatars |
| Auth → URL config | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/url-configuration |
| Auth → users | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/users |
| Auth → SMTP | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/smtp |
| Auth → rate limits | https://supabase.com/dashboard/project/tovydesiocfgmasvzjvt/auth/rate-limits |

---

## Source

| | |
|---|---|
| GitHub (private) | https://github.com/canyouseeus/kattitude-flash-kiosk |
| This branch | https://github.com/canyouseeus/kattitude-flash-kiosk/tree/tutorials-and-avatars |

---

## Vercel projects that are NOT this product

`sheets`, `mobile`, `thelostandunfounds`, and the auto-named ones
(`determined-wright-a062d9`, `admiring-mcnulty-0f3292`, and similar) are
unrelated. Listed only so nobody deploys the kiosk into one by accident.
