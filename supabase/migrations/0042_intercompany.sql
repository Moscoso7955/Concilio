-- ============================================================
-- Intercompany billing (ported from callidus 0038, 0039, 0054, 0056 —
-- documentation only, no funds movement).
--
-- A bill has a "For" entity (entity_id) and a "Paid by" entity
-- (paid_by_entity_id). When they differ the bill is an intercompany
-- allocation; the month-end settle-up nets who owes whom, records an
-- ic_settlements row and stamps the bills it covered. ic_recurring
-- holds standing monthly charges between entities (management fees,
-- shared rent); ic_charges materializes one row per month when the
-- settle-up is opened and settles exactly like a bill.
--
-- Every table is workspace-scoped (see docs/MULTI_TENANCY.md).
-- Run after 0041_platform_admin.sql.
-- ============================================================

alter table invoices
  add column if not exists entity_id uuid references ownership_entities(id) on delete set null,
  add column if not exists paid_by_entity_id uuid references ownership_entities(id) on delete set null,
  add column if not exists ic_settlement_id uuid;

create table if not exists ic_settlements (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  period          date not null,                       -- first of the settled month
  payer_entity_id uuid references ownership_entities(id) on delete cascade,
  entity_id       uuid not null references ownership_entities(id) on delete cascade,
  kind            text not null default 'pair' check (kind in ('pair','net')),
  total           numeric not null default 0,
  invoice_count   int not null default 0,
  note            text,
  created_by      text,
  paid_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists idx_ic_settlements_ws on ic_settlements (workspace_id, period desc);
alter table ic_settlements enable row level security;
drop policy if exists ic_admin_all on ic_settlements;
create policy ic_admin_all on ic_settlements
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());
drop policy if exists ic_staff_read on ic_settlements;
create policy ic_staff_read on ic_settlements
  for select using (workspace_id = public.current_workspace() and public.is_staff());

alter table invoices drop constraint if exists invoices_ic_settlement_fk;
alter table invoices add constraint invoices_ic_settlement_fk
  foreign key (ic_settlement_id) references ic_settlements(id) on delete set null;

create table if not exists ic_recurring (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  provider_entity_id uuid not null references ownership_entities(id) on delete cascade,
  entity_id          uuid not null references ownership_entities(id) on delete cascade,
  amount             numeric not null,
  memo               text not null,
  active             boolean not null default true,
  created_by         text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_ic_recurring_ws on ic_recurring (workspace_id);
alter table ic_recurring enable row level security;
drop policy if exists icr_admin_all on ic_recurring;
create policy icr_admin_all on ic_recurring
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());

create table if not exists ic_charges (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  recurring_id       uuid not null references ic_recurring(id) on delete cascade,
  period             date not null,
  provider_entity_id uuid not null references ownership_entities(id) on delete cascade,
  entity_id          uuid not null references ownership_entities(id) on delete cascade,
  amount             numeric not null,
  memo               text,
  ic_settlement_id   uuid references ic_settlements(id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (recurring_id, period)
);
create index if not exists idx_ic_charges_ws on ic_charges (workspace_id, period);
alter table ic_charges enable row level security;
drop policy if exists icc_admin_all on ic_charges;
create policy icc_admin_all on ic_charges
  for all using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());

-- The blob-free list view gains the three intercompany columns. Drop +
-- recreate (CREATE OR REPLACE can't insert columns mid-list) and keep
-- security_invoker so the invoices RLS applies through the view.
drop view if exists invoices_list;
create view invoices_list
  with (security_invoker = on) as
  select id, tenant_id, vendor, category, code, invoice_date, amount,
         payment_status, needs_review, file_name, note, uploaded_by,
         source_email_id, splits, qbo, created_at,
         (file_url is not null) as has_file,
         entity_id, ic_settlement_id, paid_by_entity_id
  from invoices;
grant select on invoices_list to anon, authenticated;
