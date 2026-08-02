-- Flash Gallery — Phase 1 schema (PRD §4.2)
-- Target: Postgres / Supabase.
--
-- APPLIED to Supabase project "kattitude-flash-gallery" (ref
-- tovydesiocfgmasvzjvt, us-east-1) on 2026-08-01 as migrations
-- `flash_gallery_phase1_schema`, `flash_gallery_rls_public_read` and
-- `fix_touch_updated_at_search_path`.
--
-- This file is the readable record. Re-applying is safe (everything is
-- if-not-exists / or-replace) but prefer a new migration for changes.
--
-- ─────────────────────────────────────────────────────────────────────────
-- ON THE MODERATION QUESTION (PRD §6.6, still unanswered)
--
-- Whether the owner approves designs before they go live changes the data
-- model, and retrofitting it later means a migration plus an audit of every
-- read path. It is nearly free to design for now, so this schema carries BOTH
-- states and lets a single config value decide which one the kiosk honours:
--
--   published  — the ARTIST's intent. "I am done with this, show it."
--   approved   — the STUDIO's intent. "We are happy for this to be public."
--
-- If the studio decides artists publish directly, set approved DEFAULT TRUE
-- (as it is below) and nothing ever has to look at it. If they later want
-- moderation, flip the default to FALSE and start honouring it in the view —
-- no schema change, no data migration, no client rewrite.
--
-- `is_live` below is the ONLY thing the kiosk should ever read. Both flags
-- funnel through it, so the policy lives in exactly one place.
-- ─────────────────────────────────────────────────────────────────────────

begin;

create extension if not exists "pgcrypto";

