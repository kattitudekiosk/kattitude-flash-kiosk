# Flash Gallery — implementation notes

Covers what is built, what it runs on, and how to swap placeholder content for
real flash. Spec is `flashgalleryprd.md`.

## Status against the PRD phases

| Phase | State |
|---|---|
| 1 — Data + backend foundation | Schema **applied** to Supabase project `kattitude-flash-gallery` (`tovydesiocfgmasvzjvt`, us-east-1) with RLS. Tables are empty. Storage and auth not started. |
| 2 — Kiosk redesign | Built: home, hybrid grid, filters, detail, sheet retention. Running on seed content. |
| 3 — Dashboard | Not started. |
| 4 — Polish + hardening | Partial — idle reset and attract loop exist; lockdown and offline work outstanding. |

## The thing to understand first

**With zero individual designs, the kiosk boots straight into the existing
linear sheet viewer and the new gallery never mounts.**

That is the studio's state today — 4 composed sheets, no singles — so this is
the live path, not a fallback for later. Everything new sits on top of it and
is inert until real singles exist. `tools/verify.js` asserts it on every run.

The decision is computed in one place (`Catalog.snapshot().sheetsOnly`) and
nowhere else, so it cannot drift.

## Architecture

```
config.js      ← the only file you edit to change content source
data.js        ← the 4 real sheets (unchanged, still authoritative)
seed/          ← generated placeholder catalog (disposable)
catalog.js     ← normalizes any source into one shape; owns filtering + fallback logic
gallery.js     ← home / grid / detail views + router
script.js      ← legacy sheet viewer (near-untouched, still owns sheet browsing)
```

Sheet browsing was **not** reimplemented. `script.js` carries a lot of
hard-won handling for this specific panel — ghost contacts on large capacitive
screens, pinch disabled because a stray second touch was hijacking swipes,
identifier-tracked gestures. A grid tile for a sheet hands off to that viewer
rather than duplicating it. Changes to `script.js` total ~50 lines, all
additive: a router hook, a `[data-native-scroll]` exemption so the grid can
scroll, two empty-array guards, and a small public API.

## Running it

```bash
python3 -m http.server 8000 --directory .   # or: node .claude/static-server.cjs
```

Then `http://localhost:8000`. For an honest preview, size the window to
1080×1920 portrait — layout is tuned for that panel.

## Switching modes

`config.js` → `catalogSource`:

- `'seed'` — placeholder content (current default)
- `'sheets-only'` — force the legacy viewer, ignoring the catalog. **This is
  what the kiosk does in the shop today.** Use it to confirm nothing regressed.
- `'live'` — Supabase-backed

## Going live with real content

1. Cut the sheets into individual designs — 2048×2048 transparent PNGs per
   PRD §4.1. This is the critical path and it is production work, not code.
2. Apply `db/schema.sql` to a Supabase project.
3. In `config.js`: set `catalogSource: 'live'` and fill in `live.url` /
   `live.anonKey` pointing at the `kiosk_catalog` view.
4. Delete `assets/seed/`, `seed/`, and the `seed/seed-data.js` script tag in
   `index.html`.

No view code, query code, or markup beyond that one tag changes. That is the
point of the catalog layer.

## Seed content

Generated, not hand-written:

```bash
python3 tools/generate-seed.py           # 47 designs, 10 sheets, 7 artists
python3 tools/generate-seed.py --clean   # remove it all
```

The roster is the studio's **real** artists and handles. The artwork is not
theirs — machine-drawn placeholder geometry, watermarked, with a pink banner
across the kiosk whenever `catalogSource` is `'seed'`. Keep both safeguards
while seed data is in place: real names beside fake art is the one way this
could actually mislead someone, including the artists.

The mix is chosen so every layout state is reachable and reviewable:

| Artist | Singles | Sheets | State |
|---|---|---|---|
| Kat | 12 | 4 | mixed — several modules, both alternations |
| Alena | 8 | 3 | mixed |
| Ally | 0 | 3 | **sheets only** → linear viewer, no grid |
| Barbie / Miranda / Jen / Naomi | 9 / 7 / 5 / 6 | 0 | singles only |

**Sheet credits confirmed by Joshua, 3 Oct 2026:** Kat 2 (IMG 2120, Untitled
Artwork), Jen 1 (IMG 1705), Miranda 1 (Untitled Artwork 2). That is how they
sit in KIOSK MEDIA and in both databases. (The seed's
Kat/Alena split above is placeholder data and never public.)

