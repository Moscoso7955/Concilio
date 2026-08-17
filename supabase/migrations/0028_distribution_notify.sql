-- ============================================================
-- Distribution notifications: remember when partners were emailed
-- about a distribution so the ledger shows it and re-sends are
-- deliberate. Run after 0027_distribution_recipient_lines.sql.
-- ============================================================

alter table distributions add column if not exists notified_at timestamptz;
