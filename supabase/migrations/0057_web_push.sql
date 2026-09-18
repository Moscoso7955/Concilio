-- Web Push: one row per device subscription (a phone and a laptop are
-- two rows). Users manage only their own rows; the send path runs
-- server-side with the service role. push_keys holds the VAPID pair
-- and has NO policies — nothing but the service role can read it.
create table if not exists public.push_subscriptions (
  endpoint text primary key,
  email text not null,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz not null default now()
);
create index if not exists push_subs_email on public.push_subscriptions (email);
alter table public.push_subscriptions enable row level security;
drop policy if exists push_own on public.push_subscriptions;
create policy push_own on public.push_subscriptions
  for all using (lower(email) = lower(coalesce(auth.jwt()->>'email','?')))
  with check (lower(email) = lower(coalesce(auth.jwt()->>'email','?')));

create table if not exists public.push_keys (
  id int primary key default 1,
  public_key text not null,
  private_key text not null,
  created_at timestamptz not null default now()
);
alter table public.push_keys enable row level security;
-- no policies on purpose: service-role only
