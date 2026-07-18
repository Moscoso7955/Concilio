-- ============================================================
-- Ownership / relationship graph — boxes (entities) connected by
-- ownership-percentage edges. Shared across owners (not per-user).
-- Entities with an email can double as portal owners: granting access
-- from the details pane writes to allowed_owners (handled app-side).
-- Run after 0003_invoices.sql.
-- ============================================================

create table if not exists ownership_entities (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null default 'New box',
  category    text,             -- free-form parent label (Owner / Product / IP)
  subcategory text,             -- free-form sub label (SaaS / Patent / LLC)
  email       text,
  notes       text,
  color       text,             -- hex like #3b82f6, or null for default styling
  links       jsonb not null default '[]'::jsonb,   -- [{label,url}], max 4 (enforced app-side)
  position_x  double precision,
  position_y  double precision,
  created_at  timestamptz not null default now()
);

create table if not exists ownership_edges (
  id         uuid primary key default uuid_generate_v4(),
  parent_id  uuid not null references ownership_entities(id) on delete cascade,
  child_id   uuid not null references ownership_entities(id) on delete cascade,
  percentage numeric(6,2) not null check (percentage > 0 and percentage <= 100),
  created_at timestamptz not null default now(),
  constraint no_self_ownership check (parent_id <> child_id),
  constraint uq_owner_pair unique (parent_id, child_id)   -- reject duplicate parent→child
);

alter table ownership_entities enable row level security;
alter table ownership_edges    enable row level security;

-- Members can view the map; admins edit it.
create policy "members read entities" on ownership_entities for select using (public.is_member());
create policy "admin write entities" on ownership_entities for all using (public.is_admin()) with check (public.is_admin());
create policy "members read edges" on ownership_edges for select using (public.is_member());
create policy "admin write edges" on ownership_edges for all using (public.is_admin()) with check (public.is_admin());
