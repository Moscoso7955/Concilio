-- ============================================================
-- Marketing access + per-venue branding.
-- • can_market(): admins, plus anyone whose role or per-user tab
--   assignment includes the Marketing tab — so a Marketing role
--   created in Settings gets full campaign access with no code change,
--   and no access to anything else.
-- • ownership_entities.in_marketing: the Ownership-pane toggle that
--   surfaces a venue in the Marketing tab.
-- • Branding on the sender profile: email header image + colors,
--   used by the campaign template. Sender identity fields become
--   nullable so branding can be set up before the from-address.
-- • marketing_units(): venue names for the Marketing tab without
--   opening the ownership table to marketing users.
-- Run after 0031_mailing.sql.
-- ============================================================

alter table ownership_entities add column if not exists in_marketing boolean not null default false;

alter table mail_senders add column if not exists header_image_url text;
alter table mail_senders add column if not exists accent text;
alter table mail_senders add column if not exists card_bg text;
alter table mail_senders add column if not exists page_bg text;
alter table mail_senders alter column from_name drop not null;
alter table mail_senders alter column from_email drop not null;

create or replace function public.can_market() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from profiles p
    left join roles r on r.key = p.role
    where p.id = auth.uid()
      and (coalesce(p.tabs, '[]'::jsonb) ? 'marketing'
        or coalesce(r.tabs, '[]'::jsonb) ? 'marketing')
  );
$$;

drop policy if exists "admin manages mail senders" on mail_senders;
drop policy if exists "marketing manages mail senders" on mail_senders;
create policy "marketing manages mail senders" on mail_senders
  for all using (public.can_market()) with check (public.can_market());

drop policy if exists "admin manages mail subscribers" on mail_subscribers;
drop policy if exists "marketing manages mail subscribers" on mail_subscribers;
create policy "marketing manages mail subscribers" on mail_subscribers
  for all using (public.can_market()) with check (public.can_market());

drop policy if exists "admin manages mail campaigns" on mail_campaigns;
drop policy if exists "marketing manages mail campaigns" on mail_campaigns;
create policy "marketing manages mail campaigns" on mail_campaigns
  for all using (public.can_market()) with check (public.can_market());

create or replace function public.marketing_units()
returns table(id uuid, name text)
language sql stable security definer set search_path = public as $$
  select e.id, e.name from ownership_entities e
  where e.kind = 'entity' and e.in_marketing and public.can_market()
  order by e.name
$$;

-- Header images live in the public site-assets bucket under mail/.
drop policy if exists "marketing write mail assets" on storage.objects;
create policy "marketing write mail assets" on storage.objects
  for insert with check (bucket_id = 'site-assets' and name like 'mail/%' and public.can_market());
drop policy if exists "marketing update mail assets" on storage.objects;
create policy "marketing update mail assets" on storage.objects
  for update using (bucket_id = 'site-assets' and name like 'mail/%' and public.can_market());
drop policy if exists "marketing delete mail assets" on storage.objects;
create policy "marketing delete mail assets" on storage.objects
  for delete using (bucket_id = 'site-assets' and name like 'mail/%' and public.can_market());
