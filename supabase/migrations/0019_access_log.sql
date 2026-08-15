-- ============================================================
-- Access log: sign-ins and document downloads, admin-visible in
-- Settings → Activity. Users insert their own events; only admins read.
-- Run after 0018_document_recipients.sql.
-- ============================================================

create table if not exists access_log (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid,
  email      text,
  event      text not null check (event in ('sign_in','download')),
  detail     jsonb,
  created_at timestamptz not null default now()
);

alter table access_log enable row level security;
drop policy if exists "log own events" on access_log;
create policy "log own events" on access_log
  for insert with check (auth.uid() = user_id);
drop policy if exists "admin reads log" on access_log;
create policy "admin reads log" on access_log
  for select using (public.is_admin());
drop policy if exists "admin trims log" on access_log;
create policy "admin trims log" on access_log
  for delete using (public.is_admin());
