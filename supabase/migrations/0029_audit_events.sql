-- ============================================================
-- Audit trail expansion: access_log grows beyond sign-ins and
-- downloads — uploads, edits, deletions, user/role changes,
-- distributions, provisions, invites. The event list will keep
-- growing, so the check constraint goes; writes stay pinned to the
-- signed-in user and reads stay admin-only (policies from 0019).
-- Run after 0028_distribution_notify.sql.
-- ============================================================

alter table access_log drop constraint if exists access_log_event_check;
