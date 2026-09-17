-- Unit selects in Management were empty for managers: ownership_entities
-- RLS only shows non-staff the boxes they own, and managers usually own
-- nothing. Managers work ON units without owning them, so the Management
-- tab gets its unit list from this definer function — gated exactly like
-- assignable_users (admin/management role, or a role carrying the tab).
create or replace function public.mg_entities()
returns table (id uuid, name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name
  from ownership_entities e
  where e.kind = 'entity'
    and auth.uid() is not null
    and exists (
      select 1 from allowed_owners ao
      where lower(ao.email) = lower(coalesce(auth.jwt()->>'email','?'))
        and (ao.role in ('admin','management')
          or coalesce(ao.tabs, (select r.tabs from roles r where r.key = ao.role)) @> '["management"]'::jsonb)
    )
  order by e.name;
$$;
grant execute on function public.mg_entities() to authenticated;
