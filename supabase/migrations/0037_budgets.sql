-- Budget maker: one editable budget per unit per year. The whole
-- engine state (baseline, growth, weather, events, rates, expense
-- lines, computed monthly revenue) lives in data as jsonb — the
-- client is the source of the shape while the feature iterates.
create table if not exists public.budgets (
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  year int not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (entity_id, year)
);

alter table public.budgets enable row level security;

-- Budgeting is an admin tool for now; members get read access when the
-- budget-vs-actual view ships.
drop policy if exists budgets_admin_all on public.budgets;
create policy budgets_admin_all on public.budgets
  for all using (public.is_admin()) with check (public.is_admin());
