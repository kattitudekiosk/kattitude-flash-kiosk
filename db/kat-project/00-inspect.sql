-- 00 — READ ONLY. What is already in Kat's project (hnwyoglbmhvafxnzizqe)?
-- Run first. Batch 01 refuses to run if the kiosk tables already exist.
select 'table' as kind, table_schema || '.' || table_name as name
  from information_schema.tables
 where table_schema in ('public', 'storage')
union all
select 'bucket', id from storage.buckets
union all
select 'extension', extname || ' ' || extversion from pg_extension
union all
select 'auth users', count(*)::text from auth.users
union all
select 'public function', p.proname
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
union all
select 'server', current_setting('server_version')
order by 1, 2;
