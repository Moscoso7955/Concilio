-- Month-end settle-up: track when the transfer actually happened.
alter table public.ic_settlements add column if not exists paid_at timestamptz;
