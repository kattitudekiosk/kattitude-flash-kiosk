# KATTITUDE TATTOO — Agent Guide

> **The single canonical rules file for all agents working on the Kattitude
> flash gallery kiosk and dashboard.** Modeled on the THE LOST+UNFOUNDS agent
> guide. Same discipline, different product and branding.
>
> Corrections applied 2 Aug 2026 are marked **[CORRECTED]** — the original
> draft was written from session memory and several details did not survive
> contact with the files.

## What This Project Is

A touchscreen flash gallery kiosk for Kattitude Tattoo Studio, plus a separate
dashboard where artists upload and tag their own flash. Customers browse
designs on a wall-mounted panel in the shop; artists manage content from their
phones. Built and operated by one person with AI agents.

## Hardware Reality — read this before any UI work

| Property | Value |
|---|---|
| Machine | Mac mini, headless-ish, no mouse |
| Display | Touchwo touchscreen, mounted **vertically**, 1080 x 1920 portrait |
| Touch driver | **Touch Up** (open source) — USB HID touch into **mouse events** |
| Browser | Safari, fullscreen |
| Input available | Touch (as mouse), keyboard |

The driver emits `mousedown`/`mousemove`/`mouseup`, NOT `touchstart`/
`touchmove`/`touchend`. Every touch-gesture API you would reach for on mobile
is unreliable on this hardware.

## Architecture Overview

| Layer | Location | Tech |
|---|---|---|
| Kiosk frontend | repo root | Vanilla HTML / CSS / JS — no framework, no build step |
| Dashboard | `dashboard/` | Vanilla HTML / CSS / JS, Supabase JS client |
| Database | Supabase `tovydesiocfgmasvzjvt` | PostgreSQL + RLS + Storage + Auth |
| Deployment | Vercel | **Production builds from git.** See the warning below. |
| Repo | `canyouseeus/kattitude-flash-kiosk` | private |

### ⚠️ **[CORRECTED]** Production deploys from git — pushing to `main` ships to the wall

The original draft said production used uploaded files with no git build hook.
**The opposite is true.** Every production deployment carries `gitCommitRef:
main`, a `gitCommitSha` and a commit message. Vercel is watching that branch.

**A `git push` to `main` deploys the shop's kiosk.** Work on a branch. Never
push `main` unless Joshua has said to promote, in those words.

This also means git — not the deploy connector — is the only realistic route
for a full deploy. See "Deploying" below.

### Vercel projects — know which one you are touching

| Project | Role |
|---|---|
| `flash-gallery` | **PRODUCTION — live on the shop wall.** Builds from `main`. |
| `flash-gallery-preview` | preview; holds the image assets other previews borrow |
| `flash-gallery-mobilefix` | preview; currently a `<base href>` overlay |
| `kattitude-flash-dashboard` | dashboard app |
| `kattitude-dash-assets` | dashboard CSS/config |

Live URLs live in `LINKS.md`. Keep it current.

## Where to Find Things

| What you need | Where |
|---|---|
| Product spec | **[CORRECTED]** `flashgalleryprd.md`, **version 1.0**, on Joshua's Desktop — *not* in the repo. There is no `flash-gallery-prd-v2.md`. |
| Decisions and defaults | `IMPLEMENTATION.md` |
| Every live URL | `LINKS.md` |
| Kiosk layout logic | `gallery.js`, `catalog.js` |
| Kiosk shell, canvas scaling, sheet viewer | `script.js` |
| Attract loop (video + flash reel) | `screensaver.js` |
| Kiosk Supabase URL and publishable key | `config.js` |
| Kiosk artist headshots (circles, Follow panel) | `avatars.css`, `avatars.js` |
| **Dashboard** Supabase URL, key, image spec | `dashboard/config.js` |
| Dashboard headshot upload + crop confirm | `dashboard/avatar.js`, `dashboard/my-avatar.js` |
| Dashboard guided tutorial (per role) | `dashboard/tour.js`, `dashboard/tour.css` |
| Seed/placeholder content | `seed/`, `assets/seed/` (gitignored — never commit) |
| Deploy helper | `tools/deploy-preview.sh` |

