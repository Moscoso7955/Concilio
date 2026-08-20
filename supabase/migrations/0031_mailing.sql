-- ============================================================
-- Outgoing mail: one campaign engine, per-unit senders. Each venue
-- (unit) gets a sender profile (from name/email on ITS verified
-- domain, physical address for the CAN-SPAM footer, logo, and the
-- venue app's sync endpoint). Subscribers are synced per unit before
-- a send; unsubscribes/bounces/complaints are permanent suppression.
-- Campaigns are drafts until sent. Admin-only for now (a Marketing
-- role can be granted the tab later). Run after 0030_fbh_tenant.sql.
-- ============================================================

create table if not exists mail_senders (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null unique references ownership_entities(id) on delete cascade,
  from_name  text not null,
  from_email text not null,           -- on the venue's verified sending domain
  address    text,                    -- physical address (required in footers)
  logo_url   text,
  sync_url   text,                    -- venue app endpoint returning subscribers
  sync_key   text,                    -- bearer secret for that endpoint
  last_synced_at timestamptz,
  created_at timestamptz not null default now()
);
alter table mail_senders enable row level security;
drop policy if exists "admin manages mail senders" on mail_senders;
create policy "admin manages mail senders" on mail_senders
  for all using (public.is_admin()) with check (public.is_admin());

create table if not exists mail_subscribers (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references ownership_entities(id) on delete cascade,
  email           text not null,     -- stored lowercased
  name            text,
  source          text,              -- newsletter / contact form / import…
  subscribed_at   timestamptz not null default now(),
  unsubscribed_at timestamptz,
  bounced_at      timestamptz,
  complaint_at    timestamptz,
  unsub_token     uuid not null default gen_random_uuid(),
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_mail_sub on mail_subscribers (entity_id, email);
create index if not exists idx_mail_sub_token on mail_subscribers (unsub_token);
alter table mail_subscribers enable row level security;
drop policy if exists "admin manages mail subscribers" on mail_subscribers;
create policy "admin manages mail subscribers" on mail_subscribers
  for all using (public.is_admin()) with check (public.is_admin());

create table if not exists mail_campaigns (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references ownership_entities(id) on delete cascade,
  subject      text not null,
  preview_text text,
  body_html    text,
  status       text not null default 'draft' check (status in ('draft','sent')),
  sent_at      timestamptz,
  sent_count   int,
  failed_count int,
  test_sent_at timestamptz,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table mail_campaigns enable row level security;
drop policy if exists "admin manages mail campaigns" on mail_campaigns;
create policy "admin manages mail campaigns" on mail_campaigns
  for all using (public.is_admin()) with check (public.is_admin());
