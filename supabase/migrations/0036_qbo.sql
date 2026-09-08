-- QuickBooks Online linking: each unit can connect to its own QBO
-- company (OAuth per venue) and pull the YTD-by-month P&L straight
-- from the Reports API — exact figures, no file upload/AI step.
-- Tokens live here but are reachable ONLY by the edge functions'
-- service role: RLS is enabled with no policies. Admins read the
-- connection status (never tokens) through qbo_status().
-- Run after 0035_brand_in_db.sql.

create table if not exists qbo_connections (
  entity_id        uuid primary key references ownership_entities (id) on delete cascade,
  realm_id         text,
  company_name     text,
  refresh_token    text,
  access_token     text,
  access_expires_at timestamptz,
  state_nonce      text,
  state_created_at timestamptz,
  connected_at     timestamptz,
  last_synced_at   timestamptz,
  created_at       timestamptz not null default now()
);

alter table qbo_connections enable row level security;
-- Intentionally no policies: deny all client access.

create or replace function public.qbo_status()
returns table(entity_id uuid, company_name text, connected boolean, connected_at timestamptz, last_synced_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.entity_id, c.company_name, c.refresh_token is not null, c.connected_at, c.last_synced_at
  from qbo_connections c
  where public.is_admin()
$$;
