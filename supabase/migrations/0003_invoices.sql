-- ============================================================
-- AI Invoicing module — overhead bills with manual / bulk / email intake.
-- Landmines enforced server-side: blob-free list view (1), approval
-- validation (8), server-side dup check at create (7), email dedupe (5).
-- Run after 0002_documents.sql.
-- ============================================================

-- ---------- Tenants (single business; inbound email token) ----------
create table if not exists tenants (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  inbound_token text unique,               -- slug for bills-<token>@domain; renameable
  created_at    timestamptz not null default now()
);

insert into tenants (id, name, inbound_token)
values ('00000000-0000-0000-0000-000000000001', 'Callidus Co.', 'callidus')
on conflict do nothing;

-- ---------- Chart of accounts (GL codes → category) ----------
create table if not exists gl_codes (
  code     text primary key,
  category text not null,
  name     text,
  sort     int default 0
);

insert into gl_codes (code, category, name, sort) values
 ('6000','Utilities','Utilities',10),
 ('6010','Internet & Phone','Internet & Phone',20),
 ('6020','Rent','Rent',30),
 ('6030','Insurance','Insurance',40),
 ('6040','Repairs & Maintenance','Repairs & Maintenance',50),
 ('6050','Licenses & Permits','Licenses & Permits',60),
 ('6060','Waste & Recycling','Waste & Recycling',70),
 ('6070','Software & Subscriptions','Software & Subscriptions',80),
 ('6080','Professional Services','Professional Services',90),
 ('6090','Other','Other',100)
on conflict (code) do nothing;

-- ---------- Invoices ----------
create table if not exists invoices (
  id              uuid primary key default uuid_generate_v4(),
  tenant_id       uuid not null references tenants(id),
  vendor          text not null,
  category        text,
  code            text references gl_codes(code),
  invoice_date    date,
  amount          numeric(12,2),
  payment_status  text not null default 'Unpaid'
                    check (payment_status in ('Unpaid','Paid CC','Paid ACH','Paid Check')),
  needs_review    boolean not null default false,
  file_url        text,          -- 'storage:<path>' or 'data:<...>' — NEVER selected in the list view
  file_name       text,
  note            text,
  uploaded_by     text,
  source_email_id text,          -- '<email_id>:<attachment_id|body>' — webhook dedupe
  created_at      timestamptz not null default now()
);
create index if not exists idx_invoices_tenant on invoices (tenant_id, invoice_date desc, created_at desc);
create unique index if not exists uq_invoices_source_email
  on invoices (tenant_id, source_email_id) where source_email_id is not null;

-- Landmine 1: the list view NEVER exposes file_url (data: URLs are multi-MB).
create or replace view invoices_list
  with (security_invoker = on) as
  select id, tenant_id, vendor, category, code, invoice_date, amount,
         payment_status, needs_review, file_name, note, uploaded_by,
         source_email_id, created_at,
         (file_url is not null) as has_file
  from invoices;

-- ---------- AI usage metering ----------
create table if not exists ai_usage (
  id            uuid primary key default uuid_generate_v4(),
  tenant_id     uuid references tenants(id),
  model         text,
  input_tokens  int,
  output_tokens int,
  purpose       text,
  created_at    timestamptz not null default now()
);

-- ---------- RLS ----------
alter table tenants   enable row level security;
alter table gl_codes  enable row level security;
alter table invoices  enable row level security;
alter table ai_usage  enable row level security;

create policy "members read tenants" on tenants for select using (public.is_member());
create policy "members read gl_codes" on gl_codes for select using (public.is_member());
create policy "admin write gl_codes" on gl_codes for all using (public.is_admin()) with check (public.is_admin());
create policy "members read invoices" on invoices for select using (public.is_member());
create policy "admin write invoices" on invoices for all using (public.is_admin()) with check (public.is_admin());
create policy "members read ai_usage" on ai_usage for select using (public.is_member());
-- ai_usage writes come from the edge functions via the service role (bypasses RLS).

grant select on invoices_list to anon, authenticated;

-- ---------- Landmine 8: approval must validate; auto-fill category from code ----------
create or replace function public.enforce_invoice_rules() returns trigger
  language plpgsql set search_path = public as $$
begin
  if new.code is not null and (new.category is null or new.code is distinct from coalesce(old.code, '')) then
    select category into new.category from gl_codes where code = new.code;
  end if;
  new.note := left(coalesce(new.note, ''), 2000);
  if new.note = '' then new.note := null; end if;

  if tg_op = 'UPDATE' and old.needs_review = true and new.needs_review = false then
    if new.vendor is null or lower(new.vendor) = 'unknown vendor' then
      raise exception 'Approval requires a real vendor';
    end if;
    if new.amount is null then raise exception 'Approval requires an amount'; end if;
    if new.code is null then raise exception 'Approval requires a GL code'; end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_invoice_rules_ins on invoices;
drop trigger if exists trg_invoice_rules_upd on invoices;
create trigger trg_invoice_rules_ins before insert on invoices
  for each row execute function public.enforce_invoice_rules();
create trigger trg_invoice_rules_upd before update on invoices
  for each row execute function public.enforce_invoice_rules();

-- ---------- Landmine 7: server-side duplicate check at create time ----------
-- Client (manual + bulk) inserts through this RPC; returns the new id plus a
-- duplicate warning (vendor+date+amount match). Runs as caller → admin RLS applies.
create or replace function public.create_invoice(
  p_vendor text,
  p_code text default null,
  p_invoice_date date default null,
  p_amount numeric default null,
  p_payment_status text default 'Unpaid',
  p_note text default null,
  p_file_url text default null,
  p_file_name text default null,
  p_needs_review boolean default false
) returns jsonb
  language plpgsql security invoker set search_path = public as $$
declare
  v_tenant uuid;
  v_dup boolean;
  v_id uuid;
begin
  select id into v_tenant from tenants order by created_at limit 1;
  select exists (
    select 1 from invoices
    where tenant_id = v_tenant
      and lower(vendor) = lower(p_vendor)
      and invoice_date is not distinct from p_invoice_date
      and amount is not distinct from p_amount
  ) into v_dup;

  insert into invoices (tenant_id, vendor, code, invoice_date, amount, payment_status,
                        note, file_url, file_name, needs_review, uploaded_by)
  values (v_tenant, p_vendor, p_code, p_invoice_date, p_amount, coalesce(p_payment_status,'Unpaid'),
          p_note, p_file_url, p_file_name, coalesce(p_needs_review,false), auth.email())
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'duplicate', v_dup);
end $$;

-- ---------- Storage: private invoice files ----------
insert into storage.buckets (id, name, public)
values ('invoices', 'invoices', false)
on conflict (id) do nothing;

create policy "members read invoice files" on storage.objects
  for select using (bucket_id = 'invoices' and public.is_member());
create policy "admin write invoice files" on storage.objects
  for insert with check (bucket_id = 'invoices' and public.is_admin());
create policy "admin update invoice files" on storage.objects
  for update using (bucket_id = 'invoices' and public.is_admin());
create policy "admin delete invoice files" on storage.objects
  for delete using (bucket_id = 'invoices' and public.is_admin());
