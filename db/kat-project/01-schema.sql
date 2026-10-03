-- 01 — SCHEMA for Kat's project (hnwyoglbmhvafxnzizqe), migration name
-- `kattitude_schema`. Built from db/schema.sql (v1) plus everything the old
-- project (tovydesiocfgmasvzjvt) grew afterwards, as mirrored column for
-- column by server/db.js, server/policy.js and server/rpc.js. The old
-- project's own migrations were never committed and cannot be read without
-- its secret key, so those three files are the record this is built from.
--
-- Refuses to run over an existing schema.

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'public'
                and table_name in ('artists', 'designs', 'categories')) then
    raise exception 'public.artists/designs/categories already exist — run 00-inspect.sql and stop';
  end if;
end $$;

create extension if not exists pg_trgm with schema extensions;

-- ── Tables ───────────────────────────────────────────────────────────────
create table public.artists (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  handle             text unique,
  email              text,                       -- personal: never granted to anon
  portrait_url       text,
  portrait_thumb_url text,
  bio                text,
  seniority          text,                       -- stored, not displayed
  instagram_url      text,
  display_order      integer not null default 0,
  active             boolean not null default true,   -- may use the dashboard
  kiosk_visible      boolean not null default true,   -- appears on the wall
  role               text not null default 'artist' check (role in ('artist', 'admin')),
  auth_user_id       uuid unique references auth.users (id) on delete set null,
  tutorial_seen      text[] default '{}',
  tutorial_snoozed   text[] default '{}',
  tutorial_seen_at   timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index artists_email_lower_key on public.artists (lower(email)) where email is not null;
create index artists_active_order_idx on public.artists (active, display_order);

create table public.categories (
  id              uuid primary key default gen_random_uuid(),
  name            text not null unique,
  slug            text not null unique,
  kind            text not null default 'style' check (kind in ('style', 'theme', 'subject')),
  display_order   integer not null default 0,
  normalized_name text,
  canonical_key   text unique,
  created_at      timestamptz not null default now()
);

create table public.designs (
  id              uuid primary key default gen_random_uuid(),
  artist_id       uuid references public.artists (id) on delete set null,
  title           text,
  notes           text,
  price_band      text,
  image_url       text not null,
  thumb_url       text,
  width           integer,
  height          integer,
  type            text not null default 'design' check (type in ('design', 'sheet')),
  source_sheet_id uuid references public.designs (id) on delete set null,
  display_order   integer not null default 0,
  featured        boolean not null default false,
  published       boolean not null default false,
  approved        boolean not null default true,
  keywords        text,
  source_file     text unique,     -- set only for KIOSK MEDIA folder imports
  source_sig      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint designs_source_not_self check (source_sheet_id is null or source_sheet_id <> id)
);
create index designs_artist_idx on public.designs (artist_id);
create index designs_type_idx   on public.designs (type);
create index designs_live_idx   on public.designs (published, approved);
create index designs_order_idx  on public.designs (display_order, created_at desc);
create index designs_source_sheet_idx on public.designs (source_sheet_id);

create table public.design_categories (
  design_id   uuid not null references public.designs (id)    on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  primary key (design_id, category_id)
);
create index design_categories_category_idx on public.design_categories (category_id);

create table public.category_requests (
  id                      uuid primary key default gen_random_uuid(),
  requested_name          text not null,
  requested_by            uuid references public.artists (id) on delete cascade,
  status                  text not null default 'pending'
                          check (status in ('pending', 'approved', 'rejected', 'merged')),
  review_note             text,
  merged_into_category_id uuid references public.categories (id) on delete set null,
  reviewed_at             timestamptz,
  created_at              timestamptz not null default now()
);
create index category_requests_by_idx on public.category_requests (requested_by);
create index category_requests_merged_idx on public.category_requests (merged_into_category_id);

create table public.flash_sales (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  subtitle   text,
  starts_at  timestamptz,
  ends_at    timestamptz,
  published  boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.flash_sale_tiers (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.flash_sales (id) on delete cascade,
  price_cents   integer not null check (price_cents > 0),
  label         text,
  display_order integer not null default 0,
  created_at    timestamptz not null default now(),
  unique (sale_id, price_cents)
);

create table public.flash_sale_media (
  id            uuid primary key default gen_random_uuid(),
  sale_id       uuid not null references public.flash_sales (id) on delete cascade,
  url           text not null,
  media_type    text not null default 'image' check (media_type in ('image', 'video')),
  display_order integer not null default 0,
  created_at    timestamptz not null default now()
);
create index flash_sale_media_sale_idx on public.flash_sale_media (sale_id);

create table public.flash_sale_designs (
  sale_id   uuid not null references public.flash_sales (id) on delete cascade,
  design_id uuid not null references public.designs (id)     on delete cascade,
  primary key (sale_id, design_id)
);
create index flash_sale_designs_design_idx on public.flash_sale_designs (design_id);

-- ── Identity helpers (used by every policy) ──────────────────────────────
-- SECURITY DEFINER so a policy on artists can ask about artists without
-- recursing into its own policy.
create function public.current_artist_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.artists where auth_user_id = auth.uid() and active limit 1
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.artists
                  where auth_user_id = auth.uid() and role = 'admin' and active)
$$;

-- True only for a request that came through the API with a JWT (or the anon
-- key). A migration, the SQL editor and Supabase Auth's own trigger carry no
-- claims, so the guards below never silently undo their writes — the trap
-- CLAUDE.md records for the old project's artists_guard.
create function public.is_api_caller() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.role(), '') in ('anon', 'authenticated')
$$;

