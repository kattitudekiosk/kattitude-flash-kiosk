-- 09 — PROOF of the sign-in gate, not a migration. Run with execute_sql after 08.
--
-- Acts as supabase_auth_admin (the role Supabase Auth inserts logins as) and
-- inserts rows into auth.users directly. That sends NO email: mail only goes
-- out when the Auth API is asked for a link. Everything is rolled back
-- (KTRB2). The allowed and refused cases use throwaway admin and artist
-- cards with @example.invalid addresses, created and removed inside the same
-- rollback. No check depends on how many artists the studio has.

create or replace function pg_temp.kt_gate_proof()
returns table (n int, check_name text, expected text, got text, pass boolean)
language plpgsql as $$
declare
  res jsonb := '[]';
  r   text;
  sw  boolean := true;
begin
  begin
    insert into public.artists (name, email, role, active, kiosk_visible, display_order) values
      ('Gate proof',        'gate.admin.proof@example.invalid',  'admin',  true, false, 1000),
      ('Gate proof artist', 'gate.artist.proof@example.invalid', 'artist', true, false, 1001);

    -- The gate's own judgement on every REAL card with an email, whatever the
    -- roster is today: every non-admin card refused, every active admin allowed.
    res := res || jsonb_build_object('c', 'gate says NO to every non-admin card with an email', 'e', '0',
      'g', (select count(*) from public.artists
             where email is not null and name not like 'Gate proof%'
               and not (role = 'admin' and active) and public.email_on_admin_card(email))::text);
    res := res || jsonb_build_object('c', 'gate says YES to every active admin card with an email', 'e', '0',
      'g', (select count(*) from public.artists
             where email is not null and name not like 'Gate proof%'
               and role = 'admin' and active and not public.email_on_admin_card(email))::text);

    begin
      execute 'set local role supabase_auth_admin';
    exception when others then
      sw := false;
    end;
    res := res || jsonb_build_object('c', 'can act as supabase_auth_admin', 'e', 'true', 'g', sw::text);

    if sw then
      begin
        insert into auth.users (id, email, aud, role)
        values (gen_random_uuid(), 'stranger.proof@example.invalid', 'authenticated', 'authenticated');
        r := 'ok';
      exception when others then r := 'refused ' || sqlstate; end;
      res := res || jsonb_build_object('c', 'gate REFUSES a login for an address on no card', 'e', 'refused 42501', 'g', r);

      begin
        insert into auth.users (id, email, aud, role)
        values (gen_random_uuid(), 'gate.artist.proof@example.invalid', 'authenticated', 'authenticated');
        r := 'ok';
      exception when others then r := 'refused ' || sqlstate; end;
      res := res || jsonb_build_object('c', 'gate REFUSES an address on an ARTIST card', 'e', 'refused 42501', 'g', r);

      begin
        insert into auth.users (id, email, aud, role)
        values (gen_random_uuid(), 'GATE.Admin.Proof@example.invalid', 'authenticated', 'authenticated');
        r := 'ok';
      exception when others then r := 'refused ' || sqlstate; end;
      res := res || jsonb_build_object('c', 'gate ALLOWS an address on an active admin card (any case)', 'e', 'ok', 'g', r);
      execute 'reset role';
    else
      -- Say so, rather than leave three checks silently missing.
      res := res || jsonb_build_object('c', 'gate refusal/allow checks as supabase_auth_admin', 'e', 'run',
        'g', 'NOT RUN: this connection cannot act as supabase_auth_admin');
    end if;

    raise exception 'roll back the gate proof' using errcode = 'KTRB2';
  exception when sqlstate 'KTRB2' then
    null;
  end;

  return query
    select i::int, x->>'c', x->>'e', x->>'g', (x->>'e') = (x->>'g')
      from jsonb_array_elements(res) with ordinality as t(x, i);
end $$;

select * from pg_temp.kt_gate_proof();