## The hybrid grid

A sheet claims a **2-column block**, and the singles that follow stack down the
leftover column beside it — one sheet plus three designs filling a complete
band with no holes. Consecutive modules alternate sides. `grid-auto-flow:
dense` does the packing; `layoutModules()` in gallery.js assigns the spans.

The row span is **not fixed**. It is derived from each sheet's real pixel
dimensions (`moduleSpan()`), because the studio's four sheets are 0.77, 0.82,
0.77 and a dead-square 1.00 — nothing like the 9:16 the PRD assumed. A fixed
2x3 block cropped the wide ones badly. Tiles crop to fill (`object-fit:
cover`); the span is chosen so the crop is a few percent.

Sheets are also **redistributed** rather than left in upload order. Sorted by
date they cluster, giving three big blocks in a row then a long field of
squares. `arrangeHybrid()` spreads them evenly while preserving relative order
within sheets and within singles.

## One layout, every screen

**The phone shows the same composition as the kiosk, scaled** — same 3
columns, same modules, same alternation. Not a responsive reflow.

This matters because the phone is a real user path: the QR in the sheet viewer
sends customers to the online gallery, and the preview URL gets shared with
artists.

The original phone bug was **two sources of truth**: CSS media queries dropped
the grid to 2 columns while `layoutModules()` kept computing spans for 3, so
sheets became full-width short blocks and letterboxed into narrow strips.
Column count now comes from `pickGridColumns()` and nowhere else, and a test
asserts no stylesheet reintroduces a column breakpoint.

Cell size is measured from the viewport and set as `--cell`, so the grid is
proportional for free:

| Width | Cell | Sheet module |
|---|---|---|
| 1080 (kiosk) | 342px | 696×1050 |
| 768 (iPad) | 238px | 488×738 |
| 390 (iPhone 14) | 112px | 236×360 |
| 360 (small Android) | 102px | 216×330 |

⚠ **Type does not scale linearly** — every label has a `clamp()` floor. At
390px a proportionally scaled caption would be ~4px. Tile titles floor at 9px
and artist names at 8px, which is small. This is the one deliberate divergence
from "identical to the kiosk"; see the note in gallery.css.

## Verifying

```bash
npm install jsdom
node tools/verify.js
```

```bash
node tools/verify-qr.js | python3 tools/verify-qr.py   # needs opencv-python-headless
```

112 checks across: sheets-only, seed hybrid, no-dead-ends, empty filter state,
all four gallery states, arbitrary roster sizes, and an unreachable live
source. The QR script is separate and decodes every rendered code with
OpenCV — an implementation independent of the qrcode.js used to encode, so a
wrong payload cannot pass by agreeing with itself. It already earned its keep — it caught that
`catalog.js` read `window.GALLERY_DATA`, which is always `undefined` because
`data.js` uses `const` (a top-level `const` in a classic script is a global
lexical binding, not a property of `window`). That bug silently dropped all 4
sheets and would have shipped.

## Open questions blocking further work

From PRD §6, still unanswered:

1. **Artist count at launch** — seeding only, no structural impact.
2. **Category vocabulary owner** — needs a real list to seed `categories`.
3. **Pricing on the kiosk** — `price_band` exists in the schema; whether it
   renders is a UI call.
4. **Owner approval before publish** — handled defensively. The schema carries
   both `published` (artist intent) and `approved` (studio intent), and the
   `kiosk_catalog` view is the single place that decides. Either answer is now
   a one-line change instead of a migration.
5. ~~Which Supabase project~~ — **resolved**: `kattitude-flash-gallery`, schema applied.

## Known gaps

- Thumbnails are pre-generated for seed content. Real content needs a CDN
  transform layer (PRD §4.1) — loading 40 full-size PNGs into a grid will
  stall the panel.
- Fonts load from the Google Fonts CDN. On a flaky shop connection the kiosk
  renders in a fallback face. Self-hosting into `assets/` is a small change
  worth making before this is depended on.
- Kiosk lockdown (PRD §4.3) is unchanged from today: fullscreen, wake lock,
  and screensaver are in place; navigation blocking and auto-launch on boot
  are not.
- No RLS on the schema yet — it belongs with the dashboard auth work, and
  enabling it now would lock out seeding.
