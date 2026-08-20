-- Diagnostic: which entity boxes exist and their Marketing/Reports flags.
-- Run via the apply-migration workflow dispatch; it prints these rows.
select name, in_marketing, in_reports,
       (select count(*) from mail_senders s where s.entity_id = e.id) as has_sender
from ownership_entities e
where kind = 'entity'
order by name;
