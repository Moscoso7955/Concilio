-- Replace the entire chart of accounts with the QuickBooks export
-- (Callidus_Holdings_LLC CSV, 2026-08-02). Sub-accounts ("Payroll
-- expenses:X") nest under their parent. Existing invoice references are
-- preserved by remapping old seed codes to their new equivalents.

-- Remember which invoices carried which old code, then detach.
create temp table _remap as select id, code as old_code from invoices where code is not null;
update invoices set code = null;

delete from gl_codes;

insert into gl_codes (code, category, name, sort, parent_code) values
  ('500', 'Contract labor',               'Contract labor',               10,  null),
  ('505', 'Advertising & marketing Labor','Advertising & marketing Labor',20,  null),
  ('510', 'Architectural Labor',          'Architectural Labor',          30,  null),
  ('520', 'Payroll expenses',             'Payroll expenses',             40,  null),
  ('521', 'Marketing Wages',              'Payroll expenses:Marketing Wages', 50, '520'),
  ('540', 'Taxes',                        'Payroll expenses:Taxes',       60,  '520'),
  ('525', 'Management Labor',             'Management Labor',             70,  null),
  ('603', 'Marketing',                    'Marketing',                    80,  null),
  ('605', 'Accounting fees',              'Accounting fees',              90,  null),
  ('607', 'Bank fees & service charges',  'Bank fees & service charges',  100, null),
  ('615', 'Contributions to charities',   'Contributions to charities',   110, null),
  ('625', 'Software Subscriptions',       'Software Subscriptions',       120, null),
  ('626', 'Merchant Processing Fees',     'Merchant Processing Fees',     130, null),
  ('627', 'QuickBooks Payments Fees',     'QuickBooks Payments Fees',     140, null),
  ('628', 'Travel Meals',                 'Travel Meals',                 150, null),
  ('629', 'Meals with Clients',           'Meals with Clients',           160, null),
  ('633', 'Interest Expense',             'Interest Expense',             170, null),
  ('640', 'Legal fees',                   'Legal fees',                   180, null),
  ('655', 'Office expenses',              'Office expenses',              190, null),
  ('660', 'Rent',                         'Rent',                         200, null),
  ('661', 'Repairs & maintenance',        'Repairs & maintenance',        210, null),
  ('669', 'Supplies',                     'Supplies',                     220, null),
  ('680', 'Phone service',                'Phone service',                230, null),
  ('682', 'Travel',                       'Travel',                       240, null),
  ('688', 'Research - F&B',               'Research - F&B',               250, null),
  ('689', 'Research - Apparel',           'Research - Apparel',           260, null),
  ('690', 'Utilities',                    'Utilities',                    270, null);

-- Reattach invoices: old seed codes → nearest new account (category
-- refreshes from the new chart via the enforce_invoice_rules trigger).
update invoices i set code = m.new_code, category = null
from (
  select id, case old_code
    when '6000' then '690'   -- Utilities
    when '6010' then '680'   -- Internet & Phone → Phone service
    when '6020' then '660'   -- Rent
    when '6040' then '661'   -- Repairs & maintenance
    when '6070' then '625'   -- Software & Subscriptions
    when '6080' then '605'   -- Professional Services → Accounting fees
    else null end as new_code
  from _remap
) m
where i.id = m.id and m.new_code is not null;

select count(*) as accounts from gl_codes;
select code, vendor from invoices where code is not null order by created_at;
