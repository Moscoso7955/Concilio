-- Admins (only) may permanently remove an entry from the deletion log.
-- Staff keep read access; nothing else can touch the table — captures
-- come in via the SECURITY DEFINER trigger regardless.
drop policy if exists del_admin_purge on public.deleted_items;
create policy del_admin_purge on public.deleted_items
  for delete using (public.is_admin());
