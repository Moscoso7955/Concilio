-- Which units each manager runs (Management tab, admin-assigned).
-- Separate from ownership boxes' managed_by (that's the principals'
-- portal-mirroring concept); this is day-to-day operational coverage.
create table if not exists public.manager_units (
  manager_email text not null,
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (manager_email, entity_id)
);
alter table public.manager_units enable row level security;
drop policy if exists mgru_admin_all on public.manager_units;
create policy mgru_admin_all on public.manager_units
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists mgru_read on public.manager_units;
create policy mgru_read on public.manager_units
  for select using (auth.uid() is not null);
