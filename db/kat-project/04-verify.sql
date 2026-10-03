-- 04 — PROOF, not a migration. Run with execute_sql after 01–03.
--
-- Every write below happens inside one PL/pgSQL block that ends by raising
-- KTRB1, which rolls the whole block back — test sign-ins, test emails, test
-- rows, all of it. Nothing this file does survives it. Each check runs as the
-- real `anon` or `authenticated` role with a request.jwt.claims for one person,
-- and every refusal is paired with the neighbouring write that must SUCCEED,
-- so a run where everything is refused (a malformed claim, a null
-- current_artist_id()) fails loudly instead of passing.
--
-- Result: one row per check. Every row must say pass = true.

create or replace function pg_temp.kt_try(p_role text, p_sub uuid, p_sql text) returns text
language plpgsql as $$
declare rc bigint; r text;
begin
  perform set_config('request.jwt.claims',
    case when p_role = 'anon' then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql;
    get diagnostics rc = row_count;
    r := 'ok rows=' || rc;
  exception when others then
    r := 'refused ' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create or replace function pg_temp.kt_val(p_role text, p_sub uuid, p_sql text) returns text
language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims',
    case when p_role = 'anon' then '{"role":"anon"}'
         else json_build_object('role', 'authenticated', 'sub', p_sub)::text end, true);
  execute format('set local role %I', p_role);
  begin
    execute p_sql into r;
  exception when others then
    r := 'refused ' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

create or replace function pg_temp.kt_proof()
returns table (n int, check_name text, expected text, got text, pass boolean)
language plpgsql as $$
declare
  res      jsonb := '[]';
  kat      uuid := '14045c7d-df79-4361-b5e0-3b1c820990dc';
  barbie   uuid := 'fbe23a84-7953-47b1-a272-1731cc4a0d01';
  miranda  uuid := 'ad5ed37b-ea72-4172-8362-e6d8623c82b1';
  m_design uuid := 'eb798318-fbcb-4e96-ac66-119896bccf87';   -- Miranda's sheet
  u_kat    uuid := gen_random_uuid();
  u_barbie uuid := gen_random_uuid();
  v        text;
