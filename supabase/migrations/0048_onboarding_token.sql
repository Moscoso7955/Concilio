-- ============================================================
-- The inbound-bills address is minted from the company name when the
-- workspace is provisioned — i.e. from the signup placeholder
-- ("chris's workspace" → bills-chris-s-workspace-1a2b3@…). Naming the
-- workspace in onboarding now re-mints it from the real name, and the
-- placeholder-derived addresses already out there are re-minted once.
-- Nobody can have used an address before onboarding, so nothing
-- in flight is lost. Run after 0047_platform_delete_files.sql.
-- ============================================================

create or replace function public.complete_onboarding(p_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare ws uuid := public.current_workspace(); v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if ws is null or not exists (
    select 1 from workspace_members where workspace_id = ws and user_id = auth.uid() and role = 'admin'
  ) then raise exception 'Admins only'; end if;
  if v_name is not null then
    update workspaces set name = v_name where id = ws;
    update tenants set name = v_name, inbound_token = public.make_inbound_token(v_name)
      where id = (select id from tenants where workspace_id = ws order by created_at limit 1);
  end if;
  update workspaces set onboarded_at = coalesce(onboarded_at, now()) where id = ws;
end $$;

-- Companies renamed after provisioning but still carrying the
-- placeholder-derived token.
update tenants set inbound_token = public.make_inbound_token(name)
  where inbound_token like '%-s-workspace-%' and name not ilike '%''s workspace';
