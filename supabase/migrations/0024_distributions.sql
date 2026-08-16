-- ============================================================
-- Distributions: money paid out by a unit to its owners. The portal
-- computes the split from the ownership graph at record time and
-- stores it as a snapshot (splits jsonb), so later graph edits never
-- rewrite history. Admin (or the unit's managing principal) records;
-- everyone who can see the unit can see its distributions.
-- Run after 0023_principals.sql.
-- ============================================================

create table if not exists distributions (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references ownership_entities(id) on delete cascade,
  dist_date  date not null,
  total      numeric not null,
  notes      text,
  splits     jsonb,   -- [{ name, pct, amount, kind }] snapshot at record time
  created_by text,
  created_at timestamptz not null default now()
);

alter table distributions enable row level security;

drop policy if exists "read distributions by scope" on distributions;
create policy "read distributions by scope" on distributions for select
  using (public.is_staff() or entity_id in (select public.visible_entity_ids()));

drop policy if exists "admin writes distributions" on distributions;
create policy "admin writes distributions" on distributions
  for all using (public.is_admin() or public.manages_entity(entity_id))
  with check (public.is_admin() or public.manages_entity(entity_id));
