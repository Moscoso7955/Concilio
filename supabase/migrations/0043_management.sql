-- ============================================================
-- Management module (ported from callidus 0040–0053 + 0059): task
-- list, recurring tasks, time tracking with categories, manager units
-- and org chart, task notes, deletion log with restore, personal
-- calendar-feed tokens, plus the people functions the tab reads from.
--
-- Every table is workspace-scoped; every function answers for the
-- caller's current workspace. Visibility: staff (admin, or a role with
-- read_all) see everything in the workspace; everyone else sees tasks
-- they created or are assigned, and their own time entries.
-- Run after 0042_intercompany.sql.
-- ============================================================

-- Built-in role for people who run units day to day (shared, like the
-- other built-ins). Tabs can still be customised per workspace/user.
insert into roles (key, name, tabs, read_all, builtin, workspace_id)
  values ('management', 'Manager', '["management"]'::jsonb, false, true, null)
  on conflict (key) do nothing;

-- Display name captured at invite time (fallback until the person signs up).
alter table allowed_owners add column if not exists full_name text;

-- ---------- Tasks ----------

create table if not exists tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  title          text not null,
  notes          text,
  entity_id      uuid references ownership_entities(id) on delete set null,
  assignee_email text,
  status         text not null default 'open' check (status in ('open','doing','done')),
  due_date       date,
  progress       int check (progress between 0 and 100),
  created_by     text,
  created_at     timestamptz not null default now(),
  done_at        timestamptz
);
create index if not exists idx_tasks_ws on tasks (workspace_id, status);
alter table tasks enable row level security;
drop policy if exists tasks_staff_all on tasks;
create policy tasks_staff_all on tasks
  for all using (workspace_id = public.current_workspace() and public.is_staff())
  with check (workspace_id = public.current_workspace() and public.is_staff());
