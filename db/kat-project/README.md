# Moving to Kat's Supabase — `hnwyoglbmhvafxnzizqe`

From Joshua's `tovydesiocfgmasvzjvt` to Kat's project (`supabase-blue-cave`,
Vercel-managed org). Written 3 Oct 2026.

**Source of the data:** the studio database on the kiosk Mac mini
(`~/KattitudeData/kattitude.db`) and `~/Desktop/KIOSK MEDIA`. Checked against
the old project's public rows on 3 Oct 2026: the same 7 artists, 11
categories and ids, and the two headshots are byte-identical.
`KIOSK MEDIA/placeholder/` is never read.

**Why this folder is not `supabase/`:** Supabase's GitHub integration is
attached to Kat's project (it posts a "Supabase Preview" check on every push).
It could run a `supabase/migrations` folder by itself. These batches run
by hand, in order, once.

**CLAUDE.md's DATABASE RULE says to use `apply_migration`, not SQL files.**
Run 01, 02, 03 and 05 with `apply_migration`, using the names in their
headers. Run 04 and 06 with `execute_sql`. These files are the readable
record, like `db/schema.sql`. They are not meant to be pasted.

| # | File | Run with | What it does |
|---|---|---|---|
| 00 | `00-inspect.sql` | execute_sql | Read only. Shows what is already in the project. |
| 01 | `01-schema.sql` | apply_migration `kattitude_schema` | Tables, views, guards, the sign-in claim, the category RPCs. Refuses to run over an existing schema. |
| 02 | `02-security.sql` | apply_migration `kattitude_security` | RLS on every table, column grants, 3 buckets and their policies. |
| 03 | `03-data.sql` | apply_migration `kattitude_data` | 7 artists, 11 categories, 4 sheets, using the same ids. |
| 04 | `04-verify.sql` | execute_sql | 40 proofs, each run as the real `anon` / `authenticated` role, then everything rolled back. Every row must say `pass = true`. |
| 05 | `05-upload-open.sql` | apply_migration `kattitude_upload_window` | Temporary: the public key may insert exactly 12 named files. |
| — | `node storage-upload.js --upload <publishable key>` | this Mac | Uploads the 12 files and re-downloads each one to compare sha256. |
| 06 | `06-upload-close.sql` | execute_sql | Drops the temporary policy and checks all 12 files arrived. |
| 07 | `07-joshua-test-card.sql` | execute_sql | Joshua's hidden admin test card. His address goes on the one marked line, in the copy that runs, never in the repo. |

**Done 3 Oct 2026:** 00–06 ran on Kat's project. 04 passed 40/40, and 12/12
files were stored byte for byte. Auth URL configuration is set.

## NO EMAIL TO ARTISTS OR KAT, until Joshua says so

Joshua, 3 Oct 2026: *"I don't want you to send the Artist any emails until I
check to make sure that it's working. I have a profile for me so send only
to me first."* That means no invites, no magic links, no artist emails added
to Kat's project, and no test that asks Supabase for a link. Joshua's card
(07) gets the first link once SMTP is set up. Inserting a row never sends
mail; the proofs insert fake `@example.invalid` users straight into
`auth.users`, which sends nothing. Both hosted dashboard pages
(`index.html` and the old `standalone.html`) load `hosted-notice.js`, so
neither can request a link.

Test everything locally first, with no key and no network:
`node db/kat-project/test.js` (60 checks). Also run
`node db/kat-project/test.js --sabotage`: it must FAIL its refusal checks.

## What cannot be done without a key or a click

- **Old sign-ins and emails cannot be moved.** `auth.users` and
  `artists.email` are not readable with the public key. Everyone signs in
  again once. The first sign-in links their login to their card by email
  (`claim_artist_row`).
- **Kat's and the artists' emails wait for Joshua** (see above). When he says
  so, they go on through the connector, never into this repo.
- **Auth settings are not SQL.** In Kat's Supabase dashboard:
  - Auth → URL Configuration → Site URL:
    `https://kattitude-flash-kiosk.vercel.app/dashboard/`
  - Redirect URLs: the same URL with `**` on the end, plus
    `http://localhost:8787/dashboard/**`
  - Auth → SMTP: Supabase's built-in mailer only sends to the project's own
    team members and only a few emails an hour, so artists will not get
    links until custom SMTP is set up.
- **The publishable key** is needed for `storage-upload.js` and for
  `config.js` / `dashboard/config.js`. It is public by design. Get it from
  the connector or from Settings → API Keys. **Never use a `sb_secret_` key**
  in any of these steps.
- **Known gap, carried over from the old project:** a signed-in artist can
  read colleagues' `email` column, because the dashboard selects `*` from
  `artists` and Postgres column grants cannot vary by row. Fixing it means
  moving emails to an admin-only table and changing the dashboard.
