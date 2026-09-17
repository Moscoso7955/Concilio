-- ============================================================
-- Every company (tenant) gets its own inbound-bills token, so
-- bills-<token>@bills.conciliowealth.com routes to exactly one
-- workspace. Before this, workspaces provisioned since 0036 had a
-- token-less company and fell back to the first tenant in the database.
-- Run after 0039_budgets.sql.
-- ============================================================

create or replace function public.make_inbound_token(p_name text) returns text
  language plpgsql volatile set search_path = public as $$
declare base text; cand text; i int := 0;
begin
  base := trim(both '-' from regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'));
  base := left(nullif(base, ''), 24);
  loop
    cand := coalesce(base || '-', '') || substr(md5(random()::text || clock_timestamp()::text), 1, 5);
    exit when not exists (select 1 from tenants where inbound_token = cand);
    i := i + 1; if i > 20 then cand := gen_random_uuid()::text; exit; end if;
  end loop;
  return cand;
end $$;

create or replace function public.tenants_default_token() returns trigger
  language plpgsql set search_path = public as $$
begin
  if new.inbound_token is null or new.inbound_token = '' then
    new.inbound_token := public.make_inbound_token(new.name);
  end if;
  return new;
end $$;
drop trigger if exists trg_tenants_default_token on tenants;
create trigger trg_tenants_default_token before insert on tenants
  for each row execute function public.tenants_default_token();

-- Backfill any company that never got one.
update tenants set inbound_token = public.make_inbound_token(name)
  where inbound_token is null or inbound_token = '';

revoke execute on function public.make_inbound_token(text) from public, anon, authenticated;
