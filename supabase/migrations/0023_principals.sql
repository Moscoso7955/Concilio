-- ============================================================
-- Principals: one portal, many operators. A principal (e.g. Zach /
-- Molzer Development) signs in to the same app and gets their own
-- skin (name, accent, logo — applied by their portal domain before
-- sign-in, or by their account after) and WRITE access scoped to the
-- units they manage: monthly figures / P&L imports and unit documents.
-- The admin stays the sole owner of users, roles, the graph, and
-- everything unscoped. Run after 0022_unit_links.sql.
-- ============================================================

create table if not exists principals (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_email text not null unique,
  brand       jsonb,   -- { accent: "#7c8493", logo_url: "https://..." }
  domain      text,    -- optional hostname whose visitors get this skin
  created_at  timestamptz not null default now()
);

alter table principals enable row level security;
-- Brands must skin the login page before anyone is signed in.
drop policy if exists "anyone reads principal brands" on principals;
create policy "anyone reads principal brands" on principals for select using (true);
drop policy if exists "admin manages principals" on principals;
create policy "admin manages principals" on principals
  for all using (public.is_admin()) with check (public.is_admin());

alter table ownership_entities add column if not exists managed_by uuid references principals(id) on delete set null;

-- Does the signed-in user run the principal that manages this unit?
create or replace function public.manages_entity(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from principals p
    join ownership_entities e on e.managed_by = p.id
    where e.id = eid and lower(p.owner_email) = lower(coalesce(auth.email(), ''))
  );
$$;

-- Built-in role for the Settings dropdowns; scope stays slice-based.
insert into roles (key, name, tabs, read_all, builtin)
  values ('principal', 'Principal', '["financials","memos","documents","owners"]'::jsonb, false, true)
  on conflict (key) do nothing;

-- Principals write monthly figures for their managed units.
drop policy if exists "principal writes financials" on financials;
create policy "principal writes financials" on financials
  for all using (public.manages_entity(entity_id))
  with check (public.manages_entity(entity_id));

-- ...and manage documents assigned to those units.
drop policy if exists "principal writes documents" on documents;
create policy "principal writes documents" on documents
  for all using (entity_id is not null and public.manages_entity(entity_id))
  with check (entity_id is not null and public.manages_entity(entity_id));

-- File uploads into the documents bucket (paths are unguessable;
-- discovery stays gated by the documents table policies).
drop policy if exists "principal insert document files" on storage.objects;
create policy "principal insert document files" on storage.objects
  for insert with check (
    bucket_id = 'documents' and exists (
      select 1 from principals p where lower(p.owner_email) = lower(coalesce(auth.email(), ''))
    )
  );
