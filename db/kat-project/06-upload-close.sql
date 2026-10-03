-- 06 — Closes the window 05 opened, then proves it is closed and that every
-- file arrived. Run straight after storage-upload.js --upload.
drop policy if exists kt_migration_upload on storage.objects;

select 'temporary policy gone' as check_name,
       (select count(*) from pg_policies where policyname = 'kt_migration_upload') = 0 as pass
union all
select 'all 12 objects stored',
       (select count(*) from storage.objects o
         where (o.bucket_id, o.name) in (values
           ('flash', '14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/IMG_2120/kiosk.jpg'),
           ('flash', '14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/Untitled_Artwork/kiosk.jpg'),
           ('flash', 'e69eecbc-ae36-447b-b924-a64e201eef6b/_kiosk/IMG_1705/kiosk.jpg'),
           ('flash', 'ad5ed37b-ea72-4172-8362-e6d8623c82b1/_kiosk/Untitled_Artwork_2_web/kiosk.jpg'),
           ('flash', '14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/IMG_2120/thumb.jpg'),
           ('flash', '14045c7d-df79-4361-b5e0-3b1c820990dc/_kiosk/Untitled_Artwork/thumb.jpg'),
           ('flash', 'e69eecbc-ae36-447b-b924-a64e201eef6b/_kiosk/IMG_1705/thumb.jpg'),
           ('flash', 'ad5ed37b-ea72-4172-8362-e6d8623c82b1/_kiosk/Untitled_Artwork_2_web/thumb.jpg'),
           ('avatars', '9e767f86-c114-47b4-b7e4-78f780bbdc4f/avatar-msxrpxsk.webp'),
           ('avatars', '5f7e39b9-20a2-4101-8da5-83476636edc3/avatar-msnts7xa.webp'),
           ('avatars', '9e767f86-c114-47b4-b7e4-78f780bbdc4f/avatar-msxrpxsk-sm.webp'),
           ('avatars', '5f7e39b9-20a2-4101-8da5-83476636edc3/avatar-msnts7xa-sm.webp')
         )) = 12;
