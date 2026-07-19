-- ============================================================
-- Financials become per-unit: each row belongs to an ownership entity
-- (a "unit"). The Reports page aggregates units into the group total and
-- drills into each unit. Uniqueness moves from period alone to
-- (entity_id, period) so every unit keeps its own monthly row.
-- Run after 0007_unit_reports_flag.sql.
-- ============================================================

alter table financials
  add column if not exists entity_id uuid references ownership_entities(id) on delete set null;

-- Drop the old single-column unique on period (was `period date not null unique`).
alter table financials drop constraint if exists financials_period_key;

-- One row per (unit, month). Used as the upsert conflict target.
create unique index if not exists uq_financials_entity_period
  on financials (entity_id, period);
create index if not exists idx_financials_entity on financials (entity_id);
