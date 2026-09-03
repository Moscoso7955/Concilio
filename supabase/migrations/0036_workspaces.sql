-- ============================================================
-- Workspaces: Concilio becomes a self-serve, multi-tenant product.
--
-- Anyone can sign up. On first sign-in they either join the workspace(s)
-- that invited them (allowed_owners rows matching their email) or get a
-- brand-new workspace with themselves as admin. Every domain table gains
-- workspace_id (defaulting to the caller's current workspace) and every
-- existing policy is wrapped with "workspace_id = current_workspace()".
-- The role helpers (is_admin, is_member, …) now answer for the caller's
-- current workspace, not the whole database.
--
-- Existing rows move into the bootstrap workspace 'Concilio'. The public
-- coming-soon page (site_content) and function_logs stay platform-level,
-- editable only by platform admins.
-- Run after 0035_brand_in_db.sql.
-- ============================================================

-- ---------- Core tables ----------

create table if not exists workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- Emails that may edit the public site and read platform logs.
create table if not exists platform_admins (
  email text primary key
);
insert into platform_admins (email) values ('christian@callidusco.com') on conflict do nothing;

alter table profiles add column if not exists workspace_id uuid references workspaces(id) on delete set null;
alter table profiles add column if not exists platform_admin boolean not null default false;

create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'owner' references roles(key) on update cascade on delete restrict,
  tabs         jsonb,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists idx_workspace_members_user on workspace_members (user_id);

-- ---------- Context helpers ----------

create or replace function public.current_workspace() returns uuid
  language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where id = auth.uid();
$$;

create or replace function public.is_platform_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce((select platform_admin from profiles where id = auth.uid()), false);
$$;

-- Storage objects live under <workspace id>/... in every private bucket.
create or replace function public.ws_path(p_name text) returns boolean
  language sql stable security definer set search_path = public as $$
  select split_part(p_name, '/', 1) = coalesce(public.current_workspace()::text, '');
$$;

-- ---------- Bootstrap workspace for everything that exists today ----------

insert into workspaces (id, name)
values ('00000000-0000-0000-0000-0000000000c0', 'Concilio')
on conflict (id) do nothing;

-- workspace_id on every domain table: add, backfill, lock down.
do $$
declare t text;
begin
  foreach t in array array[
    'allowed_owners','financials','memos','documents','tenants','gl_codes',
    'invoices','ai_usage','ownership_entities','ownership_edges','todos',
    'access_log','unit_links','principals','distributions','dist_provisions',
    'mail_senders','mail_subscribers','mail_campaigns','mail_deliveries'
  ] loop
    execute format('alter table %I add column if not exists workspace_id uuid', t);
    execute format('update %I set workspace_id = %L where workspace_id is null', t, '00000000-0000-0000-0000-0000000000c0');
    execute format('alter table %I alter column workspace_id set not null', t);
    execute format('alter table %I alter column workspace_id set default public.current_workspace()', t);
    execute format('alter table %I drop constraint if exists %I', t, t || '_workspace_id_fkey');
    execute format('alter table %I add constraint %I foreign key (workspace_id) references workspaces(id) on delete cascade', t, t || '_workspace_id_fkey');
    execute format('create index if not exists %I on %I (workspace_id)', 'idx_' || t || '_workspace', t);
  end loop;
end $$;

-- Keys that were global become per-workspace.
alter table allowed_owners drop constraint if exists allowed_owners_pkey;
alter table allowed_owners add primary key (workspace_id, email);

alter table invoices drop constraint if exists invoices_code_fkey;
alter table gl_codes drop constraint if exists gl_codes_parent_code_fkey;
alter table gl_codes drop constraint if exists gl_codes_pkey;
alter table gl_codes add primary key (workspace_id, code);
alter table gl_codes add constraint gl_codes_parent_code_fkey
  foreign key (workspace_id, parent_code) references gl_codes (workspace_id, code)
  on delete set null (parent_code);
alter table invoices add constraint invoices_code_fkey
  foreign key (workspace_id, code) references gl_codes (workspace_id, code);

alter table principals drop constraint if exists principals_owner_email_key;
alter table principals add constraint principals_workspace_owner_email_key unique (workspace_id, owner_email);

-- Roles: built-in rows are shared (workspace_id null); custom roles belong
-- to the workspace that created them. Keys stay globally unique.
alter table roles add column if not exists workspace_id uuid references workspaces(id) on delete cascade;
alter table roles alter column workspace_id set default public.current_workspace();
update roles set workspace_id = null where builtin;

-- ---------- Role helpers, now per workspace ----------

create or replace function public.is_admin() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members m
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid() and m.role = 'admin'
  );
