-- ============================================================
-- Platform delete, take two: Supabase forbids deleting storage.objects
-- rows from SQL ("Direct deletion from storage tables is not allowed"),
-- so the files are removed through the Storage API by the
-- platform-delete-workspace edge function, which then calls
-- platform_delete_workspace() AS THE CALLER (the database still
-- enforces the platform-admin check). platform_workspace_files() lists
-- what the function has to remove. Run after 0046_platform_delete.sql.
-- ============================================================

create or replace function public.platform_workspace_files(p_ws uuid)
returns table (bucket_id text, name text)
language sql stable security definer set search_path = public as $$
  select o.bucket_id, o.name
  from storage.objects o
  where public.is_platform_admin()
    and o.name like p_ws::text || '/%'
  order by o.bucket_id, o.name;
$$;
revoke execute on function public.platform_workspace_files(uuid) from public, anon;
grant execute on function public.platform_workspace_files(uuid) to authenticated;

create or replace function public.platform_delete_workspace(p_ws uuid, p_confirm text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  w record;
  n_members int := 0;
  n_users int := 0;
  n_files int := 0;
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  select * into w from workspaces where id = p_ws;
  if not found then raise exception 'Workspace not found'; end if;
  if p_ws = '00000000-0000-0000-0000-0000000000c0' then raise exception 'The platform workspace cannot be deleted'; end if;
  if p_ws in (select coalesce(home_workspace_id, workspace_id) from profiles where id = uid) then
    raise exception 'You cannot delete your own workspace';
  end if;
  if coalesce(trim(p_confirm), '') <> w.name then raise exception 'Type the workspace name exactly to confirm'; end if;

  -- Anyone in support mode there goes home first.
  update profiles p set workspace_id = home_workspace_id, home_workspace_id = null
    where p.workspace_id = p_ws and p.home_workspace_id is not null;
  delete from workspace_members where workspace_id = p_ws and support;

  select count(*) into n_members from workspace_members where workspace_id = p_ws;
  -- Files still under the prefix (the edge function removes them first;
  -- anything left is reported, not deleted here).
  select count(*) into n_files from storage.objects where name like p_ws::text || '/%';

  -- Member accounts that live only here (never platform admins).
  with victims as (
    select p.id from profiles p
    where p.workspace_id = p_ws and not coalesce(p.platform_admin, false)
  ), gone as (
    delete from auth.users u using victims v where u.id = v.id returning u.id
  )
  select count(*) into n_users from gone;

  insert into access_log (workspace_id, user_id, email, event, detail)
    values ('00000000-0000-0000-0000-0000000000c0', uid, auth.email(), 'platform_delete_workspace',
            jsonb_build_object('workspace', p_ws, 'name', w.name, 'members', n_members, 'users_deleted', n_users, 'files_left', n_files));

  delete from workspaces where id = p_ws;
  return jsonb_build_object('name', w.name, 'members', n_members, 'users_deleted', n_users, 'files_left', n_files);
end $$;