## EVIDENCE RULE — every task, no exceptions

Statements about your own process are reconstructions, not logs — they come out
confident whether or not they're true. Produce artifacts instead.

**Before writing code:**

1. Name the files you will read, then read them.
2. **Quote** the specific line from each that governs this task. A summary is
   not a quote. If you can't quote it, you didn't read it.
3. If a doc conflicts with this guide, say so out loud, state which you
   followed and why. Never reconcile a conflict silently.

**Before saying it's done:**

4. Show the artifact — fetched page, decoded output, command output. Not a
   description of one.
5. Every check must be able to fail. A test that passes when its inputs are
   missing is not a check. Verify the failure path before trusting the pass.
6. Look at the whole output, not just the part you changed.

**Layout work:** verify at **both** 1080 x 1920 and 390 x 844.

**QR work:** verify **all four** states — artist page Follow panel, artist card
QR, sheets-only artist viewer badge, and the Artists index (no stray badge).
Fixing one QR state and breaking another has now happened three times.

**Verify the rendered artwork, not your intent.** `tools/verify-qr.py`
rasterises the real SVG and decodes it with OpenCV. It used to rebuild a matrix
by re-parsing the path data, which only ever confirmed what we meant to draw.

**Storage and RLS work:** prove the refusal, in a transaction you roll back.
Set `role authenticated` and a `request.jwt.claims` for one artist, attempt the
write that must fail, and attempt the neighbouring write that must succeed. A
test where everything is refused proves nothing — it passes just as happily
when the claim is malformed and `current_artist_id()` is null.

## BLOCKER DISCLOSURE RULE — highest priority for communication

**The moment work stalls, say so. Do not wait until you have good news to pair
it with.** Joshua is usually remote, watching from a phone, and can often clear
a blocker in seconds.

- Report a blocker in its own message, immediately, naming exactly what
  completed and what did not.
- Do not retry quietly more than once before reporting.
- **The Vercel connector token expires mid-call.** Expect it in long sessions.
  Only Joshua can reconnect it. **A session may also have no Vercel connector
  at all** — say so plainly and hand over the branch and commit rather than
  describing a deployment that did not happen.
- **Say when something is impossible rather than expensive.** Inlining the
  image assets through the deploy connector is not "extra effort" — the bytes
  pass through the agent's context window and a 3 MB payload exceeds it by
  orders of magnitude. Saying "this will take a while" when the honest answer
  is "this cannot work" wastes more of Joshua's time than the blocker did.

## CAPABILITY CLAIMS RULE — exhaust the routes before reporting a blocker

**"I can't" is a claim about the world and needs the same evidence as any
other claim.** One failed call is not a capability assessment. It is one
failed call.

This rule exists because a session told Joshua four times that it had no
access to this repository, having tried exactly one thing: `add_repo` with
`access: "read"`. The GitHub MCP tools could read *and write* the repo the
entire time. Hours of work were handed back as instructions for Joshua to
carry out by hand, and he was the one who eventually said "use the github
cli?" — which is backwards. He should not have to be the one who suspects
the capability report is wrong.

**Before reporting that something cannot be done:**

1. **Try every route, and name them.** Say what you tried and what each
   returned. "No repo access" is not a finding; "add_repo read → denied,
   add_repo push → not tried, GitHub MCP get_file_contents → worked" is.
2. **Read the error text.** It often names the next route. The 403 that ended
   the attempt above said, in full: *"Use add_repo to request access... call
   add_repo again with access:'push'"*. The answer was inside the failure and
   nobody read past the first clause.
3. **A blocked path is not a blocked task.** The raw GitHub API through the
   proxy is blocked; the GitHub MCP is not. The Terminal is off the table;
   committing through the MCP is not. Distinguish "this tool refused" from
   "this cannot be done".
4. **Record the route that worked** — here, in `LINKS.md`, or in the commit —
   so the next session starts from it instead of rediscovering it.

**Known-good routes, in order.** Try the next one when one fails:

