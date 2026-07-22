-- ============================================================
-- Invoice parity with the proven Tipsy flow:
--   splits — [{code, category, amount}] extra GL allocations on one bill;
--            the invoice's own code keeps the remainder (amount − sum).
--   qbo    — "entered in QuickBooks" flag, toggled inline.
-- Run after 0008_financials_per_unit.sql.
-- ============================================================

alter table invoices add column if not exists splits jsonb;
alter table invoices add column if not exists qbo boolean not null default false;

-- Expose both in the blob-free list view (still excludes file_url).
create or replace view invoices_list
  with (security_invoker = on) as
  select id, tenant_id, vendor, category, code, invoice_date, amount,
         payment_status, needs_review, file_name, note, uploaded_by,
         source_email_id, splits, qbo, created_at,
         (file_url is not null) as has_file
  from invoices;

grant select on invoices_list to anon, authenticated;

-- Validate splits in the same trigger that guards approvals: every entry
-- needs a code and a positive amount, and the sum can't exceed the total
-- (the primary code's remainder must stay ≥ 0).
create or replace function public.enforce_invoice_rules() returns trigger
  language plpgsql set search_path = public as $$
declare
  s jsonb;
  split_sum numeric := 0;
begin
  if new.code is not null and (new.category is null or new.code is distinct from coalesce(old.code, '')) then
    select category into new.category from gl_codes where code = new.code;
  end if;
  new.note := left(coalesce(new.note, ''), 2000);
  if new.note = '' then new.note := null; end if;

  if new.splits is not null then
    if jsonb_typeof(new.splits) <> 'array' or jsonb_array_length(new.splits) = 0 then
      new.splits := null;
    else
      for s in select * from jsonb_array_elements(new.splits) loop
        if coalesce(s->>'code', '') = '' or coalesce((s->>'amount')::numeric, 0) <= 0 then
          raise exception 'Each split needs a code and a positive amount';
        end if;
        split_sum := split_sum + (s->>'amount')::numeric;
      end loop;
      if new.amount is not null and split_sum > new.amount + 0.005 then
        raise exception 'Splits total $% — more than the invoice''s $%', split_sum, new.amount;
      end if;
    end if;
  end if;

  if tg_op = 'UPDATE' and old.needs_review = true and new.needs_review = false then
    if new.vendor is null or lower(new.vendor) = 'unknown vendor' then
      raise exception 'Approval requires a real vendor';
    end if;
    if new.amount is null then raise exception 'Approval requires an amount'; end if;
    if new.code is null then raise exception 'Approval requires a GL code'; end if;
  end if;
  return new;
end $$;
