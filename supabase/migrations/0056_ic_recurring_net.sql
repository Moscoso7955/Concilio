-- Intercompany round two:
-- - ic_recurring: standing monthly charges between entities (management
--   fees, shared rent). ic_charges materializes one row per month when
--   the settle-up is opened; charges settle exactly like allocated bills.
-- - ic_settlements.kind: 'pair' (one month, one direction) or 'net'
--   (everything outstanding between two entities, both directions,
--   squared with a single transfer).
create table if not exists public.ic_recurring (
  id uuid primary key default uuid_generate_v4(),
  provider_entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  amount numeric not null,
  memo text not null,
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.ic_recurring enable row level security;
drop policy if exists icr_admin_all on public.ic_recurring;
create policy icr_admin_all on public.ic_recurring
  for all using (public.is_admin()) with check (public.is_admin());

create table if not exists public.ic_charges (
  id uuid primary key default uuid_generate_v4(),
  recurring_id uuid not null references public.ic_recurring(id) on delete cascade,
  period date not null,
  provider_entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  amount numeric not null,
  memo text,
  ic_settlement_id uuid references public.ic_settlements(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (recurring_id, period)
);
alter table public.ic_charges enable row level security;
drop policy if exists icc_admin_all on public.ic_charges;
create policy icc_admin_all on public.ic_charges
  for all using (public.is_admin()) with check (public.is_admin());

alter table public.ic_settlements add column if not exists kind text not null default 'pair';
