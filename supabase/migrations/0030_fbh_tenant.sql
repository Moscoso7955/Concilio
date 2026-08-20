-- ============================================================
-- Second invoice company: Callidus FBH. The single email-in address
-- keeps working (unknown/no token defaults to the primary tenant) and
-- bills-fbh@ files straight to FBH; every bill row gets a company
-- toggle in the UI to move it between the two. Primary tenant renamed
-- "Callidus" so the pills read Callidus / FBH.
-- Run after 0029_audit_events.sql.
-- ============================================================

insert into tenants (id, name, inbound_token)
values ('00000000-0000-0000-0000-000000000002', 'Callidus FBH', 'fbh')
on conflict do nothing;

update tenants set name = 'Callidus'
where id = '00000000-0000-0000-0000-000000000001' and name = 'Callidus Co.';
