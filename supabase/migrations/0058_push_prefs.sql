-- Notification settings, enforced server-side in the send helper so no
-- client can bypass them:
-- - push_prefs: per-person categories + quiet hours (Central time;
--   windows may cross midnight). One row per user, own-rows RLS.
-- - push_held: quiet-hours hold queue — alerts are held, not dropped,
--   and flushed when the window ends (newest per tag wins). Service
--   role only.
-- Admins can also see who has devices enrolled (read on subscriptions).
create table if not exists public.push_prefs (
  email text primary key,
  tasks boolean not null default true,
  digest boolean not null default true,
  quiet_start time,
  quiet_end time,
  updated_at timestamptz not null default now()
);
alter table public.push_prefs enable row level security;
drop policy if exists pprefs_own on public.push_prefs;
create policy pprefs_own on public.push_prefs
  for all using (lower(email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(email) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists pprefs_admin_read on public.push_prefs;
create policy pprefs_admin_read on public.push_prefs
  for select using (public.is_admin());

create table if not exists public.push_held (
  id uuid primary key default uuid_generate_v4(),
  email text not null,
  tag text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_held_email on public.push_held (email);
alter table public.push_held enable row level security;
-- no policies: service role only

drop policy if exists push_admin_read on public.push_subscriptions;
create policy push_admin_read on public.push_subscriptions
  for select using (public.is_admin());
