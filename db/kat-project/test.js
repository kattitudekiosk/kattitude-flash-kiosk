/* db/kat-project/test.js — run batches 01–04 against a real Postgres.
 *
 * PGlite is Postgres compiled to WebAssembly, so this needs no database
 * server and no Supabase key. A small stand-in for Supabase's own `auth` and
 * `storage` schemas is created first, using the same definitions of
 * auth.uid(), auth.role() and storage.foldername() that Supabase ships, and
 * the same default privileges (everything granted to anon and authenticated,
 * which is exactly why 02 starts by revoking it).
 *
 *   npm install @electric-sql/pglite         (dev-only, never shipped; or
 *                                            PGLITE_NODE_MODULES=<dir>/node_modules)
 *   node db/kat-project/test.js              # every proof must pass
 *   node db/kat-project/test.js --sabotage   # policies opened up: the
 *                                            # refusal proofs MUST fail
 *
 * What this cannot prove: that Supabase's real Storage API and GoTrue behave
 * like the stand-in. 04-verify.sql runs unchanged against Kat's project for
 * that, and the two result sets should match.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// PGLITE_NODE_MODULES: a node_modules folder holding pglite, if not this repo's.
const from = (id) => require(require.resolve(id,
  { paths: [process.env.PGLITE_NODE_MODULES || __dirname].filter(Boolean) }));
const { PGlite } = from('@electric-sql/pglite');
const { pg_trgm } = from('@electric-sql/pglite/contrib/pg_trgm');

const DIR = __dirname;
const SABOTAGE = process.argv.includes('--sabotage');

// PGlite keeps the event loop alive; a stuck statement must not hang forever.
const HARD_TIMEOUT_MS = 60000;
setTimeout(() => { console.error(`test.js: timed out after ${HARD_TIMEOUT_MS / 1000}s`); process.exit(2); },
  HARD_TIMEOUT_MS).unref();

const SUPABASE_STANDIN = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;   -- the role Supabase Auth writes logins as
  create schema extensions;
  create schema auth;
  create schema storage;
  grant usage on schema public, extensions, auth, storage to anon, authenticated, service_role;

  create table auth.users (
    id uuid primary key, email text, aud text, role text,
    created_at timestamptz default now());

  -- As shipped by Supabase (auth schema migrations).
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  create function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $$;
  grant execute on function auth.uid(), auth.role() to anon, authenticated;
  grant usage on schema auth to supabase_auth_admin;
  grant select, insert, update on auth.users to supabase_auth_admin;

  create table storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id), name text, owner uuid,
    created_at timestamptz default now(), unique (bucket_id, name));
  alter table storage.objects enable row level security;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
  create function storage.foldername(name text) returns text[] language plpgsql as $$
    declare _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1:array_length(_parts, 1) - 1];
    end $$;
  grant execute on function storage.foldername(text) to anon, authenticated;

  -- Supabase's default privileges on public.
  alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

/* Opens up exactly the things the refusal proofs exist to catch. If 04 still
 * passes after this, 04 is not testing anything. */
const SABOTAGE_SQL = `
  create policy sabotage_designs  on public.designs  for all to anon, authenticated using (true) with check (true);
  create policy sabotage_artists  on public.artists  for all to authenticated using (true) with check (true);
  create policy sabotage_tags     on public.design_categories for all to authenticated using (true) with check (true);
  create policy sabotage_objects  on storage.objects for all to anon, authenticated using (true) with check (true);
  grant insert on public.designs to anon;
  grant select on public.artists to anon;
  drop trigger artists_guard on public.artists;
`;

