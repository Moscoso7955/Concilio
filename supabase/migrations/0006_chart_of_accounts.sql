-- ============================================================
-- Chart of Accounts: extend gl_codes with a per-account tax rate and
-- optional sub-account nesting. Each account keeps its own unique `code`
-- (invoices still FK to gl_codes.code); a sub-account simply points at a
-- parent via `parent_code` and is nested/rolled up under it in the UI.
-- The invoice "Code" picker reads this table directly.
-- Run after 0005_ownership_kind.sql.
-- ============================================================

alter table gl_codes
  add column if not exists tax_rate numeric(6,3) not null default 0;

alter table gl_codes
  add column if not exists parent_code text references gl_codes(code) on delete set null;

-- A code can't be its own parent.
alter table gl_codes drop constraint if exists gl_no_self_parent;
alter table gl_codes add constraint gl_no_self_parent
  check (parent_code is null or parent_code <> code);

create index if not exists idx_gl_codes_parent on gl_codes (parent_code);

-- RLS already covers gl_codes (members read / admins write) from 0003 — the
-- new columns inherit those policies, so no policy changes are needed.
