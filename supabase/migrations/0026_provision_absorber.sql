-- ============================================================
-- Who funds a preferred return. A provision's top-up (the preferred
-- draw beyond the holder's own ownership share) comes out of ONE
-- owner's cut — typically whoever sold the stake — leaving every other
-- owner's percentage untouched. Null = spread across the other owners
-- pro-rata. Run after 0025_distribution_provisions.sql.
-- ============================================================

alter table dist_provisions add column if not exists absorbed_by uuid references ownership_entities(id) on delete set null;
alter table dist_provisions add column if not exists absorbed_by_name text;

-- ------------------------------------------------------------
-- Privacy: a member sees only THEIR line of each distribution — not
-- the total, not other owners' amounts, not other owners' provisions.
-- Full rows stay staff-only (plus the unit's managing principal);
-- members read their own payments through my_distribution_lines().
-- ------------------------------------------------------------

drop policy if exists "read distributions by scope" on distributions;
create policy "staff or manager reads distributions" on distributions for select
  using (public.is_staff() or public.manages_entity(entity_id));

drop policy if exists "read provisions by scope" on dist_provisions;
create policy "read own or managed provisions" on dist_provisions for select
  using (public.is_staff() or public.manages_entity(entity_id)
         or owner_id in (select public.visible_entity_ids()));

create or replace function public.my_distribution_lines()
returns table(id uuid, entity_id uuid, dist_date date, notes text, amount numeric)
language sql stable security definer set search_path = public as $$
  with mine as (
    select id, name from ownership_entities
    where lower(email) = lower(coalesce(auth.email(), ''))
  )
  select d.id, d.entity_id, d.dist_date, d.notes,
    coalesce((select sum((e->>'amount')::numeric)
       from jsonb_array_elements(coalesce(d.splits->'direct', '[]'::jsonb)) e
       where (e->>'id') in (select id::text from mine)
          or (e->>'name') in (select name from mine)), 0)
    + coalesce((select sum((e->>'amount')::numeric)
       from jsonb_array_elements(coalesce(d.splits->'provisions', '[]'::jsonb)) e
       join dist_provisions p on p.id::text = e->>'id'
       where p.owner_id in (select id from mine)), 0) as amount
  from distributions d
  where d.entity_id in (select public.visible_entity_ids())
$$;
