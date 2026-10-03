-- 03 — DATA for Kat's project, migration name `kattitude_data`.
-- Generated from the studio database (~/KattitudeData/kattitude.db) on the kiosk
-- Mac mini — the live source of truth since 2 Oct 2026, and identical to the old
-- project's public rows (checked 3 Oct 2026). Same ids, so nothing re-links.
-- NOT included: KIOSK MEDIA/placeholder/ (placeholder art is never public),
-- emails (none are stored locally) and sign-ins (they cannot be moved).
-- Image URLs point at Kat's storage; the files are uploaded separately (05/06).
-- Run as ONE apply_migration so it lands whole or not at all.


insert into public.artists (id, name, handle, bio, seniority, instagram_url, display_order, active, kiosk_visible, role, portrait_url, portrait_thumb_url, tutorial_seen, tutorial_snoozed, tutorial_seen_at, created_at) values
  ('14045c7d-df79-4361-b5e0-3b1c820990dc', 'Kat', '@Kattitudetattoo', null, 'Studio Owner', 'https://instagram.com/Kattitudetattoo', 0, true, true, 'admin', null, null, array['upload-start','upload-sizes','upload-tagging','upload-request-category','designs-needs-category','designs-tab','my-photo','artists-add','artists-invite','flashsales-create','review-queue','help-button']::text[], '{}'::text[], '2026-10-02T17:47:54.678Z', '2026-10-02T17:41:28.927Z'),
  ('fbe23a84-7953-47b1-a272-1731cc4a0d01', 'Barbie', '@delicatelyscripted', null, 'Senior Artist', 'https://instagram.com/delicatelyscripted', 1, true, true, 'artist', null, null, '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.929Z'),
  ('ad5ed37b-ea72-4172-8362-e6d8623c82b1', 'Miranda', '@mirandaiink', null, 'Junior Artist', 'https://instagram.com/mirandaiink', 2, true, true, 'artist', null, null, '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.929Z'),
  ('e69eecbc-ae36-447b-b924-a64e201eef6b', 'Jen', '@inkedbyjemini', null, 'Junior Artist', 'https://instagram.com/inkedbyjemini', 3, true, true, 'artist', null, null, '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.929Z'),
  ('9e767f86-c114-47b4-b7e4-78f780bbdc4f', 'Naomi', '@Puratinta_26', null, 'Junior Artist', 'https://instagram.com/Puratinta_26', 4, true, true, 'artist', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/avatars/9e767f86-c114-47b4-b7e4-78f780bbdc4f/avatar-msxrpxsk.webp', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/avatars/9e767f86-c114-47b4-b7e4-78f780bbdc4f/avatar-msxrpxsk-sm.webp', '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.930Z'),
  ('3dc3e452-ce74-443d-a01d-60cbacca976f', 'Ally', '@allycat_ink', null, 'Junior Artist', 'https://instagram.com/allycat_ink', 5, true, true, 'artist', null, null, '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.930Z'),
  ('5f7e39b9-20a2-4101-8da5-83476636edc3', 'Alena', '@Alenanebotattoos', null, 'Senior Artist', 'https://instagram.com/Alenanebotattoos', 6, true, true, 'artist', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/avatars/5f7e39b9-20a2-4101-8da5-83476636edc3/avatar-msnts7xa.webp', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/avatars/5f7e39b9-20a2-4101-8da5-83476636edc3/avatar-msnts7xa-sm.webp', '{}'::text[], '{}'::text[], null, '2026-10-02T17:41:28.930Z');

