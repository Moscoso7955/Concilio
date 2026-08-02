-- ============================================================
-- Downstream visibility: an invited individual sees reporting only for
-- units reachable from their own box in the ownership graph (any
-- ownership %, transitively). Admins see everything. The link between a
-- signed-in user and the graph is ownership_entities.email on their
-- individual box. Run after 0011_function_logs.sql.
-- ============================================================

-- The signed-in user's graph node + everything downstream of it.
-- SECURITY DEFINER so RLS policies can call it without recursing.
create or replace function public.visible_entity_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  with recursive me as (
    select id from ownership_entities
    where kind = 'individual'
      and email is not null
      and lower(email) = lower(coalesce(auth.email(), ''))
  ), down as (
    select id from me
    union
    select e.child_id from ownership_edges e join down d on e.parent_id = d.id
  )
  select id from down;
$$;

-- financials: admins read all; owners read only downstream units' rows.
-- (Legacy rows with entity_id NULL stay admin-only.)
do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'financials' and cmd = 'SELECT'
  loop execute format('drop policy %I on financials', p.policyname); end loop;
end $$;
create policy "read downstream financials" on financials for select
  using (public.is_admin() or entity_id in (select public.visible_entity_ids()));

-- ownership_entities: owners see only their downstream boxes (feeds the
-- Reports units list); admins unchanged via their ALL policy.
do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ownership_entities' and cmd = 'SELECT'
  loop execute format('drop policy %I on ownership_entities', p.policyname); end loop;
end $$;
create policy "read downstream entities" on ownership_entities for select
  using (public.is_admin() or id in (select public.visible_entity_ids()));

-- ownership_edges: visible only when both ends are visible.
do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ownership_edges' and cmd = 'SELECT'
  loop execute format('drop policy %I on ownership_edges', p.policyname); end loop;
end $$;
create policy "read downstream edges" on ownership_edges for select
  using (public.is_admin() or (
    parent_id in (select public.visible_entity_ids())
    and child_id in (select public.visible_entity_ids())
  ));