drop policy if exists tasks_assignee_read on tasks;
create policy tasks_assignee_read on tasks
  for select using (workspace_id = public.current_workspace()
    and lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists tasks_assignee_update on tasks;
create policy tasks_assignee_update on tasks
  for update using (workspace_id = public.current_workspace()
    and lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (workspace_id = public.current_workspace()
    and lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists tasks_creator_all on tasks;
create policy tasks_creator_all on tasks
  for all using (workspace_id = public.current_workspace()
    and lower(coalesce(created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (workspace_id = public.current_workspace()
    and lower(coalesce(created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')));

-- ---------- Recurring task definitions ----------

create table if not exists recurring_tasks (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  title          text not null,
  entity_id      uuid references ownership_entities(id) on delete set null,
  assignee_email text,
  cadence        text not null check (cadence in ('daily','weekly','monthly')),
  byday          int,                                -- weekly: 1-7 (Mon-Sun); monthly: 1-28
  est_minutes    int,                                -- sizes the calendar block
  start_time     time,                               -- where in the day it sits
  active         boolean not null default true,
  created_by     text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_recurring_ws on recurring_tasks (workspace_id);
alter table recurring_tasks enable row level security;
drop policy if exists recur_staff_all on recurring_tasks;
create policy recur_staff_all on recurring_tasks
  for all using (workspace_id = public.current_workspace() and public.is_staff())
  with check (workspace_id = public.current_workspace() and public.is_staff());
drop policy if exists recur_assignee_read on recurring_tasks;
create policy recur_assignee_read on recurring_tasks
  for select using (workspace_id = public.current_workspace()
    and lower(coalesce(assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?')));

alter table tasks
  add column if not exists recurring_id uuid references recurring_tasks(id) on delete set null,
  add column if not exists recur_key text;
create unique index if not exists tasks_recur_once on tasks (recurring_id, recur_key)
  where recurring_id is not null;

-- ---------- Time tracking ----------

create table if not exists time_categories (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  name         text not null,
  sort         int not null default 100,
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index if not exists time_categories_name on time_categories (workspace_id, lower(name));
alter table time_categories enable row level security;
drop policy if exists tcat_read on time_categories;
create policy tcat_read on time_categories
  for select using (workspace_id = public.current_workspace() and public.is_member());
drop policy if exists tcat_admin_all on time_categories;
create policy tcat_admin_all on time_categories
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());

create table if not exists time_entries (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  user_email   text not null,
  entity_id    uuid references ownership_entities(id) on delete set null,
  task_id      uuid references tasks(id) on delete set null,
  category_id  uuid references time_categories(id) on delete set null,
  work_date    date not null default current_date,
  started_at   timestamptz,
  stopped_at   timestamptz,
  minutes      int,
  note         text,
  created_at   timestamptz not null default now()
);
create index if not exists time_entries_user_date on time_entries (workspace_id, user_email, work_date);
alter table time_entries enable row level security;
drop policy if exists time_own_all on time_entries;
create policy time_own_all on time_entries
  for all using (workspace_id = public.current_workspace()
    and lower(user_email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (workspace_id = public.current_workspace()
    and lower(user_email) = lower(coalesce(auth.jwt()->>'email','?')));
drop policy if exists time_admin_all on time_entries;
create policy time_admin_all on time_entries
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());

-- ---------- Managers: units and org chart ----------

create table if not exists manager_units (
  workspace_id  uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  manager_email text not null,
  entity_id     uuid not null references ownership_entities(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (manager_email, entity_id)
);
alter table manager_units enable row level security;
drop policy if exists mgru_admin_all on manager_units;
create policy mgru_admin_all on manager_units
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());
drop policy if exists mgru_read on manager_units;
create policy mgru_read on manager_units
  for select using (workspace_id = public.current_workspace() and public.is_member());

create table if not exists manager_org (
  workspace_id  uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  manager_email text not null,
  reports_to    text,
  updated_at    timestamptz not null default now(),
  primary key (workspace_id, manager_email)
);
alter table manager_org enable row level security;
drop policy if exists morg_admin_all on manager_org;
create policy morg_admin_all on manager_org
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());
drop policy if exists morg_read on manager_org;
create policy morg_read on manager_org
  for select using (workspace_id = public.current_workspace() and public.is_member());

-- ---------- Task notes ----------

create table if not exists task_notes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  task_id      uuid not null references tasks(id) on delete cascade,
  author_email text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists task_notes_task on task_notes (task_id, created_at);
alter table task_notes enable row level security;
drop policy if exists notes_staff_all on task_notes;
create policy notes_staff_all on task_notes
  for all using (workspace_id = public.current_workspace() and public.is_staff())
  with check (workspace_id = public.current_workspace() and public.is_staff());
drop policy if exists notes_party_read on task_notes;
create policy notes_party_read on task_notes
  for select using (workspace_id = public.current_workspace() and exists (
    select 1 from tasks t where t.id = task_id and (
      lower(coalesce(t.assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?'))
      or lower(coalesce(t.created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))));
drop policy if exists notes_party_insert on task_notes;
create policy notes_party_insert on task_notes
  for insert with check (workspace_id = public.current_workspace()
    and lower(author_email) = lower(coalesce(auth.jwt()->>'email','?'))
    and exists (
      select 1 from tasks t where t.id = task_id and (
        lower(coalesce(t.assignee_email,'')) = lower(coalesce(auth.jwt()->>'email','?'))
        or lower(coalesce(t.created_by,'')) = lower(coalesce(auth.jwt()->>'email','?')))));
drop policy if exists notes_author_delete on task_notes;
create policy notes_author_delete on task_notes
  for delete using (workspace_id = public.current_workspace()
    and lower(author_email) = lower(coalesce(auth.jwt()->>'email','?')));

-- ---------- Deletion log + restore ----------

create table if not exists deleted_items (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  kind         text not null check (kind in ('task','time_entry','recurring_task','task_note')),
  item_id      uuid not null,
  payload      jsonb not null,
  deleted_by   text,
  deleted_at   timestamptz not null default now(),
  restored_at  timestamptz
);
create index if not exists deleted_items_when on deleted_items (workspace_id, deleted_at desc);
alter table deleted_items enable row level security;
drop policy if exists del_staff_read on deleted_items;
create policy del_staff_read on deleted_items
  for select using (workspace_id = public.current_workspace() and public.is_staff());
drop policy if exists del_admin_purge on deleted_items;
create policy del_admin_purge on deleted_items
  for delete using (workspace_id = public.current_workspace() and public.is_admin());

-- Captures run as definer so they land regardless of who deletes; the
-- row's own workspace is copied, not the caller's context.
create or replace function public.mg_capture_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.deleted_items (workspace_id, kind, item_id, payload, deleted_by)
  values ((to_jsonb(old)->>'workspace_id')::uuid, tg_argv[0], old.id, to_jsonb(old), coalesce(auth.jwt()->>'email',''));
  return old;
end $$;
-- Trigger-only: never callable through the REST rpc surface.
revoke execute on function public.mg_capture_delete() from public, anon, authenticated;

drop trigger if exists tasks_capture_delete on tasks;
create trigger tasks_capture_delete before delete on tasks
  for each row execute function public.mg_capture_delete('task');
drop trigger if exists time_capture_delete on time_entries;
create trigger time_capture_delete before delete on time_entries
  for each row execute function public.mg_capture_delete('time_entry');
drop trigger if exists recur_capture_delete on recurring_tasks;
create trigger recur_capture_delete before delete on recurring_tasks
  for each row execute function public.mg_capture_delete('recurring_task');
drop trigger if exists notes_capture_delete on task_notes;
create trigger notes_capture_delete before delete on task_notes
  for each row execute function public.mg_capture_delete('task_note');

-- Restoring a task also brings back the notes swept away by the same
-- delete (same transaction timestamp), not ones deleted deliberately.
create or replace function public.restore_deleted(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  d record;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into r from deleted_items
    where id = p_id and restored_at is null and workspace_id = public.current_workspace();
  if not found then raise exception 'Nothing to restore'; end if;

  if r.kind = 'task' then
    insert into tasks select * from jsonb_populate_record(null::tasks, r.payload)
      on conflict do nothing;
    for d in select * from deleted_items
      where kind = 'task_note' and restored_at is null
        and workspace_id = r.workspace_id
        and (payload->>'task_id')::uuid = r.item_id
        and deleted_at = r.deleted_at loop
      insert into task_notes select * from jsonb_populate_record(null::task_notes, d.payload)
        on conflict do nothing;
      update deleted_items set restored_at = now() where id = d.id;
    end loop;
  elsif r.kind = 'time_entry' then
    insert into time_entries select * from jsonb_populate_record(null::time_entries, r.payload)
      on conflict do nothing;
  elsif r.kind = 'recurring_task' then
    insert into recurring_tasks select * from jsonb_populate_record(null::recurring_tasks, r.payload)
      on conflict do nothing;
  elsif r.kind = 'task_note' then
    if not exists (select 1 from tasks where id = (r.payload->>'task_id')::uuid) then
      raise exception 'Restore the task first — this note belongs to a deleted task';
    end if;
    insert into task_notes select * from jsonb_populate_record(null::task_notes, r.payload)
      on conflict do nothing;
  end if;

  update deleted_items set restored_at = now() where id = p_id;
end $$;
revoke execute on function public.restore_deleted(uuid) from public, anon;
grant execute on function public.restore_deleted(uuid) to authenticated;

-- ---------- People functions ----------

-- Who can be assigned tasks / appear in Management people lists:
-- admins and managers of the caller's workspace, plus anyone whose
-- effective tabs include Management. Names only.
create or replace function public.assignable_users()
returns table (email text, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select ao.email,
         coalesce(p.full_name, ao.full_name) as full_name,
         ao.role
  from allowed_owners ao
  left join profiles p on lower(p.email) = lower(ao.email)
  where public.is_member()
    and ao.workspace_id = public.current_workspace()
    and position('<' in ao.email) = 0
    and (ao.role in ('admin', 'management')
      or coalesce(ao.tabs, (select r.tabs from roles r where r.key = ao.role)) @> '["management"]'::jsonb)
  order by 2, 1;
$$;
revoke execute on function public.assignable_users() from public, anon;
grant execute on function public.assignable_users() to authenticated;

-- Reporting: admins see every manager; a manager sees their subtree.
create or replace function public.team_overview()
returns table (email text, full_name text, reports_to text, open_tasks int, doing_tasks int, week_minutes int)
language sql stable security definer set search_path = public as $$
  with ws as (select public.current_workspace() as id),
  mgrs as (
    select lower(ao.email) as email, coalesce(p.full_name, ao.full_name) as full_name
    from allowed_owners ao
    left join profiles p on lower(p.email) = lower(ao.email)
    where ao.workspace_id = (select id from ws)
      and ao.role = 'management' and position('<' in ao.email) = 0
  ),
  sub as (
    select email from mgrs where public.is_admin()
    union
    (with recursive t as (
       select lower(manager_email) as m from manager_org
        where workspace_id = (select id from ws)
          and lower(coalesce(reports_to,'')) = lower(coalesce(auth.jwt()->>'email','?'))
       union
       select lower(o.manager_email) from manager_org o join t on lower(coalesce(o.reports_to,'')) = t.m
        where o.workspace_id = (select id from ws))
     select m from t)
  )
  select mg.email, mg.full_name,
    (select mo.reports_to from manager_org mo
      where mo.workspace_id = (select id from ws) and lower(mo.manager_email) = mg.email),
    (select count(*)::int from tasks t
      where t.workspace_id = (select id from ws) and lower(coalesce(t.assignee_email,'')) = mg.email and t.status = 'open'),
    (select count(*)::int from tasks t
      where t.workspace_id = (select id from ws) and lower(coalesce(t.assignee_email,'')) = mg.email and t.status = 'doing'),
    (select coalesce(sum(te.minutes),0)::int from time_entries te
      where te.workspace_id = (select id from ws) and lower(te.user_email) = mg.email
        and te.work_date >= (current_date - ((extract(isodow from current_date))::int - 1)))
  from mgrs mg
  where public.is_member() and mg.email in (select email from sub);
$$;
revoke execute on function public.team_overview() from public, anon;
grant execute on function public.team_overview() to authenticated;

-- Unit list for the Management tab: managers work ON units without
-- owning them (ownership RLS would show them nothing), so the tab gets
-- its units from here — gated exactly like assignable_users.
create or replace function public.mg_entities()
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name
  from ownership_entities e
  where e.workspace_id = public.current_workspace()
    and e.kind = 'entity'
    and public.is_member()
    and exists (
      select 1 from allowed_owners ao
      where ao.workspace_id = public.current_workspace()
        and lower(ao.email) = lower(coalesce(auth.jwt()->>'email','?'))
        and (ao.role in ('admin','management')
          or coalesce(ao.tabs, (select r.tabs from roles r where r.key = ao.role)) @> '["management"]'::jsonb)
    )
  order by e.name;
$$;
revoke execute on function public.mg_entities() from public, anon;
grant execute on function public.mg_entities() to authenticated;

-- ---------- Personal calendar-feed tokens ----------

create table if not exists mg_ical_tokens (
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  email        text not null,
  token        text not null unique default encode(gen_random_bytes(16), 'hex'),
  created_at   timestamptz not null default now(),
  primary key (workspace_id, email)
);
alter table mg_ical_tokens enable row level security;
-- No client policies: all access flows through the definer function
-- (and the task-feed edge function via service role).

create or replace function public.my_ical_token()
returns text language plpgsql security definer set search_path = public as $$
declare
  e text := lower(coalesce(auth.jwt()->>'email', ''));
  ws uuid := public.current_workspace();
  t text;
begin
  if e = '' or ws is null or not public.is_member() then raise exception 'Not signed in'; end if;
  insert into mg_ical_tokens (workspace_id, email) values (ws, e) on conflict (workspace_id, email) do nothing;
  select token into t from mg_ical_tokens where workspace_id = ws and email = e;
  return t;
end $$;
revoke execute on function public.my_ical_token() from public, anon;
grant execute on function public.my_ical_token() to authenticated;
