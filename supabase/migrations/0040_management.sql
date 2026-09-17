-- Management tab: task list + time tracking.
-- Visibility: staff (admin, or a role with read_all — e.g. the
-- "management" role) see everything; everyone else sees tasks they
-- created or are assigned, and their own time entries.
create table if not exists public.tasks (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  notes text,
  entity_id uuid references public.ownership_entities(id) on delete set null,
  assignee_email text,
  status text not null default 'open' check (status in ('open','doing','done')),
  due_date date,
  created_by text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
alter table public.tasks enable row level security;
drop policy if exists tasks_staff_all on public.tasks;
create policy tasks_staff_all on public.tasks
  for all using (public.is_staff()) with check (public.is_staff());
drop policy if exists tasks_assignee_read on public.tasks;
create policy tasks_assignee_read on public.tasks
  for select using (lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists tasks_assignee_update on public.tasks;
create policy tasks_assignee_update on public.tasks
  for update using (lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists tasks_creator_all on public.tasks;
create policy tasks_creator_all on public.tasks
  for all using (lower(coalesce(created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(coalesce(created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')));

create table if not exists public.time_entries (
  id uuid primary key default uuid_generate_v4(),
  user_email text not null,
  entity_id uuid references public.ownership_entities(id) on delete set null,
  task_id uuid references public.tasks(id) on delete set null,
  work_date date not null default current_date,
  started_at timestamptz,
  stopped_at timestamptz,
  minutes int,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists time_entries_user_date on public.time_entries (user_email, work_date);
alter table public.time_entries enable row level security;
drop policy if exists time_own_all on public.time_entries;
create policy time_own_all on public.time_entries
  for all using (lower(user_email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(user_email) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists time_admin_all on public.time_entries;
create policy time_admin_all on public.time_entries
  for all using (public.is_admin()) with check (public.is_admin());
