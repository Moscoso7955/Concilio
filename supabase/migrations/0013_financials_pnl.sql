-- ============================================================
-- Per-month P&L line detail. The AI P&L importer stores the month's
-- account-level lines here ({ lines: [{ section, label, amount }] }) so
-- the Reports unit view can render a "View P&L" statement per month.
-- Run after 0012_downstream_visibility.sql.
-- ============================================================

alter table financials add column if not exists pnl jsonb;
