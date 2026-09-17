-- Who can be assigned tasks / appear in Management people lists:
-- admins plus anyone whose effective tabs (per-user override, else
-- their role's tabs) include the Management tab. Any signed-in portal
-- user may call it — names only, no data beyond email/name/role key.
create or replace function public.assignable_users()
returns table (email text, full_name text, role text)
language sql stable security definer set search_path = public as $$
  select ao.email, p.full_name, ao.role
  from allowed_owners ao
  left join profiles p on lower(p.email) = lower(ao.email)
  where auth.uid() is not null
    and position('<' in ao.email) = 0
    and (ao.role = 'admin'
      or coalesce(ao.tabs, (select r.tabs from roles r where r.key = ao.role)) @> '["management"]'::jsonb)
  order by coalesce(p.full_name, ao.email);
$$;