| Job | 1st | 2nd | 3rd |
|---|---|---|---|
| Read repo files | GitHub MCP `get_file_contents` | `add_repo` then clone | fetch the file off a deployment |
| Commit a change | GitHub MCP `create_or_update_file` | `add_repo` with `access:"push"`, then git | hand Joshua the patch |
| Deploy | push to a git-connected project and let it build | Vercel connector (text files only) | ask Joshua to click |
| Inspect a deployment | Vercel MCP `web_fetch_vercel_url` | the deployment's own URL, not the alias | build logs |
| Schema change | Supabase MCP `apply_migration` | — | never hand-written SQL |

**Things that genuinely have no route today**, so stop looking: promoting a
Vercel deployment to production, connecting a Vercel project to git, and
editing Supabase Auth email templates. All three are Joshua's click. Say so
in one line and give the exact path — do not repeat the instruction as though
refusing.

## SEVEN CRITICAL INVARIANTS

### 1. Arrow buttons are primary navigation — **[CORRECTED: the code violates this today]**

The draft stated this as "No swipe. Ever." **That is a goal, not a description
of the codebase.** The shipped code contains:

- `SWIPE_THRESHOLD` / `SWIPE_ANGLE_RATIO` and full gesture tracking in
  `script.js` (~line 47) and `gallery.js` (~line 21)
- user-facing copy in `index.html`: `<p class="footer-hint">Tap to zoom •
  Swipe to browse</p>`

Arrow buttons **do** exist on every navigable surface (`#btnPrev`/`#btnNext` in
the sheet viewer, `.g-detail-prev`/`.g-detail-next` in the detail view), so
nothing is swipe-*dependent* — the invariant's real intent holds. But the
kiosk is actively telling customers to swipe on hardware where swipe may not
fire. **Fix the copy first; it is a one-line change and it is a live defect.**

Also corrected: the draft specified "minimum 80 x 80 px targets, lower third of
screen". The real buttons are **72 x 160 px, vertically centred** (`top: 50%`).
Larger in area, different in placement. Decide which is right, then make the
doc and the code agree.

### 2. One layout everywhere — fixed canvas, scaled

The entire app renders inside a fixed **1080 x 1920** canvas, CSS-scaled to the
viewport. **No layout decision anywhere may read the real viewport** except the
single scale function in `script.js`. No media queries affecting composition.
No `vw`/`vh` inside the canvas.

This has been violated twice by media queries that *looked* harmless:
`.qr-badge { display: none }` under 768px hid the artist QR on phones while
leaving it on the kiosk — so it was simultaneously fixed and broken, which is
why it kept coming back. `tools/verify.js` now greps for viewport reads.

### 3. Image spec is fixed and enforced

Singles **2048 x 2048**. Sheets **2160 x 3840**. Derivatives at 512 x 512
(cover) and 1024 x 1536 (contain), WebP. Off-size uploads are **rejected with
the required dimensions in the error**. Never auto-crop an artist's work.

**Headshots are not artist work and are the one exception.** A profile photo is
a picture *of* a person, every avatar surface is a circle, and something has to
decide what lands inside it. So `dashboard/avatar.js` DOES centre-crop to
square — and shows the artist exactly what will be kept, with a slider, and
makes them press a button before anything uploads. Cropping is fine here.
Cropping silently is not, and that distinction is the whole of the rule.

### 4. Sheets-only artists bypass the grid

An artist with only full sheets routes straight into the linear sheet viewer.
It becomes the hybrid grid automatically once they have singles. This is the
state the studio is in today — it must never regress.

### 5. Production is sacred

`flash-gallery.vercel.app` is live in a working business. **Never deploy to it
without Joshua saying to promote.** Because production builds from `main`,
this means never pushing `main`. After any deploy, re-fetch production and
confirm it is unchanged.

### 6. RLS on, service-role key never shipped

The kiosk ships its publishable key in page source — secrecy is not a security
control. **[CORRECTED]** RLS arrived in migration 2, not migration 1; the
draft claimed "from the first migration". It is on now and must stay on.

**RLS filters rows, not columns.** `artists_public_read` originally granted
`anon` the whole row including `email`, `role` and `auth_user_id`. Column
grants are the tool for that, and `anon` now holds SELECT only on the display
columns. **When revoking from `anon`, never revoke from `authenticated`** — the
dashboard resolves admin by reading its own `role`.

