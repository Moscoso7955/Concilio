-- ============================================================
-- Mail warm-up + delivery tracking.
-- • mail_deliveries: one row per (campaign, recipient) actually handed
--   to Resend. Powers the warm-up daily caps, lets a capped campaign
--   resume where it left off without double-sending anyone, and makes
--   sent counts exact.
-- • mail_senders.warmup: ramp protocol on/off per venue (on by
--   default — turn off only for a domain that already sends volume).
-- • mail_campaigns.status gains 'sending' for a campaign that is
--   partway through its warm-up chunks.
-- Run after 0032_marketing_branding.sql.
-- ============================================================

create table if not exists mail_deliveries (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references mail_campaigns(id) on delete cascade,
  entity_id   uuid not null references ownership_entities(id) on delete cascade,
  email       text not null,
  sent_at     timestamptz not null default now(),
  unique (campaign_id, email)
);
create index if not exists idx_mail_deliveries_entity_time on mail_deliveries (entity_id, sent_at);

alter table mail_deliveries enable row level security;
drop policy if exists "marketing reads mail deliveries" on mail_deliveries;
create policy "marketing reads mail deliveries" on mail_deliveries
  for select using (public.can_market());
-- Writes come only from the mail-send function (service role bypasses RLS).

alter table mail_senders add column if not exists warmup boolean not null default true;

alter table mail_campaigns drop constraint if exists mail_campaigns_status_check;
alter table mail_campaigns add constraint mail_campaigns_status_check
  check (status in ('draft', 'sending', 'sent'));
