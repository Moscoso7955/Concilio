-- Intercompany: the payer becomes any entity, not just a filing
-- company. paid_by defaults from the bill's company (Callidus →
-- Callidus Holdings) until set explicitly; settlements record the
-- payer entity (tenant_id stays for older rows).
alter table public.invoices
  add column if not exists paid_by_entity_id uuid references public.ownership_entities(id) on delete set null;
alter table public.ic_settlements
  add column if not exists payer_entity_id uuid references public.ownership_entities(id),
  alter column tenant_id drop not null;

update public.invoices i
   set paid_by_entity_id = e.id
  from public.tenants t
  join public.ownership_entities e
    on lower(e.name) = case when lower(t.name) = 'callidus' then 'callidus holdings' else lower(t.name) end
 where i.tenant_id = t.id and i.paid_by_entity_id is null;

create or replace view public.invoices_list as
select id, tenant_id, vendor, category, code, invoice_date, amount, payment_status,
       needs_review, file_name, note, uploaded_by, source_email_id, splits, qbo,
       created_at, file_url is not null as has_file,
       entity_id, ic_settlement_id, paid_by_entity_id
  from public.invoices;
