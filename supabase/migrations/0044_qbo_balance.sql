-- ============================================================
-- Month-end balance sheet snapshots pulled by qbo-sync (ported from
-- callidus 0055): one row per entity per month; the current month's
-- as_of advances with each sync until the month closes. Admin-only —
-- balance sheets are not shown to members or principals. qbo-sync runs
-- as the service role and sets workspace_id explicitly.
-- Run after 0043_management.sql.
-- ============================================================

create table if not exists qbo_balance (
  workspace_id uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  entity_id    uuid not null references ownership_entities(id) on delete cascade,
  period       date not null,          -- first of the month the snapshot belongs to
  as_of        date not null,          -- the actual snapshot date (month end, or today mid-month)
  assets       numeric,
  liabilities  numeric,
  equity       numeric,
  detail       jsonb,                  -- flattened statement lines for the viewer
  synced_at    timestamptz not null default now(),
  primary key (entity_id, period)
);
create index if not exists idx_qbo_balance_ws on qbo_balance (workspace_id);
alter table qbo_balance enable row level security;
drop policy if exists qbal_admin_all on qbo_balance;
create policy qbal_admin_all on qbo_balance
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());