-- ── updated_at ───────────────────────────────────────────────────────────
create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger artists_touch     before update on public.artists     for each row execute function public.touch_updated_at();
create trigger designs_touch     before update on public.designs     for each row execute function public.touch_updated_at();
create trigger flash_sales_touch before update on public.flash_sales for each row execute function public.touch_updated_at();

-- ── artists_guard ────────────────────────────────────────────────────────
-- Same rules as server/policy.js. REFUSES (42501) rather than silently
-- resetting a column: a save that says "Saved" and keeps nothing is worse
-- than an error. Also links a sign-in to an artist card by email, inside the
-- same trigger, so two triggers can never cancel each other out.
create function public.artists_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  api   boolean := public.is_api_caller();
  admin boolean := public.is_admin();
  self  boolean := (tg_op = 'UPDATE' and old.auth_user_id is not null
                    and old.auth_user_id = auth.uid());
begin
  if api then
    if tg_op = 'INSERT' then
      if new.auth_user_id is not null then
        raise exception 'auth_user_id cannot be set directly' using errcode = '42501';
      end if;
      if new.portrait_url is not null or new.portrait_thumb_url is not null or new.bio is not null then
        raise exception 'photo and bio are set by the artist themselves' using errcode = '42501';
      end if;
    else
      if new.auth_user_id is distinct from old.auth_user_id then
        raise exception 'auth_user_id cannot be set directly' using errcode = '42501';
      end if;
      if not self and (new.portrait_url is distinct from old.portrait_url
                    or new.portrait_thumb_url is distinct from old.portrait_thumb_url
                    or new.bio is distinct from old.bio) then
        raise exception 'Only % can change their own photo or bio', old.name using errcode = '42501';
      end if;
      if not admin and (new.role is distinct from old.role
                     or new.active is distinct from old.active
                     or new.kiosk_visible is distinct from old.kiosk_visible
                     or new.display_order is distinct from old.display_order
                     or new.seniority is distinct from old.seniority
                     or new.email is distinct from old.email) then
        raise exception 'Only an admin can change that' using errcode = '42501';
      end if;
    end if;
  end if;

  -- Never lock the studio out of its own dashboard.
  if tg_op = 'UPDATE' and old.role = 'admin' and old.active
     and (new.role <> 'admin' or not new.active)
     and not exists (select 1 from public.artists a
                      where a.id <> old.id and a.role = 'admin' and a.active) then
    raise exception '% is the only admin left — make someone else admin first', old.name
      using errcode = '42501';
  end if;

  -- Email set on a card whose person has already signed in once: link now.
  if new.auth_user_id is null and new.email is not null then
    select u.id into new.auth_user_id
      from auth.users u
     where lower(u.email) = lower(new.email)
       and not exists (select 1 from public.artists a where a.auth_user_id = u.id)
     limit 1;
  end if;
  return new;
end $$;

create trigger artists_guard before insert or update on public.artists
  for each row execute function public.artists_guard();

create function public.artists_guard_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin' and old.active
     and not exists (select 1 from public.artists a
                      where a.id <> old.id and a.role = 'admin' and a.active) then
    raise exception 'Cannot remove the only admin' using errcode = '42501';
  end if;
  return old;
end $$;

create trigger artists_guard_delete before delete on public.artists
  for each row execute function public.artists_guard_delete();

-- ── claim_artist_row: first sign-in attaches the login to the card ───────
create function public.claim_artist_row() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null then
    update public.artists
       set auth_user_id = new.id
     where lower(email) = lower(new.email)
       and auth_user_id is null;
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.claim_artist_row();
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public.claim_artist_row();

-- ── designs_guard: only an admin approves ────────────────────────────────
create function public.designs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if public.is_api_caller() and not public.is_admin()
     and new.approved is distinct from old.approved then
    raise exception 'Only an admin can approve' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger designs_guard before update on public.designs
  for each row execute function public.designs_guard();

