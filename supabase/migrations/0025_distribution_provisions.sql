-- ============================================================
-- Preferred-return provisions on a unit's distributions. A provision
-- is a tranche: "<owner> takes <pref_pct>% of every distribution until
-- <principal> has been recovered", serviced in priority order (lowest
-- first) before the remainder splits pro-rata among the other owners.
-- repaid accumulates as distributions are recorded (and unwinds if a
-- distribution record is deleted). Run after 0024_distributions.sql.
-- ============================================================

create table if not exists dist_provisions (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references ownership_entities(id) on delete cascade,
  owner_id   uuid references ownership_entities(id) on delete set null,
  owner_name text not null,                 -- snapshot label, survives box edits
  principal  numeric not null,              -- amount to recover (e.g. 50000)
  pref_pct   numeric not null,              -- % of each distribution while active
  priority   int not null default 1,        -- lower services first
  repaid     numeric not null default 0,
  notes      text,
  created_at timestamptz not null default now()
);

alter table dist_provisions enable row level security;

drop policy if exists "read provisions by scope" on dist_provisions;
create policy "read provisions by scope" on dist_provisions for select
  using (public.is_staff() or entity_id in (select public.visible_entity_ids()));

drop policy if exists "admin writes provisions" on dist_provisions;
create policy "admin writes provisions" on dist_provisions
  for all using (public.is_admin() or public.manages_entity(entity_id))
  with check (public.is_admin() or public.manages_entity(entity_id));
