-- ============================================================
-- Ownership entities gain a `kind`: 'individual' (a person — can be
-- invited to the portal via the details pane) vs 'entity' (a company,
-- LLC, or asset — no email invite). Existing rows default to individual.
-- Run after 0004_ownership.sql.
-- ============================================================

alter table ownership_entities
  add column if not exists kind text not null default 'individual'
  check (kind in ('individual', 'entity'));
