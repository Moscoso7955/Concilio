-- The venue's physical address lives on its ownership card, not the
-- marketing sender profile. Campaign emails read it from here for the
-- legally-required footer line. Carries over anything already saved on
-- a sender profile. Run after 0033_mail_warmup.sql.

alter table ownership_entities add column if not exists address text;

update ownership_entities e
   set address = s.address
  from mail_senders s
 where s.entity_id = e.id
   and coalesce(e.address, '') = ''
   and coalesce(s.address, '') <> '';
