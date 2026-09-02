-- ============================================================
-- Second invoice company: Concilio FBH. The single email-in address
-- keeps working (unknown/no token defaults to the primary tenant) and
-- bills-fbh@ files straight to FBH; every bill row gets a company
-- toggle in the UI to move it between the two. Primary tenant renamed
-- "Concilio" so the pills read Concilio / FBH.
-- Run after 0029_audit_events.sql.
-- ============================================================

insert into tenants (id, name, inbound_token)
values ('00000000-0000-0000-0000-000000000002', 'Concilio FBH', 'fbh')
on conflict do nothing;

update tenants set name = 'Concilio'
where id = '00000000-0000-0000-0000-000000000001' and name = 'Concilio';
