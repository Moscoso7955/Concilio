-- One-shot cleanup of E2E smoke-test residue (run via apply-migration
-- workflow dispatch). Removes the two leftover test documents (rows +
-- storage objects) and every trace of the smoke@callidusco.com test
-- account. Final select reports what's left (all zeros = clean).

delete from storage.objects where bucket_id = 'documents'
  and name in (select file_path from documents where title like 'Smoke Test Doc%');
delete from documents where title like 'Smoke Test Doc%';

delete from access_log where lower(email) = 'smoke@callidusco.com';
delete from allowed_owners where lower(email) = 'smoke@callidusco.com';
delete from profiles where lower(email) = 'smoke@callidusco.com';
delete from auth.users where lower(email) = 'smoke@callidusco.com';

select
  (select count(*) from documents where title like 'Smoke Test Doc%')          as smoke_docs_left,
  (select count(*) from storage.objects where bucket_id = 'documents'
     and name in (select file_path from documents where title like 'Smoke Test Doc%')) as smoke_files_left,
  (select count(*) from auth.users   where lower(email) = 'smoke@callidusco.com') as smoke_auth_left,
  (select count(*) from profiles     where lower(email) = 'smoke@callidusco.com') as smoke_profile_left,
  (select count(*) from allowed_owners where lower(email) = 'smoke@callidusco.com') as smoke_allowlist_left,
  (select count(*) from access_log   where lower(email) = 'smoke@callidusco.com') as smoke_log_left;