insert into public.categories (id, name, slug, kind, display_order, created_at) values
  ('1f7b842a-5c80-49cd-b422-7045f4d18d08', 'Single Needle', 'single-needle', 'style', 1, '2026-08-02T14:30:07.073Z'),
  ('0359871d-0205-4b31-bbf9-189e66783688', 'Three Needle', 'three-needle', 'style', 2, '2026-08-02T14:30:07.073Z'),
  ('970910ef-b9a6-4226-8906-c4ae7d33d529', 'Micro Realism', 'micro-realism', 'style', 3, '2026-08-02T14:30:07.073Z'),
  ('4792f404-de0d-4987-8b0c-b17cf5f6e968', 'Realism', 'realism', 'style', 4, '2026-08-02T14:30:07.073Z'),
  ('7c698c6d-a165-4891-99b9-6851ab3f23cd', 'Color', 'color', 'style', 5, '2026-08-02T14:30:07.073Z'),
  ('2ec152ca-a60b-4d3e-83ae-e2e874020c39', 'Gothic', 'gothic', 'style', 6, '2026-08-02T14:30:07.073Z'),
  ('c7379d10-4b09-4bb1-80f3-59c6c54c167c', 'Abstract', 'abstract', 'style', 7, '2026-08-02T14:30:07.073Z'),
  ('df62d405-e107-422b-88a8-e3f3ea19fee4', 'Floral', 'floral', 'style', 8, '2026-08-02T14:30:07.073Z'),
  ('57bed4a7-825a-49b6-b9f2-f0e65d3dfc66', 'Large Scale', 'large-scale', 'style', 9, '2026-08-02T14:30:07.073Z'),
  ('5faef9e2-4302-4b2c-bd4a-2e170290606d', 'FRIDAY THE 13TH', 'friday-the-13th', 'subject', 10, '2026-08-06T00:28:44.663Z'),
  ('3a173c9b-d58a-4be6-9c39-46ca84c2f0e2', 'Flash sheets', 'flash-sheets', 'theme', 11, '2026-08-18T01:01:56.417Z');

insert into public.designs (id, artist_id, title, notes, price_band, image_url, thumb_url, width, height, type, source_sheet_id, display_order, featured, published, approved, keywords, source_file, source_sig, created_at) values
  ('5874707c-6970-4595-9adc-da3e025d04cb', '14045c7d-df79-4361-b5e0-3b1c820990dc', 'IMG 2120', null, null, 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/IMG_2120/kiosk.jpg', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/IMG_2120/thumb.jpg', 1320, 1615, 'sheet', null, 0, false, true, true, null, 'Kat/Designs/IMG_2120.JPEG', '345655-1785624036000', '2026-10-02T22:57:29.003Z'),
  ('91067aeb-04ce-4d55-8968-473e339f880e', '14045c7d-df79-4361-b5e0-3b1c820990dc', 'Untitled Artwork', null, null, 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/Untitled_Artwork/kiosk.jpg', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/Untitled_Artwork/thumb.jpg', 2160, 2795, 'sheet', null, 0, false, true, true, null, 'Kat/Designs/Untitled_Artwork.JPEG', '384262-1785624036000', '2026-10-02T22:57:29.145Z'),
  ('41ea6880-6cd1-41f3-b1fc-c5718878e054', 'e69eecbc-ae36-447b-b924-a64e201eef6b', 'IMG 1705', null, null, 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/e69eecbc-ae36-447b-b924-a64e201eef6b/_kiosk/IMG_1705/kiosk.jpg', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/e69eecbc-ae36-447b-b924-a64e201eef6b/_kiosk/IMG_1705/thumb.jpg', 1320, 1677, 'sheet', null, 0, false, true, true, null, 'Jen/Designs/IMG_1705.JPEG', '215984-1785624036000', '2026-10-02T22:57:29.213Z'),
  ('eb798318-fbcb-4e96-ac66-119896bccf87', 'ad5ed37b-ea72-4172-8362-e6d8623c82b1', 'Untitled Artwork 2 web', null, null, 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/ad5ed37b-ea72-4172-8362-e6d8623c82b1/_kiosk/Untitled_Artwork_2_web/kiosk.jpg', 'https://hnwyoglbmhvafxnzizqe.supabase.co/storage/v1/object/public/flash/ad5ed37b-ea72-4172-8362-e6d8623c82b1/_kiosk/Untitled_Artwork_2_web/thumb.jpg', 2160, 2160, 'sheet', null, 0, false, true, true, null, 'Miranda/Designs/Untitled_Artwork_2_web.JPEG', '418319-1785624036000', '2026-10-02T23:11:25.816Z');

-- design_categories, category_requests and every flash_sale* table are empty in
-- the studio database (counted at generation time), so there is nothing to copy.
