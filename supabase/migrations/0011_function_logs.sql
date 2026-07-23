-- ============================================================
-- Edge-function breadcrumb log, readable via SQL — gives the assistant
-- direct observability into email-inbound without dashboard access.
-- Service role writes (bypasses RLS); admins can read.
-- Run after 0010_todos.sql.
-- ============================================================

create table if not exists function_logs (
  id         uuid primary key default uuid_generate_v4(),
  fn         text not null,
  msg        text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_function_logs_time on function_logs (created_at desc);

alter table function_logs enable row level security;
create policy "admin read function logs" on function_logs
  for select using (public.is_admin());
