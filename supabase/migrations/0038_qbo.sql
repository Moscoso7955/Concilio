-- ============================================================
-- QuickBooks Online linking (ported from callidus 0036_qbo, workspace-
-- scoped). Each unit can connect to its own QBO company and pull the
-- YTD-by-month P&L from the Reports API. Tokens are reachable ONLY by
-- the edge functions' service role: RLS is enabled with no policies.
-- Admins read connection status (never tokens) through qbo_status(),
-- scoped to their workspace. Run after 0037_billing.sql.
-- ============================================================

create table if not exists qbo_connections (
  entity_id         uuid primary key references ownership_entities (id) on delete cascade,
  workspace_id      uuid not null default public.current_workspace() references workspaces(id) on delete cascade,
  realm_id          text,
  company_name      text,
  refresh_token     text,
  access_token      text,
  access_expires_at timestamptz,
  state_nonce       text,
  state_created_at  timestamptz,
  connected_at      timestamptz,
  last_synced_at    timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists idx_qbo_connections_workspace on qbo_connections (workspace_id);

alter table qbo_connections enable row level security;
-- Intentionally no policies: deny all client access.

create or replace function public.qbo_status()
returns table(entity_id uuid, company_name text, connected boolean, connected_at timestamptz, last_synced_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.entity_id, c.company_name, c.refresh_token is not null, c.connected_at, c.last_synced_at
  from qbo_connections c
  where c.workspace_id = public.current_workspace() and public.is_admin()
$$;
revoke execute on function public.qbo_status() from public, anon;
grant execute on function public.qbo_status() to authenticated;
