-- ============================================================
-- Three roles + per-user tab assignment, managed from the new Settings
-- menu. Roles: admin (Christian, full control), accountant (view-only
-- staff — reads everything, sees the tabs assigned to them), owner
-- (displayed as "Member" — view-only, scoped to their downstream slice).
-- profiles.tabs / allowed_owners.tabs hold an optional per-user list of
-- visible tabs; null means the role's default set.
-- Run after 0014_memos_admin_only.sql.
-- ============================================================

-- accountant joins the role checks
alter table allowed_owners drop constraint if exists allowed_owners_role_check;
alter table allowed_owners add constraint allowed_owners_role_check
  check (role in ('owner','admin','accountant'));
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('owner','admin','accountant'));

-- per-user visible-tab override (jsonb array of tab keys; null = default)
alter table allowed_owners add column if not exists tabs jsonb;
alter table profiles add column if not exists tabs jsonb;

-- staff = admin or accountant: the read-everything scope
create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role in ('admin','accountant'));
$$;

-- signup now copies tabs from the allowlist row as well
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare
  allowed record;
begin
  select role, tabs into allowed
  from allowed_owners
  where lower(email) = lower(new.email);

  if allowed.role is null then
    raise exception 'Email % is not authorized for portal access', new.email;
  end if;

  insert into profiles (id, email, full_name, role, tabs)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), allowed.role, allowed.tabs);

  return new;
end;
$$;

-- admins manage signed-up users (role/tab changes + full revoke)
drop policy if exists "admin update profiles" on profiles;
create policy "admin update profiles" on profiles
  for update using (public.is_admin()) with check (public.is_admin());
drop policy if exists "admin delete profiles" on profiles;
create policy "admin delete profiles" on profiles
  for delete using (public.is_admin());

-- Reports scope: staff read everything; owners their downstream slice.
do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'financials' and cmd = 'SELECT'
  loop execute format('drop policy %I on financials', p.policyname); end loop;
end $$;
create policy "read financials by role" on financials for select
  using (public.is_staff() or entity_id in (select public.visible_entity_ids()));

do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ownership_entities' and cmd = 'SELECT'
  loop execute format('drop policy %I on ownership_entities', p.policyname); end loop;
end $$;
create policy "read entities by role" on ownership_entities for select
  using (public.is_staff() or id in (select public.visible_entity_ids()));

do $$ declare p record; begin
  for p in select policyname from pg_policies
    where schemaname = 'public' and tablename = 'ownership_edges' and cmd = 'SELECT'
  loop execute format('drop policy %I on ownership_edges', p.policyname); end loop;
end $$;
create policy "read edges by role" on ownership_edges for select
  using (public.is_staff() or (
    parent_id in (select public.visible_entity_ids())
    and child_id in (select public.visible_entity_ids())
  ));

-- Invoices / documents / chart data: staff only (members' portal shows
-- Reports, Memo Board, and Ownership; they no longer read these at all).
drop policy if exists "members read invoices" on invoices;
create policy "staff read invoices" on invoices for select using (public.is_staff());
drop policy if exists "members read gl_codes" on gl_codes;
create policy "staff read gl_codes" on gl_codes for select using (public.is_staff());
drop policy if exists "members read tenants" on tenants;
create policy "staff read tenants" on tenants for select using (public.is_staff());
drop policy if exists "members read ai_usage" on ai_usage;
create policy "staff read ai_usage" on ai_usage for select using (public.is_staff());
drop policy if exists "members read documents" on documents;
create policy "staff read documents" on documents for select using (public.is_staff());

drop policy if exists "members read invoice files" on storage.objects;
create policy "staff read invoice files" on storage.objects
  for select using (bucket_id = 'invoices' and public.is_staff());
drop policy if exists "members read document files" on storage.objects;
create policy "staff read document files" on storage.objects
  for select using (bucket_id = 'documents' and public.is_staff());
