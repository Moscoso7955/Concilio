-- ============================================================
-- Members see distribution payments made to any box in their
-- ownership slice — their own name AND entities they sit above (Zach
-- sees the payment to Molzer Development, which he owns) — labeled by
-- recipient. Still never anyone else's line. Replaces the summed
-- single-amount version. Run after 0026_provision_absorber.sql.
-- ============================================================

drop function if exists public.my_distribution_lines();
create or replace function public.my_distribution_lines()
returns table(id uuid, entity_id uuid, dist_date date, notes text, recipient text, amount numeric)
language sql stable security definer set search_path = public as $$
  with vis as (select public.visible_entity_ids() as id),
  boxes as (select e.id, e.name from ownership_entities e where e.id in (select id from vis))
  select d.id, d.entity_id, d.dist_date, d.notes, x.recipient, x.amount
  from distributions d
  cross join lateral (
    select b.name as recipient, (e->>'amount')::numeric as amount
      from jsonb_array_elements(coalesce(d.splits->'direct', '[]'::jsonb)) e
      join boxes b on b.id::text = e->>'id'
                   or ((e->>'id') is null and b.name = e->>'name')
    union all
    select p.owner_name, (e->>'amount')::numeric
      from jsonb_array_elements(coalesce(d.splits->'provisions', '[]'::jsonb)) e
      join dist_provisions p on p.id::text = e->>'id'
      where p.owner_id in (select id from vis)
  ) x
  where d.entity_id in (select id from vis) and x.amount > 0.005
$$;
