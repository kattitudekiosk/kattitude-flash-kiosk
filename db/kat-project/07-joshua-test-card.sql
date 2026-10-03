-- 07 — Joshua's hidden admin TEST card. Run with execute_sql.
--
-- Joshua, 3 Oct 2026: no email to any artist or to Kat until he has checked
-- sign-in works on his own card. This card is how: admin, active (so the
-- dashboard lets him in), kiosk_visible = false (so it is never on the wall or
-- the phone page). It replaces the old project's hidden developer card
-- 381e9ad7, which was not migrated.
--
-- Put his address on the line marked "<-- HIS EMAIL" (the only placeholder in
-- this file), in the copy you run. NEVER commit it: the repository is public.
--
-- Inserting a row sends no email. The first email goes out only when a
-- sign-in link is requested for this address, after SMTP is set up. His first
-- sign-in then links the login to this card (claim_artist_row).

do $$
declare
  e text := lower(btrim('__JOSHUA_EMAIL__'));   -- <-- HIS EMAIL
begin
  if e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Put Joshua''s email address on the line marked HIS EMAIL first';
  end if;
  if exists (select 1 from public.artists where lower(email) = e) then
    raise exception 'A card with that email already exists';
  end if;
  insert into public.artists (name, email, role, active, kiosk_visible, display_order)
  values ('Joshua', e, 'admin', true, false, 999);
end $$;

select id, name, role, active, kiosk_visible, display_order,
       email is not null as has_email, auth_user_id is not null as signed_in,
       (select count(*) from public.artists where email is not null) as cards_with_email
  from public.artists
 where name = 'Joshua';
