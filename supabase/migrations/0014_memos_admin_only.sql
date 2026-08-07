-- ============================================================
-- Solo-admin portal: members are view-only everywhere. Memos were the
-- one table members could still write (create / edit / delete their
-- own); writes become admin-only like everything else. Reads unchanged.
-- Run after 0013_financials_pnl.sql.
-- ============================================================

drop policy if exists "members create memos" on memos;
drop policy if exists "author or admin update memos" on memos;
drop policy if exists "author or admin delete memos" on memos;

create policy "admin create memos" on memos
  for insert with check (public.is_admin());
create policy "admin update memos" on memos
  for update using (public.is_admin()) with check (public.is_admin());
create policy "admin delete memos" on memos
  for delete using (public.is_admin());
