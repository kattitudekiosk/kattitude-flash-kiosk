-- 02 — RLS, GRANTS AND STORAGE for Kat's project, migration name
-- `kattitude_security`. Default deny: RLS on every table, then exactly the
-- access server/policy.js gives. Run after 01.

-- ── RLS on, everywhere ───────────────────────────────────────────────────
alter table public.artists            enable row level security;
alter table public.categories         enable row level security;
alter table public.designs            enable row level security;
alter table public.design_categories  enable row level security;
alter table public.category_requests  enable row level security;
alter table public.flash_sales        enable row level security;
alter table public.flash_sale_tiers   enable row level security;
alter table public.flash_sale_media   enable row level security;
alter table public.flash_sale_designs enable row level security;

-- ── Grants. RLS filters rows, not columns — column grants do that. ───────
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant select, insert, update, delete on all tables in schema public to authenticated;

-- The kiosk's publishable key is in page source. It may read live content and
-- the display columns of an artist — never email, role, auth link or
-- tutorial progress. A NEW artists column is invisible to the kiosk until it
-- is added here AND to config.js's explicit select list.
grant select (id, name, handle, portrait_url, portrait_thumb_url, bio, instagram_url,
              seniority, display_order, active, kiosk_visible)
  on public.artists to anon;
grant select on public.categories, public.designs, public.design_categories,
                public.flash_sales, public.flash_sale_tiers, public.flash_sale_media,
                public.flash_sale_designs, public.kiosk_catalog
  to anon;

-- Helpers the policies call must be executable by whoever the policy runs as.
grant execute on function public.current_artist_id(), public.is_admin(), public.is_api_caller(),
                          public.category_normalize(text), public.category_key(text),
                          public.category_near_matches(text)
  to anon, authenticated;
grant execute on function public.check_category_name(text),
                          public.approve_category_request(uuid, text),
                          public.reject_category_request(uuid, text),
                          public.merge_category_request(uuid, uuid, text)
  to authenticated;
-- Trigger functions run as triggers only; nobody calls them through the API.

-- ── artists ──────────────────────────────────────────────────────────────
create policy artists_public_read on public.artists for select to anon
  using (active and kiosk_visible);
create policy artists_member_read on public.artists for select to authenticated
  using (active or auth_user_id = (select auth.uid()) or (select public.is_admin()));
create policy artists_admin_insert on public.artists for insert to authenticated
  with check ((select public.is_admin()));
-- An artist may update their own row; which COLUMNS is artists_guard's job.
create policy artists_self_or_admin_update on public.artists for update to authenticated
  using      (auth_user_id = (select auth.uid()) or (select public.is_admin()))
  with check (auth_user_id = (select auth.uid()) or (select public.is_admin()));
create policy artists_admin_delete on public.artists for delete to authenticated
  using ((select public.is_admin()));

-- ── categories ───────────────────────────────────────────────────────────
create policy categories_read on public.categories for select to anon, authenticated using (true);
create policy categories_admin_insert on public.categories for insert to authenticated
  with check ((select public.is_admin()));
create policy categories_admin_update on public.categories for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy categories_admin_delete on public.categories for delete to authenticated
  using ((select public.is_admin()));

-- ── designs ──────────────────────────────────────────────────────────────
create policy designs_public_read on public.designs for select to anon
  using (published and approved);
create policy designs_member_read on public.designs for select to authenticated
  using ((published and approved)
         or artist_id = (select public.current_artist_id())
         or (select public.is_admin()));
create policy designs_own_insert on public.designs for insert to authenticated
  with check (artist_id = (select public.current_artist_id()) or (select public.is_admin()));
create policy designs_own_update on public.designs for update to authenticated
  using      (artist_id = (select public.current_artist_id()) or (select public.is_admin()))
  with check (artist_id = (select public.current_artist_id()) or (select public.is_admin()));
create policy designs_own_delete on public.designs for delete to authenticated
  using (artist_id = (select public.current_artist_id()) or (select public.is_admin()));

