-- ============================================================
-- Billing: $50/month per workspace after a 14-day free trial.
--
-- workspaces carries the plan, trial end, Stripe ids and the onboarding
-- stamp. billing_ok() decides whether the caller's current workspace
-- may use the portal; the role helpers require it, so an expired
-- workspace goes dark at the RLS layer — the only things still readable
-- are the caller's own profile and their workspace row, which is exactly
-- what the paywall needs to render and start Checkout.
-- The Concilio workspace is complimentary.
-- Run after 0036_workspaces.sql.
-- ============================================================

alter table workspaces add column if not exists plan text not null default 'trial'
  check (plan in ('trial','active','past_due','canceled','comped'));
alter table workspaces add column if not exists trial_ends_at timestamptz not null default (now() + interval '14 days');
alter table workspaces add column if not exists stripe_customer_id text;
alter table workspaces add column if not exists stripe_subscription_id text;
alter table workspaces add column if not exists current_period_end timestamptz;
alter table workspaces add column if not exists onboarded_at timestamptz;
create unique index if not exists uq_workspaces_stripe_customer
  on workspaces (stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists uq_workspaces_stripe_subscription
  on workspaces (stripe_subscription_id) where stripe_subscription_id is not null;

update workspaces set plan = 'comped', onboarded_at = coalesce(onboarded_at, now())
  where id = '00000000-0000-0000-0000-0000000000c0';

-- ---------- Access gate ----------

create or replace function public.billing_ok() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((
    select case plan
      when 'active'   then true
      when 'comped'   then true
      when 'trial'    then trial_ends_at > now()
      when 'past_due' then coalesce(current_period_end, now()) + interval '7 days' > now()
      else false end
    from workspaces where id = public.current_workspace()
  ), false);
$$;

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.billing_ok() and exists (
    select 1 from workspace_members m
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.billing_ok() and exists (
    select 1 from workspace_members m
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.billing_ok() and exists (
    select 1 from workspace_members m
    left join roles r on r.key = m.role
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
      and (m.role = 'admin' or coalesce(r.read_all, false))
  );
$$;

create or replace function public.can_market() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_admin() or (public.billing_ok() and exists (
    select 1 from workspace_members m
    left join roles r on r.key = m.role
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
      and (coalesce(m.tabs, '[]'::jsonb) ? 'marketing'
        or coalesce(r.tabs, '[]'::jsonb) ? 'marketing')
  ));
$$;

create or replace function public.visible_entity_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  with recursive me as (
    select id from ownership_entities
    where public.billing_ok()
      and workspace_id = public.current_workspace()
      and kind = 'individual'
      and email is not null
      and lower(email) = lower(coalesce(auth.email(), ''))
  ), down as (
    select id from me
    union
    select e.child_id from ownership_edges e join down d on e.parent_id = d.id
    where e.workspace_id = public.current_workspace()
  )
  select id from down;
$$;

create or replace function public.manages_entity(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.billing_ok() and exists (
    select 1 from principals p
    join ownership_entities e on e.managed_by = p.id
    where e.id = eid and e.workspace_id = public.current_workspace()
      and p.workspace_id = public.current_workspace()
      and lower(p.owner_email) = lower(coalesce(auth.email(), ''))
  );
$$;

-- The paywall must be able to read the workspace row after expiry.
drop policy if exists "members read workspace" on workspaces;
create policy "members read workspace" on workspaces for select
  using (id = public.current_workspace());

-- ---------- Onboarding ----------

-- First-run wizard: name the workspace (and its default invoicing
-- company) and stamp it onboarded. Membership is checked directly so it
-- works on day one of a trial regardless of billing state.
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
    update tenants set name = v_name where id = (
      select id from tenants where workspace_id = ws order by created_at limit 1);
  end if;
  update workspaces set onboarded_at = coalesce(onboarded_at, now()) where id = ws;
end $$;

revoke execute on function public.complete_onboarding(text) from public, anon;
grant execute on function public.complete_onboarding(text) to authenticated;
