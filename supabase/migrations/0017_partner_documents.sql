-- ============================================================
-- Unit-assigned documents. A document optionally belongs to a unit
-- (ownership entity); partners see exactly the documents of units in
-- their downstream slice. Unassigned documents stay staff-only.
-- Members get the Documents tab by default so shared files reach them.
-- Run after 0016_dynamic_roles.sql.
-- ============================================================

alter table documents add column if not exists entity_id uuid references ownership_entities(id) on delete set null;

drop policy if exists "staff read documents" on documents;
drop policy if exists "read documents by scope" on documents;
create policy "read documents by scope" on documents for select using (
  public.is_staff()
  or (entity_id is not null and entity_id in (select public.visible_entity_ids()))
);

-- Files: any signed-in member may fetch by path — paths are unguessable
-- (timestamp + random) and discovery is gated by the table policy above.
drop policy if exists "staff read document files" on storage.objects;
drop policy if exists "members read document files" on storage.objects;
create policy "members read document files" on storage.objects
  for select using (bucket_id = 'documents' and public.is_member());

-- Members see the Documents tab by default now.
update roles set tabs = coalesce(tabs, '[]'::jsonb) || '["documents"]'::jsonb
  where key = 'owner' and not coalesce(tabs, '[]'::jsonb) ? 'documents';