-- ── Artists ──────────────────────────────────────────────────────────────
create table if not exists artists (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null,
  handle        text        unique,
  portrait_url  text,
  bio           text,
  seniority     text,        -- 'Studio Owner' | 'Senior Artist' | 'Junior Artist'
  -- Full profile URL, not a bare handle. The kiosk renders it as a QR code,
  -- and storing the resolved URL keeps link-building out of the client so an
  -- artist who moves platforms is a single dashboard edit.
  instagram_url text,
  display_order integer     not null default 0,
  active        boolean     not null default true,
  -- Links an artist row to a dashboard login. Null until the artist is
  -- invited, so the studio can seed artist cards before anyone has an account.
  auth_user_id  uuid        unique,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists artists_active_order_idx
  on artists (active, display_order);

-- ── Categories ───────────────────────────────────────────────────────────
-- Admin-managed vocabulary, not free text (PRD §3.5) — this is what stops
-- "blackwork" and "black work" both existing. Ownership of this list is PRD
-- §6.2 and still unanswered; the table works either way.
create table if not exists categories (
  id            uuid primary key default gen_random_uuid(),
  name          text        not null unique,
  slug          text        not null unique,
  display_order integer     not null default 0,
  created_at    timestamptz not null default now()
);

-- ── Designs ──────────────────────────────────────────────────────────────
create table if not exists designs (
  id            uuid primary key default gen_random_uuid(),
  artist_id     uuid references artists (id) on delete set null,
  title         text,
  notes         text,
  price_band    text,

  image_url     text        not null,
  thumb_url     text,

  -- Real pixel dimensions. The kiosk sizes a sheet's grid block from its own
  -- proportions — the studio's four existing sheets run 0.77 to a dead-square
  -- 1.00, nothing like the 9:16 the PRD assumed, so a fixed aspect crops them.
  width         integer,
  height        integer,

  -- 'design' = single piece, 'sheet' = composed multi-piece sheet. Sheets are
  -- retained as first-class content (PRD §3.4), not legacy.
  type          text        not null default 'design'
                check (type in ('design', 'sheet')),

  -- A single cut out of a sheet can point back at its parent sheet.
  source_sheet_id uuid references designs (id) on delete set null,

  display_order integer     not null default 0,
  featured      boolean     not null default false,

  -- See the moderation note at the top of this file.
  published     boolean     not null default false,
  approved      boolean     not null default true,

  -- Free-text keywords, captured now, hidden from the kiosk in v1 (PRD §3.5).
  keywords      text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists designs_artist_idx  on designs (artist_id);
create index if not exists designs_type_idx    on designs (type);
create index if not exists designs_live_idx    on designs (published, approved);
create index if not exists designs_order_idx   on designs (display_order, created_at desc);

-- A sheet cannot be its own source.
alter table designs drop constraint if exists designs_source_not_self;
alter table designs add constraint designs_source_not_self
  check (source_sheet_id is null or source_sheet_id <> id);

-- ── Design ↔ Category (many-to-many, PRD §3.5) ───────────────────────────
create table if not exists design_categories (
  design_id   uuid not null references designs (id)    on delete cascade,
  category_id uuid not null references categories (id) on delete cascade,
  primary key (design_id, category_id)
);

create index if not exists design_categories_category_idx
  on design_categories (category_id);

-- ── updated_at maintenance ───────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists artists_touch on artists;
create trigger artists_touch before update on artists
  for each row execute function touch_updated_at();

drop trigger if exists designs_touch on designs;
create trigger designs_touch before update on designs
  for each row execute function touch_updated_at();

-- ── The kiosk's only read surface ────────────────────────────────────────
-- Everything the kiosk needs in one shape, already filtered to live content
-- and already carrying its category names. The client does no joins and, more
-- importantly, does not encode the live-content policy — change the where
-- clause here and every consumer follows.
create or replace view kiosk_catalog as
select
  d.id,
  d.artist_id,
  a.name          as artist_name,
  a.handle        as artist_handle,
  d.title,
  d.type,
  d.image_url,
  d.thumb_url,
  d.price_band,
  d.featured,
  d.display_order,
  d.created_at,
  d.source_sheet_id,
  coalesce(
    array_agg(c.name order by c.display_order)
      filter (where c.id is not null),
    '{}'
  ) as categories
from designs d
left join artists a            on a.id = d.artist_id
left join design_categories dc on dc.design_id = d.id
left join categories c         on c.id = dc.category_id
where d.published
  and d.approved                 -- no-op while approved defaults true
  and (a.id is null or a.active) -- studio-owned sheets have no artist
group by d.id, a.name, a.handle, a.id;

commit;

-- ─────────────────────────────────────────────────────────────────────────
-- STILL OPEN, and each one touches this file:
--   §6.1 artist count at launch    → seeding only, no schema impact
--   §6.2 who owns the category list → seeding `categories`
--   §6.3 pricing on the kiosk       → `price_band` exists; exposure is a UI call
--   §6.6 owner approval             → flip `approved` default, honour it above
--
-- ─────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY  (migration: flash_gallery_rls_public_read)
--
-- Enabled from the start, not deferred to Phase 3. The kiosk ships its
-- publishable key in page source, so without RLS anyone who views source can
-- write to — or delete — the studio's whole catalog. Secrecy of that key is
-- not a security control; these policies are.
--
--   public role  -> SELECT live content only. No insert, update or delete.
--   drafts       -> invisible, because the policy filters on published AND
--                   approved rather than the view doing it alone.
--   dashboard    -> writes will authenticate separately (Phase 3), with its
--                   own policies for the artist/admin split.
-- ─────────────────────────────────────────────────────────────────────────

alter table artists           enable row level security;
alter table designs           enable row level security;
alter table categories        enable row level security;
alter table design_categories enable row level security;

drop policy if exists artists_public_read on artists;
create policy artists_public_read on artists
  for select to anon, authenticated using (active);

drop policy if exists designs_public_read on designs;
create policy designs_public_read on designs
  for select to anon, authenticated using (published and approved);

drop policy if exists categories_public_read on categories;
create policy categories_public_read on categories
  for select to anon, authenticated using (true);

drop policy if exists design_categories_public_read on design_categories;
create policy design_categories_public_read on design_categories
  for select to anon, authenticated using (
    exists (select 1 from designs d
            where d.id = design_id and d.published and d.approved));

-- Verified after applying: an anonymous SELECT returns [], an anonymous
-- INSERT is refused with 42501 (row violates row-level security policy).
-- ─────────────────────────────────────────────────────────────────────────