The flip side, and it bites quietly: **a new column on `artists` is invisible
to the kiosk until it is granted to `anon` AND named in `config.js`'s explicit
select list.** `portrait_thumb_url` needs both. Nothing errors if you forget
the second one; the kiosk just silently serves the full-size original.

**`active` and `kiosk_visible` are different questions.** `active` means "may
use the dashboard, and is eligible for admin". `kiosk_visible` means "appears
on the wall". They were one column once, and a developer who was hidden from
the wall with `active = false` was locked out of the dashboard by his own
invisibility: `artists_public_read` filtered him out, `is_admin()` requires
`active`, so no policy returned his own row and the app told him he had no
profile. If you need somebody off the wall but working, that is
`kiosk_visible = false`, never `active = false`.

**Storage RLS is per-bucket and per-policy.** The `avatars` bucket scopes every
write to `(storage.foldername(name))[1] = current_artist_id()::text` so an
artist cannot overwrite another artist's face. `flash` originally did this on
DELETE but not on UPDATE, which meant any signed-in artist could overwrite any
other artist's artwork; that is fixed. Adding a bucket means adding four
policies, and then proving the refusal.

A service-role key must never appear in any static file. Verify anonymous
insert is refused before calling auth work done.

### 7. Placeholder content is never presented as artist work

Seed art carries real artist names. It renders with a loud pink banner and
`seed/` stays gitignored. The placeholder attract reel
(`assets/attract/placeholder-reel.mp4`) carries a burned-in stripe reading
PLACEHOLDER REEL for the same reason. When sharing a preview containing either,
say so up front.

## DEPLOYING

**[CORRECTED — this section was wrong in the draft.]**

There are two routes and only one of them scales:

**Git (the real route).** Push a branch; Vercel builds it with every asset.
Nothing passes through the agent's context. This is how a full deploy happens.
Never push `main` (invariant 5).

**[CORRECTED]** An agent can take this route unaided: the GitHub MCP's
`create_or_update_file` commits straight to a branch, and a git-connected
Vercel project builds it within seconds. No Terminal, no upload, no click.
Both dashboard fixes on 5 Aug shipped that way. Before committing JS, write it
to disk and `node --check` it, then compare `git hash-object` against the blob
SHA the API returns — that proves the file that landed is the file you
checked.

**The deploy connector (text only).** Every byte must be inlined by the agent,
so it is viable for HTML/CSS/JS and *never* for images or video. The kiosk's
assets are ~3 MB; as base64 through a context window that is roughly a million
tokens. Not slow — impossible.

This is why `flash-gallery-mobilefix` is a `<base href>` overlay borrowing
images from `flash-gallery-preview`. **The overlay has now caused two separate
phantom bugs** — an `!important` rule and a media query that existed only in
the frozen base — and cost more debugging time than it saved. Prefer the git
route. Treat the overlay as a stopgap, and when using it, always check whether
a bug lives in the repo or only in the deployed base.

After creating any deployment you MUST:

1. Confirm state is `READY` — not `BUILDING`, `QUEUED`, `ERROR`, `CANCELED`.
2. **Fetch the deployed URL back.** For JS, fetch through the Vercel connector;
   the generic fetcher returns `[binary data]`.
3. Compare byte-exact against local for anything you inlined by hand.
4. Exercise the thing that changed.
5. Re-fetch production and confirm it is untouched.

Never verify against production before your deploy is `READY`.

**Fetch the deployment's own URL, not the branch alias.** The alias sits behind
a CDN and answers with `x-vercel-cache: HIT` from the *previous* build for a
while after a push. Checking it too early shows the old file and looks exactly
like a fix that did not work. The per-deployment URL is always the build you
mean.

## ALWAYS SHIP A LINK RULE

Every deployment, build, or deliverable is reported **with its URL**, every
time, without being asked. No exceptions.

- Never say something is "deployed", "live", "updated" or "ready" without the
  URL in the same message.
- When a stable alias and a deployment-specific URL both exist, give the
  **stable** one and say plainly if it is currently serving an older build.
