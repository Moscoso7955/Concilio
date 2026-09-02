-- ============================================================
-- Concilio owner portal — full backend schema
-- Auth: Supabase magic-link email, restricted to an allowlist.
-- All access is enforced by Row-Level Security.
-- Run once against a fresh Supabase project.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ---------- Tables ----------

-- Who is allowed to sign in, and at what role. Managed by admins.
create table if not exists allowed_owners (
  email      text primary key,
  role       text not null default 'owner' check (role in ('owner','admin')),
  created_at timestamptz not null default now()
);

-- One profile per authenticated user (created automatically on signup).
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  role       text not null default 'owner' check (role in ('owner','admin')),
  created_at timestamptz not null default now()
);

-- Monthly financial snapshots (manual / CSV entry).
create table if not exists financials (
  id         uuid primary key default uuid_generate_v4(),
  period     date not null unique,               -- first day of the covered month
  revenue    numeric(14,2) not null default 0,
  expenses   numeric(14,2) not null default 0,
  net        numeric(14,2) generated always as (revenue - expenses) stored,
  notes      text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- Memo board.
create table if not exists memos (
  id          uuid primary key default uuid_generate_v4(),
  author_id   uuid references auth.users(id),
  author_name text,
  title       text not null,
  body        text not null default '',
  pinned      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Public site CMS (single row).
create table if not exists site_content (
  id         int primary key default 1,
  content    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

-- ---------- Role helpers (security definer to avoid RLS recursion) ----------

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid());
$$;

-- ---------- Signup: allowlist enforcement + profile creation ----------

create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  allowed_role text;
begin
  select role into allowed_role
  from allowed_owners
  where lower(email) = lower(new.email);

  if allowed_role is null then
    raise exception 'Email % is not authorized for portal access', new.email;
  end if;

  insert into profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), allowed_role);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- Row-Level Security ----------

alter table allowed_owners enable row level security;
alter table profiles       enable row level security;
alter table financials     enable row level security;
alter table memos          enable row level security;
alter table site_content   enable row level security;

-- allowed_owners: admins only
create policy "admin manage allowlist" on allowed_owners
  for all using (public.is_admin()) with check (public.is_admin());

-- profiles: read own (admins read all); update own
create policy "read profiles" on profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "update own profile" on profiles
  for update using (id = auth.uid());

-- financials: members read, admins write
create policy "members read financials" on financials
  for select using (public.is_member());
create policy "admin write financials" on financials
  for all using (public.is_admin()) with check (public.is_admin());

-- memos: members read; members create own; author or admin edit/delete
create policy "members read memos" on memos
  for select using (public.is_member());
create policy "members create memos" on memos
  for insert with check (author_id = auth.uid() and public.is_member());
create policy "author or admin update memos" on memos
  for update using (author_id = auth.uid() or public.is_admin());
create policy "author or admin delete memos" on memos
  for delete using (author_id = auth.uid() or public.is_admin());

-- site_content: public read (drives the live site), admins write
create policy "public read site_content" on site_content
  for select to anon, authenticated using (true);
create policy "admin insert site_content" on site_content
  for insert with check (public.is_admin());
create policy "admin update site_content" on site_content
  for update using (public.is_admin()) with check (public.is_admin());

-- ---------- Storage: CMS images ----------

insert into storage.buckets (id, name, public)
values ('site-assets', 'site-assets', true)
on conflict (id) do nothing;

create policy "public read site-assets" on storage.objects
  for select using (bucket_id = 'site-assets');
create policy "admin write site-assets" on storage.objects
  for insert with check (bucket_id = 'site-assets' and public.is_admin());
create policy "admin update site-assets" on storage.objects
  for update using (bucket_id = 'site-assets' and public.is_admin());

-- ---------- Seed ----------

-- First admin (change/add owners from the portal once you're in).
insert into allowed_owners (email, role)
values ('christian@callidusco.com', 'admin')
on conflict (email) do update set role = excluded.role;

-- Default site content (matches the current static page).
insert into site_content (id, content) values (1, '{
  "brand": "Concilio",
  "tagline": "We''re crafting an experience worth waiting for. Stay tuned.",
  "footer": "conciliowealth.com",
  "showLogo": false,
  "logoUrl": "",
  "bgColor": "#0a192f",
  "bgUrl": "",
  "textColor": "#ffffff",
  "overlayColor": "#0f172a",
  "overlayOpacity": 0,
  "themeColor": "#0a192f",
  "seoTitle": "Concilio",
  "seoDescription": "Concilio"
}'::jsonb)
on conflict (id) do nothing;
