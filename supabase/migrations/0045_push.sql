-- ============================================================
-- Web Push (ported from callidus 0057 + 0058).
-- - push_subscriptions: one row per device (a phone and a laptop are
--   two rows), keyed by the person's email — people are portal-wide,
--   so these are NOT workspace-scoped; users manage only their own
--   rows, and a workspace admin can see which of their people are
--   enrolled.
-- - push_prefs: per-person categories + quiet hours (Central time;
--   windows may cross midnight). Enforced server-side in the send
--   helper so no client can bypass them.
-- - push_held: quiet-hours hold queue (service role only).
-- - push_keys: the platform's VAPID pair — NO policies; nothing but the
--   service role can read it. The row is inserted by hand, never by a
--   migration (the private key must not live in the repo).
-- Run after 0044_qbo_balance.sql.
-- ============================================================

create table if not exists push_subscriptions (
  endpoint   text primary key,
  email      text not null,
  p256dh     text not null,
  auth       text not null,
  ua         text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_email on push_subscriptions (email);
alter table push_subscriptions enable row level security;
drop policy if exists push_own on push_subscriptions;
create policy push_own on push_subscriptions
  for all using (lower(email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(email) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists push_admin_read on push_subscriptions;
create policy push_admin_read on push_subscriptions
  for select using (public.is_admin() and exists (
    select 1 from allowed_owners ao
    where ao.workspace_id = public.current_workspace() and lower(ao.email) = lower(push_subscriptions.email)));

create table if not exists push_prefs (
  email       text primary key,
  tasks       boolean not null default true,
  digest      boolean not null default true,
  quiet_start time,
  quiet_end   time,
  updated_at  timestamptz not null default now()
);
alter table push_prefs enable row level security;
drop policy if exists pprefs_own on push_prefs;
create policy pprefs_own on push_prefs
  for all using (lower(email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(email) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists pprefs_admin_read on push_prefs;
create policy pprefs_admin_read on push_prefs
  for select using (public.is_admin() and exists (
    select 1 from allowed_owners ao
    where ao.workspace_id = public.current_workspace() and lower(ao.email) = lower(push_prefs.email)));

create table if not exists push_held (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  tag        text,
  payload    jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_held_email on push_held (email);
alter table push_held enable row level security;
-- no policies: service role only

create table if not exists push_keys (
  id          int primary key default 1,
  public_key  text not null,
  private_key text not null,
  created_at  timestamptz not null default now()
);
alter table push_keys enable row level security;
-- no policies on purpose: service-role only
