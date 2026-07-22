-- ============================================================
-- Personal to-do list (admin-only). Items come from the AI inbox scrub
-- (source='email', source_ref = Gmail thread id for dedupe) or manual
-- adds in the portal. Run after 0009_invoice_splits_qbo.sql.
-- ============================================================

create table if not exists todos (
  id         uuid primary key default uuid_generate_v4(),
  title      text not null,
  notes      text,
  source     text not null default 'manual' check (source in ('manual', 'email', 'agent')),
  source_ref text,             -- e.g. gmail thread id — dedupes repeat scans
  done       boolean not null default false,
  created_at timestamptz not null default now(),
  done_at    timestamptz
);

create unique index if not exists uq_todos_source_ref on todos (source_ref) where source_ref is not null;
create index if not exists idx_todos_open on todos (done, created_at desc);

alter table todos enable row level security;
-- Personal list: admins only (christian). Other owners never see it.
create policy "admin all todos" on todos
  for all using (public.is_admin()) with check (public.is_admin());
