-- Management sub-tabs (Ops / Manage / Org Chart): recurring task
-- definitions, the manager org chart, and a team-overview function.
create table if not exists public.recurring_tasks (
  id uuid primary key default uuid_generate_v4(),
  title text not null,
  entity_id uuid references public.ownership_entities(id) on delete set null,
  assignee_email text,
  cadence text not null check (cadence in ('daily','weekly','monthly')),
  byday int,                                -- weekly: 1-7 (Mon-Sun); monthly: 1-28
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.recurring_tasks enable row level security;
drop policy if exists recur_staff_all on public.recurring_tasks;
create policy recur_staff_all on public.recurring_tasks
  for all using (public.is_staff()) with check (public.is_staff());
drop policy if exists recur_assignee_read on public.recurring_tasks;
create policy recur_assignee_read on public.recurring_tasks
  for select using (lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));

alter table public.tasks
  add column if not exists recurring_id uuid references public.recurring_tasks(id) on delete set null,
  add column if not exists recur_key text;
create unique index if not exists tasks_recur_once on public.tasks (recurring_id, recur_key)
  where recurring_id is not null;

create table if not exists public.manager_org (
  manager_email text primary key,
  reports_to text,
  updated_at timestamptz not null default now()
);
alter table public.manager_org enable row level security;
drop policy if exists morg_admin_all on public.manager_org;
create policy morg_admin_all on public.manager_org
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists morg_read on public.manager_org;
create policy morg_read on public.manager_org
  for select using (auth.uid() is not null);

-- Reporting: admins see every manager; a manager sees their subtree.
create or replace function public.team_overview()
returns table (email text, full_name text, reports_to text, open_tasks int, doing_tasks int, week_minutes int)
language sql stable security definer set search_path = public as $$
  with mgrs as (
    select lower(ao.email) as email, p.full_name
    from allowed_owners ao
    left join profiles p on lower(p.email) = lower(ao.email)
    where ao.role = 'management' and position('<' in ao.email) = 0
  ),
  sub as (
    select email from mgrs where public.is_admin()
    union
    (with recursive t as (
       select lower(manager_email) as m from manager_org
        where lower(coalesce(reports_to,'')) = lower(coalesce(auth.jwt()->>'email','?'))
       union
       select lower(o.manager_email) from manager_org o join t on lower(coalesce(o.reports_to,'')) = t.m)
     select m from t)
  )
  select mg.email, mg.full_name,
    (select mo.reports_to from manager_org mo where lower(mo.manager_email) = mg.email),
    (select count(*)::int from tasks t where lower(coalesce(t.assignee_email,'')) = mg.email and t.status = 'open'),
    (select count(*)::int from tasks t where lower(coalesce(t.assignee_email,'')) = mg.email and t.status = 'doing'),
    (select coalesce(sum(te.minutes),0)::int from time_entries te
      where lower(te.user_email) = mg.email
        and te.work_date >= (current_date - ((extract(isodow from current_date))::int - 1)))
  from mgrs mg
  where auth.uid() is not null and mg.email in (select email from sub);
$$;