-- ── design_categories (the subquery runs under the caller's designs RLS) ─
create policy design_categories_read on public.design_categories for select to anon, authenticated
  using (exists (select 1 from public.designs d where d.id = design_id));
create policy design_categories_own_insert on public.design_categories for insert to authenticated
  with check (exists (select 1 from public.designs d where d.id = design_id
                       and (d.artist_id = (select public.current_artist_id()) or (select public.is_admin()))));
create policy design_categories_own_delete on public.design_categories for delete to authenticated
  using (exists (select 1 from public.designs d where d.id = design_id
                  and (d.artist_id = (select public.current_artist_id()) or (select public.is_admin()))));

-- ── category_requests (answered only through the security-definer RPCs) ──
alter table public.category_requests alter column requested_by set default public.current_artist_id();
create policy category_requests_read on public.category_requests for select to authenticated
  using (requested_by = (select public.current_artist_id()) or (select public.is_admin()));
create policy category_requests_insert on public.category_requests for insert to authenticated
  with check (requested_by = (select public.current_artist_id())
              and status = 'pending' and review_note is null
              and merged_into_category_id is null and reviewed_at is null);
create policy category_requests_admin_delete on public.category_requests for delete to authenticated
  using ((select public.is_admin()));

-- ── flash sales: public when published, written by an admin ──────────────
create policy flash_sales_read on public.flash_sales for select to anon, authenticated
  using (published or (select public.is_admin()));
create policy flash_sales_admin_insert on public.flash_sales for insert to authenticated with check ((select public.is_admin()));
create policy flash_sales_admin_update on public.flash_sales for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy flash_sales_admin_delete on public.flash_sales for delete to authenticated using ((select public.is_admin()));

create policy flash_sale_tiers_read on public.flash_sale_tiers for select to anon, authenticated
  using (exists (select 1 from public.flash_sales s where s.id = sale_id));
create policy flash_sale_tiers_admin_insert on public.flash_sale_tiers for insert to authenticated with check ((select public.is_admin()));
create policy flash_sale_tiers_admin_update on public.flash_sale_tiers for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy flash_sale_tiers_admin_delete on public.flash_sale_tiers for delete to authenticated using ((select public.is_admin()));

create policy flash_sale_media_read on public.flash_sale_media for select to anon, authenticated
  using (exists (select 1 from public.flash_sales s where s.id = sale_id));
create policy flash_sale_media_admin_insert on public.flash_sale_media for insert to authenticated with check ((select public.is_admin()));
create policy flash_sale_media_admin_update on public.flash_sale_media for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy flash_sale_media_admin_delete on public.flash_sale_media for delete to authenticated using ((select public.is_admin()));

create policy flash_sale_designs_read on public.flash_sale_designs for select to anon, authenticated
  using (exists (select 1 from public.flash_sales s where s.id = sale_id));
create policy flash_sale_designs_admin_insert on public.flash_sale_designs for insert to authenticated with check ((select public.is_admin()));
create policy flash_sale_designs_admin_delete on public.flash_sale_designs for delete to authenticated using ((select public.is_admin()));

-- ── Storage: three public-read buckets, writes scoped by first folder ────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('flash',      'flash',      true, 52428800, array['image/jpeg','image/png','image/webp']),
  ('avatars',    'avatars',    true,  5242880, array['image/webp','image/jpeg','image/png']),
  ('sale-media', 'sale-media', true, 104857600, array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/quicktime','video/webm'])
on conflict (id) do nothing;

-- flash/<artist_id>/... — your own folder, or any folder if admin.
create policy flash_read_own on storage.objects for select to authenticated
  using (bucket_id = 'flash' and ((storage.foldername(name))[1] = (select public.current_artist_id())::text
                                  or (select public.is_admin())));
create policy flash_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'flash' and ((storage.foldername(name))[1] = (select public.current_artist_id())::text
                                       or (select public.is_admin())));
create policy flash_update_own on storage.objects for update to authenticated
  using      (bucket_id = 'flash' and ((storage.foldername(name))[1] = (select public.current_artist_id())::text
                                       or (select public.is_admin())))
  with check (bucket_id = 'flash' and ((storage.foldername(name))[1] = (select public.current_artist_id())::text
                                       or (select public.is_admin())));
create policy flash_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'flash' and ((storage.foldername(name))[1] = (select public.current_artist_id())::text
                                  or (select public.is_admin())));

-- avatars/<artist_id>/... — your own folder ONLY. Admin is not enough.
create policy avatars_read_own on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select public.current_artist_id())::text);
create policy avatars_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select public.current_artist_id())::text);
create policy avatars_update_own on storage.objects for update to authenticated
  using      (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select public.current_artist_id())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select public.current_artist_id())::text);
create policy avatars_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select public.current_artist_id())::text);

-- sale-media/<sale_id>/... — flash sale branding, an admin's job.
create policy sale_media_admin_read on storage.objects for select to authenticated
  using (bucket_id = 'sale-media' and (select public.is_admin()));
create policy sale_media_admin_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'sale-media' and (select public.is_admin()));
create policy sale_media_admin_update on storage.objects for update to authenticated
  using (bucket_id = 'sale-media' and (select public.is_admin()))
  with check (bucket_id = 'sale-media' and (select public.is_admin()));
create policy sale_media_admin_delete on storage.objects for delete to authenticated
  using (bucket_id = 'sale-media' and (select public.is_admin()));
