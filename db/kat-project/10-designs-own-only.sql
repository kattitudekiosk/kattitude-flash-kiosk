-- 10 — A signed-in artist reads only their OWN designs. Migration name
-- `kattitude_designs_own_only`. Run with apply_migration.
--
-- 3 Oct 2026: designs_member_read let any signed-in artist read every
-- PUBLISHED design, so Naomi's "My designs" listed the whole studio. The
-- dashboard now asks only for its own rows; this makes the database agree.
--
-- Unaffected, checked: the phone page and the Mac mini's sync read as anon
-- with the publishable key (designs_public_read, kiosk_catalog), never as a
-- signed-in user. Admins keep every row (Review queue, category merge, All
-- designs). design_categories_read follows automatically: its subquery runs
-- under the caller's designs policy.

drop policy designs_member_read on public.designs;
create policy designs_member_read on public.designs for select to authenticated
  using (artist_id = (select public.current_artist_id()) or (select public.is_admin()));
