-- ============================================================
-- Partner links: connect a unit to another portal running this same
-- codebase. Every unit has exactly one home portal (its manager's);
-- the home side PUBLISHES a read-only feed of the unit's monthly
-- figures, the other side SUBSCRIBES and mirrors them locally.
--   publish   → partner-feed serves financials to holders of link_key
--   subscribe → partner-sync pulls the remote feed into local rows
-- Mirrored financials are stamped with synced_from and are read-only
-- in the UI (the home portal is the source of truth).
-- Admin-only either way. Run after 0021_document_date.sql.
-- ============================================================

create table if not exists unit_links (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references ownership_entities(id) on delete cascade,
  direction      text not null check (direction in ('publish', 'subscribe')),
  partner_name   text not null,
  remote_url     text,           -- subscribe only: partner portal's Supabase URL
  link_key       text not null,
  last_synced_at timestamptz,
  created_at     timestamptz not null default now(),
  unique (entity_id, direction)
);

alter table unit_links enable row level security;
drop policy if exists "admin manages unit links" on unit_links;
create policy "admin manages unit links" on unit_links
  for all using (public.is_admin()) with check (public.is_admin());

-- Mirrored months carry their origin; null = authored on this portal.
alter table financials add column if not exists synced_from text;