-- ── Categories: one name, however it is typed ────────────────────────────
-- "Fine-Line", "fine line" and "FineLine" are one category (server/rpc.js).
create function public.category_normalize(p text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

create function public.category_key(p text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(public.category_normalize(p), '[^a-z0-9]+', '', 'g')
$$;

create function public.categories_keys() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.name := btrim(new.name);
  new.normalized_name := public.category_normalize(new.name);
  new.canonical_key := public.category_key(new.name);
  if new.slug is null or new.slug = '' then
    new.slug := trim(both '-' from regexp_replace(new.normalized_name, '[^a-z0-9]+', '-', 'g'));
  end if;
  return new;
end $$;

create trigger categories_keys before insert or update of name on public.categories
  for each row execute function public.categories_keys();

create function public.category_near_matches(p_name text) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(m order by m.similarity desc), '[]'::jsonb)
    from (select c.id, c.name, c.kind,
                 extensions.similarity(public.category_normalize(p_name), c.normalized_name) as similarity
            from public.categories c
           where extensions.similarity(public.category_normalize(p_name), c.normalized_name) >= 0.3
           order by 4 desc
           limit 5) m
$$;

-- ── The dashboard's four category RPCs (names and args as app.js calls them)
create function public.check_category_name(p_name text) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  k  text := public.category_key(p_name);
  ex public.categories;
  mine public.category_requests;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  if k = '' then
    return jsonb_build_object('reason', 'empty',
      'message', 'Type a name with at least one letter or number.');
  end if;
  select * into ex from public.categories where canonical_key = k limit 1;
  if found then
    return jsonb_build_object('reason', 'exists',
      'exact', jsonb_build_object('id', ex.id, 'name', ex.name, 'kind', ex.kind));
  end if;
  select * into mine from public.category_requests
   where requested_by = public.current_artist_id() and status = 'pending'
     and public.category_key(requested_name) = k limit 1;
  if found then
    return jsonb_build_object('reason', 'already_requested', 'my_pending', to_jsonb(mine));
  end if;
  return jsonb_build_object('reason', 'available', 'near', public.category_near_matches(p_name));
end $$;

create function public.approve_category_request(p_request_id uuid, p_kind text default 'theme')
returns public.categories
language plpgsql security definer set search_path = '' as $$
declare
  r public.category_requests;
  c public.categories;
begin
  if not public.is_admin() then raise exception 'Only an admin can approve' using errcode = '42501'; end if;
  select * into r from public.category_requests where id = p_request_id for update;
  if not found then raise exception 'That request no longer exists' using errcode = 'P0002'; end if;
  if r.status <> 'pending' then raise exception 'That request has already been answered'; end if;
  insert into public.categories (name, kind, display_order)
  values (r.requested_name, coalesce(p_kind, 'theme'), (select count(*) from public.categories))
  returning * into c;
  update public.category_requests
     set status = 'approved', merged_into_category_id = c.id, reviewed_at = now()
   where id = r.id;
  return c;
end $$;

create function public.reject_category_request(p_request_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can reject' using errcode = '42501'; end if;
  update public.category_requests
     set status = 'rejected', review_note = p_note, reviewed_at = now()
   where id = p_request_id and status = 'pending';
  if not found then raise exception 'That request no longer exists or has already been answered'; end if;
end $$;

create function public.merge_category_request(p_request_id uuid, p_category_id uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'Only an admin can merge' using errcode = '42501'; end if;
  if not exists (select 1 from public.categories where id = p_category_id) then
    raise exception 'That category no longer exists' using errcode = 'P0002';
  end if;
  update public.category_requests
     set status = 'merged', merged_into_category_id = p_category_id,
         review_note = p_note, reviewed_at = now()
   where id = p_request_id and status = 'pending';
  if not found then raise exception 'That request no longer exists or has already been answered'; end if;
end $$;

-- ── Views ────────────────────────────────────────────────────────────────
-- security_invoker: the caller's own RLS applies, so neither view can leak a
-- row its reader could not see directly.
create view public.category_request_queue with (security_invoker = true) as
select r.*,
       a.name   as requested_by_name,
       a.handle as requested_by_handle,
       case when r.status = 'pending' then public.category_near_matches(r.requested_name)
            else '[]'::jsonb end as near_matches,
       (select count(*) from public.category_requests x
         where x.status = 'pending'
           and public.category_key(x.requested_name) = public.category_key(r.requested_name))::int
         as pending_duplicates
  from public.category_requests r
  left join public.artists a on a.id = r.requested_by;

-- The kiosk's only read surface. A design whose artist is hidden from the
-- wall (or not readable by the caller) is excluded, never shown as unowned.
create view public.kiosk_catalog with (security_invoker = true) as
select d.id,
       d.artist_id,
       a.name   as artist_name,
       a.handle as artist_handle,
       d.title,
       d.type,
       d.image_url,
       d.thumb_url,
       d.width,
       d.height,
       d.price_band,
       d.featured,
       d.display_order,
       d.created_at,
       d.source_sheet_id,
       nullif(regexp_replace(coalesce(d.source_file, ''), '^.*/', ''), '') as source_name,
       coalesce(array_agg(c.name order by c.display_order) filter (where c.id is not null), '{}')
         as categories
  from public.designs d
  left join public.artists a            on a.id = d.artist_id
  left join public.design_categories dc on dc.design_id = d.id
  left join public.categories c         on c.id = dc.category_id
 where d.published
   and d.approved
   and (d.artist_id is null or (a.active and a.kiosk_visible))
 group by d.id, a.id, a.name, a.handle;
