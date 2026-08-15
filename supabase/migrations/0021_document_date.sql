-- ============================================================
-- Document date: the document's own date (execution / effective /
-- issue), distinct from when it was uploaded. AI intake proposes it;
-- the admin confirms. Run after 0020_sign_in_status.sql.
-- ============================================================

alter table documents add column if not exists doc_date date;
