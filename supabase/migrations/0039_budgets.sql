-- ============================================================
-- Budget maker (ported from callidus 0037_budgets, workspace-scoped):
-- one editable budget per unit per year. The engine state lives in
-- data as jsonb; the client owns the shape while the feature iterates.
-- Run after 0038_qbo.sql.
-- ============================================================

create table if not exists public.budgets (
  entity_id    uuid not null references public.ownership_entities(id) on delete cascade,
  year         int not null,
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  data         jsonb not null,
  updated_at   timestamptz not null default now(),
  primary key (entity_id, year)
);
create index if not exists idx_budgets_workspace on public.budgets (workspace_id);

alter table public.budgets enable row level security;

-- Admin tool for now; members get read access when budget-vs-actual ships.
drop policy if exists budgets_admin_all on public.budgets;
create policy budgets_admin_all on public.budgets
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());
