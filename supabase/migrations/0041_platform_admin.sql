-- ============================================================
-- Platform admin console + support mode.
-- Platform admins (profiles.platform_admin) see every workspace, can
-- set plans / extend trials / rename, and can ENTER a workspace as a
-- temporary support admin (workspace_members.support = true) and leave
-- again; their home workspace is remembered in profiles.home_workspace_id.
-- billing_ok() is always true for platform admins so support can reach
-- an expired workspace. Run after 0040_inbound_tokens.sql.
-- ============================================================

alter table profiles add column if not exists home_workspace_id uuid references workspaces(id) on delete set null;
alter table workspace_members add column if not exists support boolean not null default false;

create or replace function public.billing_ok() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_platform_admin() or coalesce((
    select case plan
      when 'active'   then true
      when 'comped'   then true
      when 'trial'    then trial_ends_at > now()
      when 'past_due' then coalesce(current_period_end, now()) + interval '7 days' > now()
      else false end
    from workspaces where id = public.current_workspace()
  ), false);
$$;

create or replace function public.platform_workspaces()
returns table(id uuid, name text, plan text, trial_ends_at timestamptz, current_period_end timestamptz, has_stripe boolean, onboarded boolean, created_at timestamptz, members int, admins text, last_sign_in timestamptz, units int, months int)
language sql stable security definer set search_path = public as $$
  select w.id, w.name, w.plan, w.trial_ends_at, w.current_period_end, w.stripe_customer_id is not null, w.onboarded_at is not null, w.created_at,
    (select count(*)::int from workspace_members m where m.workspace_id = w.id and not m.support),
    (select string_agg(u.email, ', ' order by u.email) from workspace_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'admin' and not m.support),
    (select max(u.last_sign_in_at) from workspace_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and not m.support),
    (select count(*)::int from ownership_entities e where e.workspace_id = w.id and e.kind = 'entity'),
    (select count(*)::int from financials f where f.workspace_id = w.id)
  from workspaces w
  where public.is_platform_admin()
  order by w.created_at desc
$$;

create or replace function public.platform_members(p_ws uuid)
returns table(email text, role text, support boolean, last_sign_in timestamptz, joined timestamptz)
language sql stable security definer set search_path = public as $$
  select u.email, m.role, m.support, u.last_sign_in_at, m.created_at
  from workspace_members m join auth.users u on u.id = m.user_id
  where m.workspace_id = p_ws and public.is_platform_admin()
  order by m.created_at
$$;

create or replace function public.platform_set_plan(p_ws uuid, p_plan text, p_trial_days int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  update workspaces set plan = p_plan,
    trial_ends_at = case when p_trial_days is not null then now() + make_interval(days => p_trial_days) else trial_ends_at end
    where id = p_ws;
  insert into access_log (workspace_id, user_id, email, event, detail)
    values (p_ws, auth.uid(), auth.email(), 'platform_set_plan', jsonb_build_object('plan', p_plan, 'trial_days', p_trial_days));
end $$;

create or replace function public.platform_rename(p_ws uuid, p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  update workspaces set name = p_name where id = p_ws;
end $$;

create or replace function public.support_leave()
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); home uuid;
begin
  select home_workspace_id into home from profiles where id = uid;
  if home is null then return; end if;
  delete from workspace_members where user_id = uid and support;
  update profiles p set workspace_id = home, home_workspace_id = null,
    role = coalesce((select m.role from workspace_members m where m.user_id = uid and m.workspace_id = home), p.role),
    tabs = (select m.tabs from workspace_members m where m.user_id = uid and m.workspace_id = home)
    where p.id = uid;
end $$;

create or replace function public.support_enter(p_ws uuid)
returns void language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); home uuid;
begin
  if not public.is_platform_admin() then raise exception 'Platform admins only'; end if;
  select coalesce(home_workspace_id, workspace_id) into home from profiles where id = uid;
  if p_ws = home then perform public.support_leave(); return; end if;
  delete from workspace_members where user_id = uid and support and workspace_id <> p_ws;
  insert into workspace_members (workspace_id, user_id, role, support)
    values (p_ws, uid, 'admin', true)
    on conflict (workspace_id, user_id) do nothing;
  update profiles p set workspace_id = p_ws, home_workspace_id = home,
    role = (select m.role from workspace_members m where m.user_id = uid and m.workspace_id = p_ws),
    tabs = (select m.tabs from workspace_members m where m.user_id = uid and m.workspace_id = p_ws)
    where p.id = uid;
  insert into access_log (workspace_id, user_id, email, event, detail)
    values (p_ws, uid, auth.email(), 'support_enter', null);
end $$;

revoke execute on function public.platform_workspaces() from public, anon;
revoke execute on function public.platform_members(uuid) from public, anon;
revoke execute on function public.platform_set_plan(uuid, text, int) from public, anon;
revoke execute on function public.platform_rename(uuid, text) from public, anon;
revoke execute on function public.support_enter(uuid) from public, anon;
revoke execute on function public.support_leave() from public, anon;
grant execute on function public.platform_workspaces() to authenticated;
grant execute on function public.platform_members(uuid) to authenticated;
grant execute on function public.platform_set_plan(uuid, text, int) to authenticated;
grant execute on function public.platform_rename(uuid, text) to authenticated;
grant execute on function public.support_enter(uuid) to authenticated;
grant execute on function public.support_leave() to authenticated;
