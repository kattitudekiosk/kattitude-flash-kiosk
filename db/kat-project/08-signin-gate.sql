-- 08 — SIGN-IN GATE, migration name `kattitude_signin_gate`.
--
-- Joshua, 3 Oct 2026: no email to any artist or to Kat until he has checked
-- sign-in works on his own card. Enforced in the database, not the page,
-- because anybody can ask Supabase Auth for a link with the public key.
--
-- Supabase Auth creates the login (a row in auth.users) BEFORE it sends a
-- magic link. This trigger refuses that row unless the address is on an
-- ACTIVE ADMIN card. A refused address gets an error and NO email. Today the
-- only admin card with an email is Joshua's, so only he can get a link.
--
-- Only Supabase Auth's own role is gated. The SQL editor, migrations and the
-- proofs in 04 run as postgres / supabase_admin and pass.
--
-- TO LIFT THE GATE (only when Joshua says so):
--   drop trigger signin_gate on auth.users;

create function public.email_on_admin_card(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.artists
                  where lower(email) = lower(btrim(p_email)) and role = 'admin' and active)
$$;
revoke all on function public.email_on_admin_card(text) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.email_on_admin_card(text) to supabase_auth_admin;

-- SECURITY INVOKER on purpose: current_user is then the role that inserted
-- the login, which is how Supabase Auth is told apart from a maintenance
-- session. Anything that is not postgres/supabase_admin is gated (fail closed).
create function public.signin_gate() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if new.email is null or not public.email_on_admin_card(new.email) then
    raise exception 'Sign-in is limited to admin cards while Joshua tests the dashboard'
      using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.signin_gate() from public, anon, authenticated;

create trigger signin_gate before insert or update of email on auth.users
  for each row execute function public.signin_gate();