$$;

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members m
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from workspace_members m
    left join roles r on r.key = m.role
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
      and (m.role = 'admin' or coalesce(r.read_all, false))
  );
$$;

create or replace function public.can_market() returns boolean
  language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from workspace_members m
    left join roles r on r.key = m.role
    where m.workspace_id = public.current_workspace() and m.user_id = auth.uid()
      and (coalesce(m.tabs, '[]'::jsonb) ? 'marketing'
        or coalesce(r.tabs, '[]'::jsonb) ? 'marketing')
  );
$$;

create or replace function public.visible_entity_ids()
returns setof uuid
language sql stable security definer set search_path = public as $$
  with recursive me as (
    select id from ownership_entities
    where workspace_id = public.current_workspace()
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
  select exists (
    select 1 from principals p
    join ownership_entities e on e.managed_by = p.id
    where e.id = eid and e.workspace_id = public.current_workspace()
      and p.workspace_id = public.current_workspace()
      and lower(p.owner_email) = lower(coalesce(auth.email(), ''))
  );
$$;

create or replace function public.marketing_units()
returns table(id uuid, name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name from ownership_entities e
  where e.workspace_id = public.current_workspace()
    and e.kind = 'entity' and e.in_marketing and public.can_market()
  order by e.name
$$;

create or replace function public.my_distribution_lines()
returns table(id uuid, entity_id uuid, dist_date date, notes text, recipient text, amount numeric)
language sql stable security definer set search_path = public as $$
  with vis as (select public.visible_entity_ids() as id),
  boxes as (select e.id, e.name from ownership_entities e where e.id in (select id from vis))
  select d.id, d.entity_id, d.dist_date, d.notes, x.recipient, x.amount
  from distributions d
  cross join lateral (
    select b.name as recipient, (e->>'amount')::numeric as amount
      from jsonb_array_elements(coalesce(d.splits->'direct', '[]'::jsonb)) e
      join boxes b on b.id::text = e->>'id'
                   or ((e->>'id') is null and b.name = e->>'name')
    union all
    select p.owner_name, (e->>'amount')::numeric
      from jsonb_array_elements(coalesce(d.splits->'provisions', '[]'::jsonb)) e
      join dist_provisions p on p.id::text = e->>'id'
      where p.owner_id in (select id from vis)
  ) x
  where d.workspace_id = public.current_workspace()
    and d.entity_id in (select id from vis) and x.amount > 0.005
$$;

create or replace function public.user_sign_in_status()
returns table(email text, last_sign_in_at timestamptz)
language sql security definer set search_path = ''
as $$
  select lower(u.email) as email, u.last_sign_in_at
  from auth.users u
  where public.is_admin()
    and lower(u.email) in (
      select lower(a.email) from public.allowed_owners a
      where a.workspace_id = public.current_workspace()
    )
$$;

-- create_invoice: the tenant comes from the caller's workspace.
create or replace function public.create_invoice(
  p_vendor text,
  p_code text default null,
  p_invoice_date date default null,
  p_amount numeric default null,
  p_payment_status text default 'Unpaid',
  p_note text default null,
  p_file_url text default null,
  p_file_name text default null,
  p_needs_review boolean default false
) returns jsonb
  language plpgsql security invoker set search_path = public as $$
declare
  v_tenant uuid;
  v_dup boolean;
  v_id uuid;
begin
  select id into v_tenant from tenants
  where workspace_id = public.current_workspace() order by created_at limit 1;
  if v_tenant is null then raise exception 'No company set up for this workspace yet'; end if;
  select exists (
    select 1 from invoices
    where tenant_id = v_tenant
      and lower(vendor) = lower(p_vendor)
      and invoice_date is not distinct from p_invoice_date
      and amount is not distinct from p_amount
  ) into v_dup;
  insert into invoices (tenant_id, vendor, code, invoice_date, amount, payment_status,
                        note, file_url, file_name, needs_review, uploaded_by)
  values (v_tenant, p_vendor, p_code, p_invoice_date, p_amount, coalesce(p_payment_status,'Unpaid'),
          p_note, p_file_url, p_file_name, coalesce(p_needs_review,false), auth.email())
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'duplicate', v_dup);
end $$;

-- ---------- Wrap every existing policy with the workspace check ----------

do $$
declare p record; ws text := 'workspace_id = public.current_workspace()';
begin
  for p in
    select * from pg_policies
    where schemaname = 'public' and tablename in (
      'allowed_owners','financials','memos','documents','tenants','gl_codes',
      'invoices','ai_usage','ownership_entities','ownership_edges','todos',
      'access_log','unit_links','principals','distributions','dist_provisions',
      'mail_senders','mail_subscribers','mail_campaigns','mail_deliveries'
    )
  loop
    execute format('drop policy %I on %I', p.policyname, p.tablename);
    execute format('create policy %I on %I as %s for %s to %s %s %s',
      p.policyname, p.tablename, p.permissive, p.cmd, array_to_string(p.roles, ', '),
      case when p.qual is not null then format('using (%s and (%s))', ws, p.qual) else '' end,
      case when p.with_check is not null then format('with check (%s and (%s))', ws, p.with_check) else '' end);
  end loop;
end $$;

-- Principal brands are read before sign-in to skin a custom domain; keep
-- those readable by hostname, everything else stays inside the workspace.
drop policy if exists "anyone reads principal brands" on principals;
create policy "anyone reads principal brands" on principals for select
  using (workspace_id = public.current_workspace() or domain is not null);

-- profiles: yourself, plus (for admins) the members of your workspace.
drop policy if exists "read profiles" on profiles;
create policy "read profiles" on profiles for select
  using (id = auth.uid() or (public.is_admin() and id in (
    select user_id from workspace_members where workspace_id = public.current_workspace())));
drop policy if exists "admin update profiles" on profiles;
create policy "admin update profiles" on profiles for update
  using (public.is_admin() and id in (
    select user_id from workspace_members where workspace_id = public.current_workspace()))
  with check (public.is_admin() and id in (
    select user_id from workspace_members where workspace_id = public.current_workspace()));
drop policy if exists "admin delete profiles" on profiles;  -- removal goes through remove_member()

-- workspaces / members
alter table workspaces enable row level security;
alter table workspace_members enable row level security;
drop policy if exists "members read workspace" on workspaces;
create policy "members read workspace" on workspaces for select
  using (id = public.current_workspace() and public.is_member());
drop policy if exists "admin renames workspace" on workspaces;
create policy "admin renames workspace" on workspaces for update
  using (id = public.current_workspace() and public.is_admin())
  with check (id = public.current_workspace() and public.is_admin());
drop policy if exists "members read members" on workspace_members;
create policy "members read members" on workspace_members for select
  using (workspace_id = public.current_workspace() and public.is_member());
-- Membership writes go through the RPCs below (security definer).

-- roles: built-ins for everyone, custom roles per workspace.
drop policy if exists "members read roles" on roles;
create policy "members read roles" on roles for select
  using (workspace_id is null or workspace_id = public.current_workspace());
drop policy if exists "admin write roles" on roles;
create policy "admin write roles" on roles for all
  using (workspace_id = public.current_workspace() and public.is_admin())
  with check (workspace_id = public.current_workspace() and public.is_admin());

-- Platform-level tables.
drop policy if exists "admin insert site_content" on site_content;
create policy "admin insert site_content" on site_content for insert with check (public.is_platform_admin());
drop policy if exists "admin update site_content" on site_content;
create policy "admin update site_content" on site_content for update
  using (public.is_platform_admin()) with check (public.is_platform_admin());
drop policy if exists "admin read function logs" on function_logs;
create policy "admin read function logs" on function_logs for select using (public.is_platform_admin());
alter table platform_admins enable row level security;
drop policy if exists "platform admins read list" on platform_admins;
create policy "platform admins read list" on platform_admins for select using (public.is_platform_admin());

-- ---------- Storage: objects live under <workspace id>/ ----------

drop policy if exists "admin write site-assets" on storage.objects;
create policy "admin write site-assets" on storage.objects
  for insert with check (bucket_id = 'site-assets' and public.is_platform_admin());
drop policy if exists "admin update site-assets" on storage.objects;
create policy "admin update site-assets" on storage.objects
  for update using (bucket_id = 'site-assets' and public.is_platform_admin());

drop policy if exists "members read document files" on storage.objects;
create policy "members read document files" on storage.objects
  for select using (bucket_id = 'documents' and public.ws_path(name) and public.is_member());
drop policy if exists "admin insert document files" on storage.objects;
create policy "admin insert document files" on storage.objects
  for insert with check (bucket_id = 'documents' and public.ws_path(name) and public.is_admin());
drop policy if exists "admin update document files" on storage.objects;
create policy "admin update document files" on storage.objects
  for update using (bucket_id = 'documents' and public.ws_path(name) and public.is_admin());
drop policy if exists "admin delete document files" on storage.objects;
create policy "admin delete document files" on storage.objects
  for delete using (bucket_id = 'documents' and public.ws_path(name) and public.is_admin());
drop policy if exists "principal insert document files" on storage.objects;
create policy "principal insert document files" on storage.objects
  for insert with check (
    bucket_id = 'documents' and public.ws_path(name) and exists (
      select 1 from principals p
      where p.workspace_id = public.current_workspace()
        and lower(p.owner_email) = lower(coalesce(auth.email(), ''))
    )
  );

drop policy if exists "staff read invoice files" on storage.objects;
create policy "staff read invoice files" on storage.objects
  for select using (bucket_id = 'invoices' and public.ws_path(name) and public.is_staff());
drop policy if exists "admin write invoice files" on storage.objects;
create policy "admin write invoice files" on storage.objects
  for insert with check (bucket_id = 'invoices' and public.ws_path(name) and public.is_admin());
drop policy if exists "admin update invoice files" on storage.objects;
create policy "admin update invoice files" on storage.objects
  for update using (bucket_id = 'invoices' and public.ws_path(name) and public.is_admin());
drop policy if exists "admin delete invoice files" on storage.objects;
create policy "admin delete invoice files" on storage.objects
  for delete using (bucket_id = 'invoices' and public.ws_path(name) and public.is_admin());

-- ---------- Provisioning ----------

-- A new workspace with its first admin, a default company for invoicing
-- and the starter chart of accounts.
create or replace function public.provision_workspace(p_user uuid, p_email text, p_name text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into workspaces (name, created_by) values (p_name, p_user) returning id into ws;
  insert into workspace_members (workspace_id, user_id, role) values (ws, p_user, 'admin')
    on conflict do nothing;
  insert into allowed_owners (workspace_id, email, role) values (ws, lower(p_email), 'admin')
    on conflict do nothing;
  insert into tenants (workspace_id, name) values (ws, p_name);
  insert into gl_codes (workspace_id, code, category, name, sort) values
   (ws,'6000','Utilities','Utilities',10),
   (ws,'6010','Internet & Phone','Internet & Phone',20),
   (ws,'6020','Rent','Rent',30),
   (ws,'6030','Insurance','Insurance',40),
   (ws,'6040','Repairs & Maintenance','Repairs & Maintenance',50),
   (ws,'6050','Licenses & Permits','Licenses & Permits',60),
   (ws,'6060','Waste & Recycling','Waste & Recycling',70),
   (ws,'6070','Software & Subscriptions','Software & Subscriptions',80),
   (ws,'6080','Professional Services','Professional Services',90),
   (ws,'6090','Other','Other',100)
  on conflict do nothing;
  update profiles set workspace_id = coalesce(workspace_id, ws), role = 'admin', tabs = null
    where id = p_user and (workspace_id is null or workspace_id = ws);
  return ws;
end $$;

-- Keep profiles.role/tabs mirroring the membership in the user's current workspace.
create or replace function public.sync_member_profile() returns trigger
  language plpgsql security definer set search_path = public as $$
begin
  update profiles set role = new.role, tabs = new.tabs
    where id = new.user_id and workspace_id = new.workspace_id;
  return new;
end $$;
drop trigger if exists trg_sync_member_profile on workspace_members;
create trigger trg_sync_member_profile
  after insert or update of role, tabs on workspace_members
  for each row execute function public.sync_member_profile();

-- Signup: join invited workspaces, or get your own.
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  inv record;
  ws uuid;
  joined int := 0;
  display text;
begin
  display := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', '')), '');
  insert into profiles (id, email, full_name, role, platform_admin)
  values (new.id, new.email, coalesce(display, ''), 'owner',
          exists (select 1 from platform_admins where lower(email) = lower(new.email)))
  on conflict (id) do nothing;

  for inv in
    select workspace_id, role, tabs from allowed_owners
    where lower(email) = lower(new.email) order by created_at
  loop
    if ws is null then
      ws := inv.workspace_id;
      update profiles set workspace_id = ws where id = new.id;
    end if;
    insert into workspace_members (workspace_id, user_id, role, tabs)
    values (inv.workspace_id, new.id, inv.role, inv.tabs)
    on conflict (workspace_id, user_id) do update set role = excluded.role, tabs = excluded.tabs;
    joined := joined + 1;
  end loop;

  if joined = 0 then
    ws := public.provision_workspace(new.id, new.email,
      coalesce(display, split_part(new.email, '@', 1)) || '''s workspace');
  end if;
  return new;
end;
$$;

-- ---------- Member management RPCs (Owners tab) ----------

create or replace function public.set_member_role(p_email text, p_role text, p_tabs jsonb default null)
returns void
language plpgsql security definer set search_path = public as $$
declare ws uuid := public.current_workspace();
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  update allowed_owners set role = p_role, tabs = p_tabs
    where workspace_id = ws and lower(email) = lower(p_email);
  update workspace_members m set role = p_role, tabs = p_tabs
    from auth.users u
    where u.id = m.user_id and m.workspace_id = ws and lower(u.email) = lower(p_email);
end $$;

create or replace function public.remove_member(p_email text)
returns void
language plpgsql security definer set search_path = public as $$
declare ws uuid := public.current_workspace(); uid uuid; other uuid;
begin
  if not public.is_admin() then raise exception 'Admins only'; end if;
  if lower(p_email) = lower(coalesce(auth.email(), '')) then
    raise exception 'You can''t remove yourself';
  end if;
  delete from allowed_owners where workspace_id = ws and lower(email) = lower(p_email);
  select id into uid from auth.users where lower(email) = lower(p_email);
  if uid is null then return; end if;
  delete from workspace_members where workspace_id = ws and user_id = uid;
  -- Someone removed from their current workspace lands in another one
  -- they belong to, or a fresh one of their own — never in limbo.
  if (select workspace_id from profiles where id = uid) = ws then
    select workspace_id into other from workspace_members where user_id = uid order by created_at limit 1;
    if other is null then
      update profiles set workspace_id = null where id = uid;
      perform public.provision_workspace(uid, p_email, split_part(p_email, '@', 1) || '''s workspace');
    else
      update profiles set workspace_id = other where id = uid;
      update profiles p set role = m.role, tabs = m.tabs from workspace_members m
        where p.id = uid and m.user_id = uid and m.workspace_id = other;
    end if;
  end if;
end $$;

revoke execute on function public.set_member_role(text, text, jsonb) from public, anon;
revoke execute on function public.remove_member(text) from public, anon;
grant execute on function public.set_member_role(text, text, jsonb) to authenticated;
grant execute on function public.remove_member(text) to authenticated;
revoke execute on function public.provision_workspace(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.sync_member_profile() from public, anon, authenticated;
