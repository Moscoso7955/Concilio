-- Personal calendar-feed tokens: the ICS URL's secret. my_ical_token()
-- mints one on first ask and hands the caller only their own.
create table if not exists public.mg_ical_tokens (
  email text primary key,
  token text not null default encode(gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);
alter table public.mg_ical_tokens enable row level security;
-- No client policies: all access flows through the definer function
-- (and the feed edge function via service role).

create or replace function public.my_ical_token()
returns text language plpgsql security definer set search_path = public as $$
declare
  e text := lower(coalesce(auth.jwt()->>'email', ''));
  t text;
begin
  if e = '' then raise exception 'Not signed in'; end if;
  insert into mg_ical_tokens (email) values (e) on conflict (email) do nothing;
  select token into t from mg_ical_tokens where email = e;
  return t;
end $$;
grant execute on function public.my_ical_token() to authenticated;
