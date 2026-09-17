-- Role membership alone makes someone assignable: the roster and
-- assignee lists must show anyone with the admin or management role
-- even if their role's tabs were never customized to include
-- "management" (and before they've ever signed in — allowed_owners is
-- the source, profiles only decorates the name).
create or replace function public.assignable_users()
returns table (email text, full_name text, role text)
language sql
security definer
set search_path = public
as $$
  select ao.email,
         coalesce(p.full_name, ao.full_name) as full_name,
         ao.role
  from allowed_owners ao
  left join profiles p on lower(p.email) = lower(ao.email)
  where auth.uid() is not null
    and position('<' in ao.email) = 0
    and (
      ao.role in ('admin', 'management')
      or coalesce(
           ao.tabs,
           (select r.tabs from roles r where r.key = ao.role)
         ) @> '["management"]'::jsonb
    )
  order by 2, 1;
$$;
