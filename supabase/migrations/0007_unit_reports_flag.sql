-- ============================================================
-- Units opt into the Reports page. An ownership entity (kind='entity')
-- with in_reports = true is surfaced as a unit on the reporting page.
-- Individuals never appear there. Run after 0006_chart_of_accounts.sql.
-- ============================================================

alter table ownership_entities
  add column if not exists in_reports boolean not null default false;

create index if not exists idx_ownership_in_reports
  on ownership_entities (in_reports) where in_reports;