- If an earlier URL is now stale, say so explicitly — "use this one, not the
  one from before".
- Maintain **`LINKS.md`** at the repo root listing every live URL: kiosk
  production, each preview project, the dashboard, the Supabase project, and
  the GitHub repo. Update it whenever a URL changes. Joshua works from his
  phone and cannot dig through history for a link.
- A blocked or partial deploy still gets a status line — say which URL is
  current and which is not yet updated. **If there is no deploy connector in
  the session, give the branch name and commit SHA instead and say that is
  what you are giving.**

## DESIGN RULES

| Token | Value | Use |
|---|---|---|
| Primary pink | `#E91E8C` | accents, banner |
| Deep pink | `#C2156F` | card fills behind white text (5.78:1) |
| Logo yellow | `#FDE446` | counts, category card (ink text only) |
| Ink | `#1a1a1a` | text |
| Paper | `#ffffff` / `#f7f7f7` | page ground |

**Contrast is a requirement.** This is read from a metre away by someone
standing up. White on primary pink is 4.18:1 — too thin for a large fill.
State the ratio when you commit a colour. **[CORRECTED]** ink on logo yellow is
**13.94:1**, not the 13.6:1 the draft claimed.

**No borders.** Fill, spacing and shadow separate things — not outlines.

**Page titles are UPPERCASE.** Not body text, captions, buttons or errors.

### No rounded corners — and the two exceptions, both measured

Corners are square. There are exactly **two** recorded exceptions, and they are
recorded precisely so that neither becomes a precedent for a third:

1. **QR container tiles.** Rounded because Joshua asked, and because rounding
   the white *container* cannot affect decoding — only rounding the finder
   patterns can, and that is separately forbidden under QR RULES.

2. **Artist headshots are circles.** `avatars.css` on the kiosk and
   `dashboard/avatar.css` on the dashboard round avatars to 50%, on the artist
   cards, the Follow panel, the dashboard roster and the top bar.

   The reason, stated so it can be argued with: the no-rounded-corners rule
   exists to stop the kiosk drifting into looking like a generic web app. A
   headshot in a hard square does not read as "crisp", it reads as an ID
   photo, and the roster is real people whose faces go on a wall in their own
   shop. A circle is the shape a face is expected to be in, and it is the
   shape that makes the centre-crop in invariant 3 legible — the artist can
   see what is being kept because the mask *is* the crop.

   **Scope: avatars and nothing else.** This is not licence to round buttons,
   tiles, chips or cards. If a third exception is ever wanted, it goes in this
   list with its reason, or it does not happen.

**The dashboard is exempt from the kiosk canvas** and from the no-borders and
no-rounded-corners rules. It is a phone tool, not wall furniture. Never apply
invariant 2 to `dashboard/`.

## ONBOARDING AND HELP

The dashboard teaches itself. `dashboard/tour.js` is a coach-mark walkthrough —
speech bubbles pinned to the real controls — with one script for artists and a
longer one for admins, which is the artist script plus the Artists tab, the
category review queue and the approval queue.

Four rules it must keep, because breaking any of them turns help into an
obstacle:

- **It never blocks the app.** The veil is `pointer-events: none`. Escape, the
  Skip button, or simply ignoring it all work.
- **It never traps focus.** Tab still walks the page. Focus moves to the
  bubble when a step opens; that is all the focus handling there is.
- **A missing anchor is skipped, not fatal.** An empty Requests queue has no
  cards. A step whose element is absent is dropped and the tour continues.
- **Completion lives in `artists.tutorial_seen_at`, not localStorage.** It has
  to follow an artist from her phone to the shop iPad, and Kat has to be able
  to clear it for someone — there is a button on each artist card that does.

**And a fifth, learned the hard way: the bubble must stay reachable.** Its
Next and Skip buttons are the only way forward, so anything that can push them
off screen is a dead end, not a cosmetic flaw. Two things caused exactly that
and are now guarded against in `tour.js`: a scroll handler that called
`render()`, which calls `scrollIntoView`, which fires the scroll handler —
a loop that undid every attempt to scroll; and centring an anchor taller than
the viewport, which puts its bottom edge, and the bubble pinned under it,
below the fold. Reposition on scroll, never re-render; align tall anchors to
the top; clamp the bubble inside the viewport.

