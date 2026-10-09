-- 11 — CLEAR TITLES MADE UP FROM FILE NAMES. Run with execute_sql: the
-- SELECT first (a preview, changes nothing), then the UPDATE.
--
-- Joshua, 9 Oct 2026: "Please remove the 'titles' of the flash sheets, because
-- they don't have names and it just shows as a file string. Only add a
-- title/name if they add it to the form when they upload."
--
-- The dashboard used to pre-fill a title from the file name. These patterns
-- are the same as server/titles.js (which clears them on the Mac): phone
-- camera names (IMG 1185, IMG_1185, IMG 1185 2), Procreate's "Untitled
-- Artwork…", other camera/screenshot names, and a title equal to the design's
-- own file name (source_file, for folder imports). Anything else — a name a
-- person typed — is kept.

-- ① PREVIEW: what would be cleared, and what is kept.
select d.id, a.name as artist, d.title, d.published,
       case when (
              d.title ~* '^\s*$'
           or d.title ~* '^IMG[ _-]?[0-9]+( [0-9]+)?$'
           or d.title ~* '^Untitled[ _-]?Artwork'
           or d.title ~* '^(DSC|DSCN|DSCF|PXL|MVIMG|PHOTO|IMAGE|Screenshot|Screen Shot)[ _-]?[0-9]'
           or (d.source_file is not null and lower(d.title) = lower(trim(regexp_replace(regexp_replace(
                 regexp_replace(d.source_file, '^.*/', ''), '\.[^.]+$', ''), '[_-]+', ' ', 'g'))))
         ) then 'WILL CLEAR' else 'keep (typed)' end as action
  from public.designs d
  left join public.artists a on a.id = d.artist_id
 where d.title is not null
 order by action desc, a.name, d.title;

-- ② UPDATE: clear exactly the rows the preview marks WILL CLEAR.
update public.designs d
   set title = null
 where d.title is not null
   and (
         d.title ~* '^\s*$'
      or d.title ~* '^IMG[ _-]?[0-9]+( [0-9]+)?$'
      or d.title ~* '^Untitled[ _-]?Artwork'
      or d.title ~* '^(DSC|DSCN|DSCF|PXL|MVIMG|PHOTO|IMAGE|Screenshot|Screen Shot)[ _-]?[0-9]'
      or (d.source_file is not null and lower(d.title) = lower(trim(regexp_replace(regexp_replace(
            regexp_replace(d.source_file, '^.*/', ''), '\.[^.]+$', ''), '[_-]+', ' ', 'g'))))
       )
returning d.id, d.title;
