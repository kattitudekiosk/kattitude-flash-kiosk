# Studio server — the Mac mini as Kattitude's backend

The kiosk's data and photos, on the kiosk's own Mac mini. No Supabase bill, no
storage bill, and the wall keeps working when the shop's internet doesn't.

```
 wall (Chrome, this Mac) ──► http://localhost:8787            kiosk
 artists' phones ──► tunnel (https) ──► localhost:8787/dashboard/
                                          │
  ~/Desktop/KIOSK MEDIA/   ├─ <Artist>/Designs/     every upload, in that artist's own folder
                          ├─ <Artist>/Headshots/   profile photos
                          ├─ Flash Sales/          event photos
                          └─ real/, placeholder/   the original image package (untouched)
  ~/KattitudeData/        ├─ kattitude.db          SQLite: artists, designs, categories, sales
                          ├─ backups/              nightly DB snapshots (last 30)
                          └─ logs/
```

One Node process (`server/server.js`), **zero npm dependencies** — Node's
built-in `node:sqlite` and `node:http`. It answers the same URLs Supabase did
(`/rest/v1`, `/storage/v1`, `/auth/v1`), so the kiosk and dashboard code are
unchanged. When it serves them, it injects one script tag into each page to
point it at itself. The same files served from Vercel are untouched and still
talk to Supabase.

Photos live in **`~/Desktop/KIOSK MEDIA`**, one folder per artist, named
exactly as in the dashboard (Joshua, 2 Oct 2026). Folders for every artist are
created at start-up; adding an artist creates theirs; renaming an artist
renames their folder. Override with `KT_MEDIA_DIR`. URLs stay keyed by artist
ID, so a rename never breaks a link.

## Dropping files straight into KIOSK MEDIA

**Drop sheets into `KIOSK MEDIA/<Artist>/Designs/`** — it goes on the wall
within about a minute (`server/folder-sync.js`). A file loose directly in
`<Artist>/` counts too.

- **Everything is a flash sheet** (Joshua: "designs are sheets"). Only a
  picture under 1080 px on its long side is skipped, and the reason logged.
- The file you dropped is never changed. The wall shows a copy, fitted
  (never cropped, never enlarged), in `Designs/_kiosk/`.
- Subfolders of `Designs/` (dashboard uploads, `_kiosk`) are left alone;
  `Headshots/` is never imported.
- Delete the file and it leaves the wall. Replace it and the wall updates.
- The old `Sheets/` folder is retired: anything in it is moved into
  `Designs/` (same design id, exact duplicates stored once, clashing names
  kept under a new name) and the empty folder removed — every scan.
- `server/KIOSK-MEDIA-HOW-TO.txt` is the staff-facing version; it heads the
  README.txt in the KIOSK MEDIA folder.

## The hosted dashboard → Supabase → this Mac (2 Oct 2026)

Artists upload from anywhere through the **hosted dashboard**
(https://kattitude-flash-kiosk.vercel.app/dashboard/), which saves to Kat's
Supabase project `hnwyoglbmhvafxnzizqe`. This Mac pulls from there, and skips
any design it already has (same id), so nothing comes back twice:

- **When it syncs** (Joshua: "only checks when the screensaver gets activated
  and then once a day") — never on a polling loop:
  1. the wall's screensaver starts → the page asks `POST /api/sync-now`
     (localhost only); the server syncs at most once per 10 minutes, and if
     sheets arrived or left, the page reloads its catalog so the screensaver
     reshuffles;
  2. once a day at 09:15, launchd `com.kattitude.studio-sync` runs
     `node server/cli.js sync-supabase` (log `logs/sync.log`) — the keep-alive;
  3. when the server starts (a reboot).
  Offline at a trigger → logged, nothing changes, the next trigger retries.
- It reads Supabase's `kiosk_catalog` with the public key — published,
  approved designs only — and downloads each into
  `KIOSK MEDIA/<Artist>/Designs/<title> (<id>).<ext>`. The folder importer
  then resizes it and puts it on the wall.
- Deleted or unpublished in the dashboard → the sync removes its own copy
  (and the wall drops it). It only ever deletes a file it wrote, and only if
  the file is unchanged; a hand-dropped or edited file is never deleted.
- Offline or Supabase down → logs "will retry", changes nothing, exits 0.
  The wall never depends on it.
- **Keep-alive:** every run is a real database query. The first success each
  day is logged: `keep-alive: database query OK`. Supabase says free
  projects pause "after 1 week of inactivity" but does not define activity,
  so this is the standard practice, not a guarantee. A paused project can be
  restored with one click for a year; the wall keeps running either way.
- **Folder drops are NOT pushed up to Supabase.** Writing there needs a
  signed-in user or the service-role key, and neither belongs on an
  unattended kiosk. So a hand-dropped sheet is on the wall but not the phone
  page; for both, upload through the dashboard.
- The studio server's own `/dashboard/` redirects to the hosted one: ONE
  dashboard writes, so nothing saved can miss the phone page.

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