(async () => {
  const db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(SUPABASE_STANDIN);
  for (const f of ['01-schema.sql', '02-security.sql', '03-data.sql', '10-designs-own-only.sql']) {
    try { await db.exec(fs.readFileSync(path.join(DIR, f), 'utf8')); }
    catch (e) { console.error(`${f} failed: ${e.message}`); process.exit(1); }
    console.log(`applied ${f}`);
  }
  if (SABOTAGE) { await db.exec(SABOTAGE_SQL); console.log('SABOTAGE: policies opened up'); }

  const results = await db.exec(fs.readFileSync(path.join(DIR, '04-verify.sql'), 'utf8'));
  const rows = results[results.length - 1].rows;
  let failed = 0;
  console.log('');
  for (const r of rows) {
    if (!r.pass) failed++;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.check_name}` +
      (r.pass ? '' : `  — expected ${r.expected}, got ${r.got}`));
  }
  // The rollback inside 04 must leave nothing behind.
  const left = (await db.query(`select
      (select count(*) from auth.users)::int as users,
      (select count(*) from public.designs)::int as designs,
      (select count(*) from public.category_requests)::int as requests,
      (select count(*) from storage.objects)::int as objects,
      (select count(*) from public.artists where email is not null or bio is not null)::int as touched`)).rows[0];
  const clean = left.users === 0 && left.designs === 4 && left.requests === 0 &&
                left.objects === 0 && left.touched === 0;
  console.log(`  ${clean ? 'PASS' : 'FAIL'}  04 left nothing behind ${JSON.stringify(left)}`);
  if (!clean) failed++;

  /* 05/06: the upload window opens for exactly the listed names, and shuts. */
  let total = rows.length + 1;
  const tryAnon = async (sqlText) => (await db.query(
    `select pg_temp.kt_try('anon', null, $1) as r`, [sqlText])).rows[0].r;
  const put = (bucket, name) =>
    `insert into storage.objects (bucket_id, name) values ('${bucket}', '${name}')`;
  const open = fs.readFileSync(path.join(DIR, '05-upload-open.sql'), 'utf8');
  const listed = [...open.matchAll(/\('(flash|avatars)', '([^']+)'\)/g)].map(m => [m[1], m[2]]);
  await db.exec(open);
  const windowChecks = [
    ['05 lists the 12 studio files', String(new Set(listed.map(String)).size), '12'],
    ['05 lets anon upload a listed file', await tryAnon(put(...listed[0])), 'ok rows=1'],
    ['05 refuses an unlisted name', await tryAnon(put('avatars', listed[8][1].replace(/[^/]+$/, 'evil.webp'))), 'refused 42501'],
    ['05 refuses a listed name in the wrong bucket', await tryAnon(put('avatars', listed[0][1])), 'refused 42501'],
  ];
  const closeResult = await db.exec(fs.readFileSync(path.join(DIR, '06-upload-close.sql'), 'utf8'));
  const closeRows = closeResult[closeResult.length - 1].rows;
  windowChecks.push(
    ['06 drops the temporary policy', String(closeRows[0].pass), 'true'],
    ['06 shuts the window (a listed file is refused)', await tryAnon(put(...listed[1])), 'refused 42501'],
    ['06 notices the files were not all uploaded', String(closeRows[1].pass), 'false'],
  );
  /* 07: Joshua's hidden admin card. A fake .invalid address stands in for
   * his — inserting a row sends nothing, and nothing here asks for a link. */
  const card = fs.readFileSync(path.join(DIR, '07-joshua-test-card.sql'), 'utf8');
  const runCard = async (sqlText) => { try { await db.exec(sqlText); return 'ok'; } catch (e) { if (process.env.KT_DEBUG) console.error('07:', e.message); return 'refused'; } };
  windowChecks.push(['07 has exactly one placeholder', String(card.split('__JOSHUA_EMAIL__').length - 1), '1']);
  windowChecks.push(['07 refuses to run with the placeholder left in', await runCard(card), 'refused']);
  const FAKE = 'joshua.proof@example.invalid';
  windowChecks.push(['07 runs with an address in place', await runCard(card.replace('__JOSHUA_EMAIL__', FAKE)), 'ok']);
  windowChecks.push(['07 refuses a second card for the same address', await runCard(card.replace('__JOSHUA_EMAIL__', FAKE)), 'refused']);
  const val = async (role, sub, sqlText) => (await db.query(
    `select pg_temp.kt_val($1, $2::uuid, $3) as r`, [role, sub, sqlText])).rows[0].r;
  const j = (await db.query(`select id, role, active, kiosk_visible from public.artists where name = 'Joshua'`)).rows[0];
  windowChecks.push(['07 card is admin, active, hidden from the wall',
    `${j.role}/${j.active}/${j.kiosk_visible}`, 'admin/true/false']);
  windowChecks.push(['07 anon still sees exactly the 7 wall artists',
    await val('anon', null, 'select count(*)::text from public.artists'), '7']);
  windowChecks.push(['07 anon cannot see the Joshua card',
    await val('anon', null, `select count(*)::text from public.artists where name = 'Joshua'`), '0']);
  windowChecks.push(['07 kiosk_catalog unchanged',
    await val('anon', null, 'select count(*)::text from public.kiosk_catalog'), '4']);
  windowChecks.push(['07 only Joshua\'s card has an email',
    String((await db.query(`select count(*)::int as n from public.artists where email is not null`)).rows[0].n), '1']);
  const U = '00000000-0000-4000-8000-000000000051';   // his login, as Supabase Auth would create it
  await db.query(`insert into auth.users (id, email, aud, role)
                  values ($1, $2, 'authenticated', 'authenticated')`, [U, FAKE]);
  windowChecks.push(['07 his first sign-in links the card',
    await val('authenticated', U, 'select public.current_artist_id()::text'), j.id]);
  windowChecks.push(['07 signed in, he is admin',
    await val('authenticated', U, 'select public.is_admin()::text'), 'true']);
  windowChecks.push(['07 signed in, he sees all 8 cards in the dashboard',
    await val('authenticated', U, 'select count(*)::text from public.artists'), '8']);

  /* The roster grows (Marissa joined on 3 Oct 2026, Kat's card got an
   * email). 04 and 09 must not care: add an on-the-wall artist with an email
   * and give Kat's card one, then run both. */
  await db.exec(`insert into public.artists (name, handle, email, role, active, kiosk_visible, display_order)
                 values ('New artist proof', '@newproof', 'new.artist.proof@example.invalid', 'artist', true, true, 7);
                 update public.artists set email = 'kat.card.proof@example.invalid' where name = 'Kat';`);
  windowChecks.push(['roster grown: 9 cards, 8 on the wall',
    String((await db.query(`select count(*)::int as n from public.artists`)).rows[0].n) + '/' +
    String((await db.query(`select count(*)::int as n from public.artists where active and kiosk_visible`)).rows[0].n), '9/8']);

  /* 08/09: the sign-in gate. 09 is the same file Kat's project runs. */
  windowChecks.push(['08 applies', await runCard(fs.readFileSync(path.join(DIR, '08-signin-gate.sql'), 'utf8')), 'ok']);
  const gate = await db.exec(fs.readFileSync(path.join(DIR, '09-verify-gate.sql'), 'utf8'));
  for (const g of gate[gate.length - 1].rows) windowChecks.push(['09 ' + g.check_name, g.got, g.expected]);
  windowChecks.push(['09 left nothing behind',
    String((await db.query(`select count(*)::int as n from public.artists where name like 'Gate proof%'`)).rows[0].n), '0']);
  const rerun = (await db.exec(fs.readFileSync(path.join(DIR, '04-verify.sql'), 'utf8'))).pop().rows;
  windowChecks.push(['04 still runs after the gate (maintenance role passes)',
    rerun.filter(r => !r.pass).map(r => r.check_name + ': ' + r.got).join('; ') || 'all pass', 'all pass']);

  for (const [name, got, want] of windowChecks) {
    total++;
    const ok = got === want;
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `  — expected ${want}, got ${got}`));
  }

  console.log(`\n${total - failed}/${total} passed` +
    (SABOTAGE ? '  (SABOTAGE MODE: refusal checks are expected to FAIL)' : ''));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
