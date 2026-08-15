-- One-shot cleanup of E2E smoke-test residue (run via the cleanup-smoke
-- workflow, which first deletes the underlying files through the Storage
-- API — direct deletes from storage.objects are blocked by a Supabase
-- safety trigger). Removes the two leftover test document rows and every
-- trace of the smoke@callidusco.com test account. Final select reports
-- what's left (all zeros = clean).

delete from documents where title like 'Smoke Test Doc%';

delete from access_log where lower(email) = 'smoke@callidusco.com';
delete from allowed_owners where lower(email) = 'smoke@callidusco.com';
delete from profiles where lower(email) = 'smoke@callidusco.com';
delete from auth.users where lower(email) = 'smoke@callidusco.com';

select
  (select count(*) from documents where title like 'Smoke Test Doc%')          as smoke_docs_left,
  (select count(*) from auth.users   where lower(email) = 'smoke@callidusco.com') as smoke_auth_left,
  (select count(*) from profiles     where lower(email) = 'smoke@callidusco.com') as smoke_profile_left,
  (select count(*) from allowed_owners where lower(email) = 'smoke@callidusco.com') as smoke_allowlist_left,
  (select count(*) from access_log   where lower(email) = 'smoke@callidusco.com') as smoke_log_left;