**A pane that starts visible will flash.** `dashboard/index.html` hides every
pane and lets `app.js` reveal the right one. The sign-in pane once shipped
without `hidden`, so somebody arriving on a magic link was shown "Email me a
sign-in link" for the length of the token exchange — the one screen that makes
a working link look broken.

Copy is short and plain. These are tattoo artists on phones. No "row-level
security", no "derivative", no "canonical key".

## QR RULES

Measured, not assumed. Sweeping radii against an independent decoder gave:

| | decodes |
|---|---|
| Rounded modules, square finders | **21/21** |
| Square modules, rounded finders | 2/21 |
| Both rounded | 2/21 |

**Rounded modules are free. Rounded finder patterns are fatal.** A decoder
samples each module at its centre, so softening corners never moves the centre.
The finders are not data — they are the targets a decoder hunts by scanning for
a 1:1:3:1:1 run, and rounding breaks that ratio off-centre, so detection fails
before decoding starts.

- Error correction **H**. Ink near-black. Never tint the modules.
- **Quiet zone of 4 modules on every side.** The SVG viewBox is the bare
  matrix, so the CSS padding is the only quiet zone the code gets. Change a
  badge's width and its padding must change with it.
- Physical sizing on a 32" panel (~69 ppi): detail 2.04 mm/module, artist card
  1.42 mm, sheet corner 1.08 mm.

## GRID LAYOUT RULE — **[CORRECTED]**

The draft quoted PRD numbers rather than the code. Actual geometry at 1080:

- 3 columns, **14 px outer padding, 12 px gutter, 342 px square cells**
  (not 25/16/333)
- Single design: 1 col x 1 row
- **A sheet's row span is derived, not fixed at 2x3.** `moduleSpan()` computes
  it from each sheet's real aspect (clamped 1–4) because the studio's four
  sheets are 0.77–1.00, nothing like the 9:16 the PRD assumed. A fixed 2x3
  block cropped the wide ones badly.
- Consecutive sheet modules alternate sides so sheets don't stripe down one
  edge. `arrangeHybrid()` spreads them; `grid-auto-flow: dense` packs them.
- **Sheets letterbox — they do not "never letterbox".** The draft had this
  backwards. `.g-tile-sheet:not(.g-tile-module)` uses `object-fit: contain`
  deliberately, because cropping a sheet to a square hides most of what makes
  it a sheet.

Sparse states: singles-only renders a plain grid; sheets-only follows
invariant 4.

## ATTRACT LOOP

One reel of video clips and flash stills **woven together** — not two modes
that alternate. Configured in `config.js` under `screensaver`.

- Default ratio: one clip, then 4 stills, repeat.
- Stills hold 8 s, matching the existing cadence. Clips run their natural
  duration, capped so a stalled clip cannot own the screen.
- Two stacked layers crossfade; the outgoing frame is never torn down before
  the incoming one paints. That teardown is what causes a black flash, and on a
  wall panel a black flash reads as a fault.
- **Video is stored on the Mac mini's own disk.** Clips download once into
  Cache Storage and play from an in-memory blob thereafter. A looping `<video>`
  pointed at a URL may re-request its media; on an idle kiosk that is the
  difference between ~2.7 GB/month and ~540 GB/month of egress, silently.
  `Screensaver.netFetches()` exists so a test can assert it never climbs.
- **Zero clips = today's sheet slideshow, on the original code path.**
  A clip that fails to load is marked dead for the session and skipped, never
  retried in a loop.

## DATABASE RULE

Schema changes go through the **Supabase MCP** (`apply_migration`), never
hand-written SQL files and never SQL for Joshua to paste.

1. `list_tables` before changing structure.
2. Apply through MCP.
3. **Query the result back** to verify it landed.
4. Run `get_advisors` after DDL and fix what it flags.

Business rules belong in the database where a client cannot bypass them — the
"cannot publish without a category" gate is a Postgres trigger, not a UI check.