begin
  begin
    -- The data as migrated: shape and the kiosk's view of it.
    res := res || jsonb_build_object('c', 'artists on the wall', 'e', '7',
      'g', (select count(*) from public.artists where active and kiosk_visible)::text);
    res := res || jsonb_build_object('c', 'categories migrated', 'e', '11',
      'g', (select count(*) from public.categories)::text);
    res := res || jsonb_build_object('c', 'designs migrated', 'e', '4',
      'g', (select count(*) from public.designs)::text);
    res := res || jsonb_build_object('c', 'no placeholder art in designs', 'e', '0',
      'g', (select count(*) from public.designs where image_url ~* '(placeholder|seed)')::text);
    res := res || jsonb_build_object('c', 'every table has RLS on', 'e', '0',
      'g', (select count(*) from pg_class
             where relnamespace = 'public'::regnamespace and relkind = 'r'
               and not relrowsecurity)::text);

    -- ANON (the kiosk's publishable key, i.e. anybody on the internet)
    res := res || jsonb_build_object('c', 'anon sees the 4 live designs in kiosk_catalog', 'e', '4',
      'g', pg_temp.kt_val('anon', null, 'select count(*)::text from public.kiosk_catalog'));
    res := res || jsonb_build_object('c', 'anon sees the 7 artists on the wall', 'e', '7',
      'g', pg_temp.kt_val('anon', null, 'select count(*)::text from public.artists'));
    res := res || jsonb_build_object('c', 'anon reads display columns', 'e', 'Kat',
      'g', pg_temp.kt_val('anon', null, format('select name from public.artists where id = %L', kat)));
    res := res || jsonb_build_object('c', 'anon CANNOT read email', 'e', 'refused 42501',
      'g', pg_temp.kt_val('anon', null, 'select email from public.artists limit 1'));
    res := res || jsonb_build_object('c', 'anon CANNOT read role', 'e', 'refused 42501',
      'g', pg_temp.kt_val('anon', null, 'select role from public.artists limit 1'));
    res := res || jsonb_build_object('c', 'anon CANNOT insert a design', 'e', 'refused 42501',
      'g', pg_temp.kt_try('anon', null,
        format($q$insert into public.designs (artist_id, image_url) values (%L, 'x')$q$, barbie)));
    res := res || jsonb_build_object('c', 'anon CANNOT upload to avatars', 'e', 'refused 42501',
      'g', pg_temp.kt_try('anon', null,
        format($q$insert into storage.objects (bucket_id, name) values ('avatars', '%s/x.webp')$q$, barbie)));
    res := res || jsonb_build_object('c', 'anon CANNOT read category requests', 'e', 'refused 42501',
      'g', pg_temp.kt_val('anon', null, 'select count(*)::text from public.category_requests'));

    -- Two test sign-ins. Setting the card's email first, then creating the
    -- login, proves claim_artist_row(); the reverse order proves the guard's
    -- link-on-email path.
    update public.artists set email = 'barbie.proof@example.invalid' where id = barbie;
    insert into auth.users (id, email, aud, role)
    values (u_barbie, 'barbie.proof@example.invalid', 'authenticated', 'authenticated');
    res := res || jsonb_build_object('c', 'first sign-in links the card (claim_artist_row)', 'e', u_barbie::text,
      'g', (select auth_user_id::text from public.artists where id = barbie));

    insert into auth.users (id, email, aud, role)
    values (u_kat, 'kat.proof@example.invalid', 'authenticated', 'authenticated');
    update public.artists set email = 'kat.proof@example.invalid' where id = kat;
    res := res || jsonb_build_object('c', 'email added after sign-in links the card (artists_guard)', 'e', u_kat::text,
      'g', (select auth_user_id::text from public.artists where id = kat));

    -- BARBIE (an artist)
    res := res || jsonb_build_object('c', 'Barbie resolves to her own artist id', 'e', barbie::text,
      'g', pg_temp.kt_val('authenticated', u_barbie, 'select public.current_artist_id()::text'));
    res := res || jsonb_build_object('c', 'Barbie may edit her own bio', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$update public.artists set bio = 'proof' where id = %L$q$, barbie)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT make herself admin', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$update public.artists set role = 'admin' where id = %L$q$, barbie)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT re-link her login', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$update public.artists set auth_user_id = %L where id = %L$q$, u_kat, barbie)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT edit Kat''s card (0 rows)', 'e', 'ok rows=0',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$update public.artists set handle = 'x' where id = %L$q$, kat)));
    res := res || jsonb_build_object('c', 'Barbie may upload her own design', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into public.designs (artist_id, image_url) values (%L, 'proof')$q$, barbie)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT upload as Miranda', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into public.designs (artist_id, image_url) values (%L, 'proof')$q$, miranda)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT retitle Miranda''s sheet (0 rows)', 'e', 'ok rows=0',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$update public.designs set title = 'mine now' where id = %L$q$, m_design)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT delete Miranda''s sheet (0 rows)', 'e', 'ok rows=0',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$delete from public.designs where id = %L$q$, m_design)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT tag Miranda''s sheet', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into public.design_categories (design_id, category_id)
                  select %L, id from public.categories limit 1$q$, m_design)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT rename a category (0 rows)', 'e', 'ok rows=0',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        $q$update public.categories set name = 'x' where slug = 'floral'$q$));
    res := res || jsonb_build_object('c', 'Barbie may upload to her own avatar folder', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into storage.objects (bucket_id, name) values ('avatars', '%s/proof.webp')$q$, barbie)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT write Miranda''s avatar folder', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into storage.objects (bucket_id, name) values ('avatars', '%s/proof.webp')$q$, miranda)));
    res := res || jsonb_build_object('c', 'Barbie CANNOT write Miranda''s flash folder', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        format($q$insert into storage.objects (bucket_id, name) values ('flash', '%s/proof.jpg')$q$, miranda)));
    res := res || jsonb_build_object('c', 'Barbie may request a category', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        $q$insert into public.category_requests (requested_name) values ('Dotwork Proof')$q$));
    res := res || jsonb_build_object('c', 'Barbie CANNOT pre-approve her request', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        $q$insert into public.category_requests (requested_name, status) values ('Sneaky', 'approved')$q$));
    res := res || jsonb_build_object('c', 'Barbie CANNOT approve requests', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_barbie,
        $q$select public.approve_category_request(id, 'theme') from public.category_requests limit 1$q$));
    res := res || jsonb_build_object('c', 'check_category_name finds Floral by any spelling', 'e', 'exists',
      'g', pg_temp.kt_val('authenticated', u_barbie,
        $q$select public.check_category_name('  FLO-ral ')->>'reason'$q$));

    -- KAT (admin). Any other admin card (Joshua's hidden test card) is set
    -- aside first, inside this rollback, so "only admin" means Kat.
    update public.artists set active = false where role = 'admin' and id <> kat;
    res := res || jsonb_build_object('c', 'Kat is admin', 'e', 'true',
      'g', pg_temp.kt_val('authenticated', u_kat, 'select public.is_admin()::text'));
    res := res || jsonb_build_object('c', 'Kat may reorder Barbie', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_kat,
        format($q$update public.artists set display_order = 9 where id = %L$q$, barbie)));
    res := res || jsonb_build_object('c', 'Kat CANNOT change Barbie''s bio (self only)', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_kat,
        format($q$update public.artists set bio = 'kat wrote this' where id = %L$q$, barbie)));
    res := res || jsonb_build_object('c', 'Kat CANNOT demote herself as the only admin', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_kat,
        format($q$update public.artists set role = 'artist' where id = %L$q$, kat)));
    res := res || jsonb_build_object('c', 'Kat may approve Barbie''s request', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_kat,
        $q$select public.approve_category_request(id, 'style') from public.category_requests
            where requested_name = 'Dotwork Proof'$q$));
    res := res || jsonb_build_object('c', 'Kat CANNOT write Barbie''s avatar folder', 'e', 'refused 42501',
      'g', pg_temp.kt_try('authenticated', u_kat,
        format($q$insert into storage.objects (bucket_id, name) values ('avatars', '%s/kat.webp')$q$, barbie)));
    res := res || jsonb_build_object('c', 'Kat may write any flash folder', 'e', 'ok rows=1',
      'g', pg_temp.kt_try('authenticated', u_kat,
        format($q$insert into storage.objects (bucket_id, name) values ('flash', '%s/kat.jpg')$q$, miranda)));

    raise exception 'roll back the proof' using errcode = 'KTRB1';
  exception when sqlstate 'KTRB1' then
    null;   -- everything above is undone; res survives
  end;

  return query
    select i::int, x->>'c', x->>'e', x->>'g', (x->>'e') = (x->>'g')
      from jsonb_array_elements(res) with ordinality as t(x, i);
end $$;

select * from pg_temp.kt_proof();
