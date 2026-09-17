-- Month-end balance sheet snapshots pulled by qbo-sync (one row per
-- entity per month; the current month's as_of advances with each sync
-- until the month closes). Admin-only — balance sheets are not shown
-- to members or principals.
create table if not exists public.qbo_balance (
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  period date not null,          -- first of the month the snapshot belongs to
  as_of date not null,           -- the actual snapshot date (month end, or today mid-month)
  assets numeric,
  liabilities numeric,
  equity numeric,
  detail jsonb,                  -- flattened statement lines for the viewer
  synced_at timestamptz not null default now(),
  primary key (entity_id, period)
);
alter table public.qbo_balance enable row level security;
drop policy if exists qbal_admin_all on public.qbo_balance;
create policy qbal_admin_all on public.qbo_balance
  for all using (public.is_admin()) with check (public.is_admin());
