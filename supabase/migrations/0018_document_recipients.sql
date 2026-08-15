-- ============================================================
-- Sensitive documents: share with specific people. When a document has
-- a recipients list (jsonb array of lowercased emails), ONLY those
-- people (plus staff) can see it — the unit's downstream rule does not
-- apply. Without a recipients list, visibility stays as before: the
-- unit's downstream owners, or staff-only when no unit is assigned.
-- Run after 0017_partner_documents.sql.
-- ============================================================

alter table documents add column if not exists recipients jsonb;

drop policy if exists "read documents by scope" on documents;
create policy "read documents by scope" on documents for select using (
  public.is_staff()
  or (recipients is not null and recipients ? lower(coalesce(auth.email(), '')))
  or (recipients is null and entity_id is not null and entity_id in (select public.visible_entity_ids()))
);
