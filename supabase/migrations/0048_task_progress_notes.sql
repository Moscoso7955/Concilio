-- Larger projects: % complete on a task, plus a timestamped note
-- thread. Notes are visible to whoever can see the task (staff, or
-- its creator/assignee), and anyone of those can add one.
alter table public.tasks add column if not exists progress int
  check (progress between 0 and 100);

create table if not exists public.task_notes (
  id uuid primary key default uuid_generate_v4(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  author_email text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists task_notes_task on public.task_notes (task_id, created_at);
alter table public.task_notes enable row level security;

drop policy if exists notes_staff_all on public.task_notes;
create policy notes_staff_all on public.task_notes
  for all using (public.is_staff()) with check (public.is_staff());

drop policy if exists notes_party_read on public.task_notes;
create policy notes_party_read on public.task_notes
  for select using (exists (
    select 1 from public.tasks t where t.id = task_id and (
      lower(coalesce(t.assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?'))
      or lower(coalesce(t.created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))));

drop policy if exists notes_party_insert on public.task_notes;
create policy notes_party_insert on public.task_notes
  for insert with check (
    lower(author_email) = lower(coalesce(auth.jwt()->>'email','?'))
    and exists (
      select 1 from public.tasks t where t.id = task_id and (
        lower(coalesce(t.assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?'))
        or lower(coalesce(t.created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))));

drop policy if exists notes_author_delete on public.task_notes;
create policy notes_author_delete on public.task_notes
  for delete using (lower(author_email) = lower(coalesce(auth.jwt()->>'email','?')));
