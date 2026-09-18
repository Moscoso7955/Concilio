-- Time-tracker categories: what a time entry was FOR (Menu
-- Development, Payroll, …), independent of which unit it was for.
-- Everyone reads them (the timer/log selectors need the list);
-- admins manage them in Management → Settings. Deleting a category
-- keeps the entries (category clears to null).
create table if not exists public.time_categories (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  sort int not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists time_categories_name on public.time_categories (lower(name));
alter table public.time_categories enable row level security;
drop policy if exists tcat_read on public.time_categories;
create policy tcat_read on public.time_categories
  for select using (auth.uid() is not null);
drop policy if exists tcat_admin_all on public.time_categories;
create policy tcat_admin_all on public.time_categories
  for all using (public.is_admin()) with check (public.is_admin());

alter table public.time_entries
  add column if not exists category_id uuid references public.time_categories(id) on delete set null;

insert into public.time_categories (name, sort)
select v.name, v.sort from (values
  ('Menu Development', 1),
  ('Meeting', 2),
  ('R&M', 3),
  ('Facilities', 4),
  ('Opening Rollout', 5),
  ('Design', 6),
  ('Finance', 7),
  ('Payroll', 8),
  ('Prep', 9),
  ('Service', 10),
  ('Site Visit', 11)
) as v(name, sort)
where not exists (select 1 from public.time_categories t where lower(t.name) = lower(v.name));
