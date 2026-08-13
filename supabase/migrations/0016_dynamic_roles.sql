-- ============================================================
-- Dynamic roles, managed from Settings → Roles. A role carries a display
-- name, its default visible tabs, and its data scope (read_all: sees
-- every unit's data, like accountants — otherwise scoped to the user's
-- ownership slice). admin / owner / accountant become seed rows; admin
-- and owner (Member) are builtin and undeletable. profiles.role and
-- allowed_owners.role now reference roles(key) instead of a hardcoded
-- check, so new roles work everywhere automatically.
-- Run after 0015_roles_and_tabs.sql.
-- ============================================================

create table if not exists roles (
  key        text primary key,
  name       text not null,
  tabs       jsonb,
  read_all   boolean not null default false,
  builtin    boolean not null default false,
  created_at timestamptz not null default now()
);

insert into roles (key, name, tabs, read_all, builtin) values
  ('admin',      'Admin',      null,                                              true,  true),
  ('owner',      'Member',     '["financials","memos","owners"]'::jsonb,          false, true),
  ('accountant', 'Accountant', '["financials","documents","invoices","coa"]'::jsonb, true, false)
on conflict (key) do nothing;

alter table roles enable row level security;
drop policy if exists "members read roles" on roles;
create policy "members read roles" on roles for select using (public.is_member());
drop policy if exists "admin write roles" on roles;
create policy "admin write roles" on roles
  for all using (public.is_admin()) with check (public.is_admin());

-- role columns now reference the roles table
alter table allowed_owners drop constraint if exists allowed_owners_role_check;
alter table allowed_owners drop constraint if exists allowed_owners_role_fkey;
alter table allowed_owners add constraint allowed_owners_role_fkey
  foreign key (role) references roles(key) on update cascade on delete restrict;
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles drop constraint if exists profiles_role_fkey;
alter table profiles add constraint profiles_role_fkey
  foreign key (role) references roles(key) on update cascade on delete restrict;

-- data scope comes from the role's read_all flag (admin always full)
create or replace function public.is_staff() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles p
    left join roles r on r.key = p.role
    where p.id = auth.uid() and (p.role = 'admin' or coalesce(r.read_all, false))
  );
$$;
