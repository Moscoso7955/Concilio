-- Intercompany billing (documentation only — no funds movement).
-- An invoice paid by one company (tenant) can be allocated to any
-- entity ("bought on the Callidus card for Bar Phoebe"); the month-end
-- settle-up groups unsettled allocations by payer → entity, records a
-- settlement document, and stamps the invoices it covered.

alter table public.invoices
  add column if not exists entity_id uuid references public.ownership_entities(id) on delete set null,
  add column if not exists ic_settlement_id uuid;

create table if not exists public.ic_settlements (
  id uuid primary key default uuid_generate_v4(),
  period date not null,                                   -- first of the settled month
  tenant_id uuid not null references public.tenants(id),
  entity_id uuid not null references public.ownership_entities(id) on delete cascade,
  total numeric not null default 0,
  invoice_count int not null default 0,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.ic_settlements enable row level security;
drop policy if exists ic_admin_all on public.ic_settlements;
create policy ic_admin_all on public.ic_settlements
  for all using (public.is_admin()) with check (public.is_admin());
drop policy if exists ic_staff_read on public.ic_settlements;
create policy ic_staff_read on public.ic_settlements
  for select using (public.is_staff());

alter table public.invoices drop constraint if exists invoices_ic_settlement_fk;
alter table public.invoices add constraint invoices_ic_settlement_fk
  foreign key (ic_settlement_id) references public.ic_settlements(id) on delete set null;

-- New view columns must APPEND (create or replace can't reorder).
create or replace view public.invoices_list as
select id, tenant_id, vendor, category, code, invoice_date, amount, payment_status,
       needs_review, file_name, note, uploaded_by, source_email_id, splits, qbo,
       created_at, file_url is not null as has_file,
       entity_id, ic_settlement_id
  from public.invoices;