**Triggers can silently cancel each other.** `claim_artist_row()` ran during
signup, tripped `artists_guard`, and the guard reset the very column the claim
had just set — because during signup there is no JWT, so `is_admin()` is false.
No error, no claim, every artist stranded. When two triggers touch a table,
check what the second does to the first's write.

**This bites migrations too.** `artists_guard` pins `role`, `auth_user_id` and
`active` for any caller that is not `is_admin()`, and a migration carries no
JWT — so `is_admin()` is false and an `UPDATE ... SET active = true` from
`apply_migration` is silently reverted while the unpinned columns in the same
statement land. `apply_migration` still returns success. Query the row back;
if a pinned column must change, `ALTER TABLE ... DISABLE TRIGGER artists_guard`
for that one statement and re-enable it in the same migration.

`artists_guard` pins `role`, `auth_user_id` and `active` for non-admins and
leaves every other column alone — so `portrait_url`, `portrait_thumb_url` and
`tutorial_seen_at` are self-writable by design.

## BROWSER AND VERIFICATION LIMITS

- The sandbox **cannot reach `*.vercel.app`** — verify deployments through the
  Vercel connector's fetch. It can reach `supabase.co` and the npm/PyPI
  registries.
- **[CORRECTED]** The draft said the sandbox "cannot reach this private repo".
  It can: the **GitHub MCP tools read and write it**, and that is the route to
  use. What fails is the raw GitHub API over the proxy (403) and `add_repo`
  with `access: "read"`. Do not conclude "no repo access" from either — see the
  CAPABILITY CLAIMS RULE.
- **[CORRECTED]** "Git push from the sandbox fails" is true of the `git` CLI
  and beside the point. `create_or_update_file` commits directly to a branch,
  and a git-connected Vercel project builds it. Code can be shipped from a
  session with no Terminal and no local clone.
- Code committed this way still **cannot be pulled back down and run** in the
  sandbox. Fetch it back off the deployment to confirm what shipped; say so
  rather than implying a test ran.
- There is **no browser** in the sandbox. The Chrome extension may or may not
  be connected; check rather than assume. You can confirm markup, endpoints,
  bytes and decoded output; you cannot confirm that a page paints. When the
  last mile needs eyes, say so plainly.
- **Terminal on the Mac is off the table.** Joshua is usually not at the shop.
  Prefer paths that need no Terminal.

## CONTENT AND PEOPLE

The roster is real people whose names appear on a wall in a shop.

- Seniority (Studio Owner / Senior / Junior) is stored but **not displayed** by
  default. Labelling someone "Junior" to a walk-in is the studio's call.
- Instagram handles are data on the artist record, never hardcoded. Handle and
  `instagram_url` move together — a mismatch sends customers to the wrong
  profile.
- **Sheet attribution is invented.** The four real sheets were assigned to Kat
  and Alena so mixed galleries existed to look at. Nobody has said who drew
  them. Correct before production.
- Artist emails are personal data. They are not readable by the kiosk's
  publishable key and must stay that way.
- **Headshots are personal data too, but public by nature** — they go on a wall
  where customers see them. They live in a public bucket. `tutorial_seen_at`
  is the opposite: `anon` has no grant on it, because whether someone has
  finished a walkthrough is nobody's business but the studio's.
- Pricing does not appear on the kiosk unless Joshua says so.

## OPEN DECISIONS

Tracked in `IMPLEMENTATION.md` with a chosen default so nothing blocks. None
are settled:

- Sheets-page QR destination — defaulted to the online gallery
- Whether owner approval gates publishing — defaulted to off; the Review tab
  and the `approved` column already exist, so switching it on needs no migration
- Attribution of the four original flash sheets — provisional, see above
- Whether kiosk-identical type is too small on phones — pending Joshua looking
- Whether per-design videos belong in the grid, or the attract reel is the
  whole video ask — **unanswered**; `screensaver_clips` is deliberately kept
  separate from `designs` so this stays open
- Whether the Follow panel should show the artist's face at all, or whether the
  QR alone is cleaner at 1080 wide — defaulted to showing it, at 160px
