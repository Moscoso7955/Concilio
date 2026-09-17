-- A display name captured at invite time, used until (and as fallback
-- after) the person signs up and profiles.full_name exists. The people
-- functions prefer the profile name, then the invite name, then email.
alter table public.allowed_owners add column if not exists full_name text;

create or replace function public.assignable_users()
returns table (email text, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select ao.email, coalesce(p.full_name, ao.full_name), ao.role
  from allowed_owners ao
  left join profiles p on lower(p.email) = lower(ao.email)
  where auth.uid() is not null
    and position('<' in ao.email) = 0
    and (ao.role = 'admin'
      or coalesce(ao.tabs, (select r.tabs from roles r where r.key = ao.role)) @> '["management"]'::jsonb)
  order by coalesce(p.full_name, ao.full_name, ao.email);
$$;

create or replace function public.team_overview()
returns table (email text, full_name text, reports_to text, open_tasks int, doing_tasks int, week_minutes int)
language sql stable security definer set search_path = public as $$
  with mgrs as (
    select lower(ao.email) as email, coalesce(p.full_name, ao.full_name) as full_name
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
