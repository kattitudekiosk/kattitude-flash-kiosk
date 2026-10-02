# Studio server — the Mac mini as Kattitude's backend

The kiosk's data and photos, on the kiosk's own Mac mini. No Supabase bill, no
storage bill, and the wall keeps working when the shop's internet doesn't.

```
 wall (Chrome, this Mac) ──► http://localhost:8787            kiosk
 artists' phones ──► tunnel (https) ──► localhost:8787/dashboard/
                                          │
                       ~/KattitudeData/   ├─ kattitude.db      SQLite: artists, designs, categories, sales
                                          ├─ files/<bucket>/   flash, avatars, sale-media
                                          ├─ backups/          nightly DB snapshots (last 30)
                                          └─ logs/
```

One Node process (`server/server.js`), **zero npm dependencies** — Node's
built-in `node:sqlite` and `node:http`. It answers the same URLs Supabase did
(`/rest/v1`, `/storage/v1`, `/auth/v1`), so the kiosk and dashboard code are
unchanged. When it serves them, it injects one script tag into each page to
point it at itself. The same files served from Vercel are untouched and still
talk to Supabase.

## Run it

```sh
node server/server.js                 # foreground, http://localhost:8787
sh server/install-launchd.sh          # keep it running: login start, auto-restart, 03:30 backups
sh server/install-launchd.sh uninstall
node server/cli.js status
```

## Signing in — links, not email

There is no email. Supabase's sender only ever reached Joshua's own addresses,
and a free Mac mini has no mail server either.

1. Kat's first link, on the Mac mini:
   `node server/cli.js link Kat --base https://<tunnel address>`
2. After that, Kat makes everyone else's in **Artists → Sign-in links** and
   sends it however she likes (text, DM, AirDrop).

A link works **once**, for **7 days**. Opening it signs that phone in for 180
days. Making a new link cancels the previous unused one. Switching an artist
off ends their sessions immediately.

## Who can do what (`server/policy.js`)

The server enforces this; the dashboard only decides what to show.

| | public (kiosk, anyone on the tunnel) | artist | admin (Kat) |
|---|---|---|---|
| artists | display columns only — never email, role, login | colleagues minus email/login; own row in full | everything |
| own bio / headshot | — | yes | **only their own** — nobody changes someone else's face |
| role, on/off, wall visibility, order | — | — | yes (and the last admin cannot demote themselves) |
| designs | published only | own: create, edit, delete | all, plus approve |
| categories, flash sales | read (sales: published only) | read; may *request* a category | everything |
| storage `flash/<artist>/` | read | own folder | any folder |
| storage `avatars/<artist>/` | read | own folder | **own folder only** |
| storage `sale-media/` | read | — | yes |

Uploads: photos and video only (jpg png webp gif heic avif mp4 mov m4v webm),
80 MB max. HTML and SVG are refused — they would run as the dashboard.

## The tunnel

Phones need an https address that reaches this machine.

- **Today (temporary):** `cloudflared tunnel --url http://127.0.0.1:8787`
  prints a `https://<random>.trycloudflare.com` address. No account. **The
  address changes every time it restarts**, so it is for testing, not for
  Kat's artists.
- **For real:** a named Cloudflare Tunnel on a hostname Kat owns (e.g.
  `flash.kattitude.com`), free, needs Kat's Cloudflare account with her
  domain on it. That sign-up is Kat's or Joshua's to do; once it exists,
  `cloudflared tunnel login` + `cloudflared service install` make it permanent.

Photo URLs are stored as **paths**, not addresses, and given a host per
request. A phone uploading through the tunnel and the wall reading over
localhost each get URLs that work for them, and a changed tunnel address
orphans nothing.

## Moving data across from Supabase

`node server/cli.js import-supabase` — re-runnable; matches rows by id, never
duplicates, never overwrites a role, email or login this machine already owns.
It uses the **publishable** key only, so it cannot see emails, roles or drafts:
Kat is set as admin, everyone else as artist, emails start blank. On 2 Oct 2026
there were no designs, drafts or sales to miss.

## Proving it

`node server/test.js` — boots a throwaway server and checks 73 behaviours over
HTTP, every refusal next to the neighbouring success.
`node server/test.js --sabotage` — same suite with every access rule opened up;
the refusal checks **must** fail (31 do). If they pass, the suite is broken.

## Known gaps

- Deleting a design leaves its files on disk (Supabase did the same). Harmless
  at this scale — 127 GB free — but worth a sweep one day.
- Backups are on the same disk as the data. Time Machine or an external drive
  is what protects against the disk itself dying.
- Realtime (`sb.channel`) is not implemented; nothing uses it today.
