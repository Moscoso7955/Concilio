-- ============================================================
-- Accurate "signed up" badge in Settings → Users. The invite itself
-- creates an auth record, so profile presence can't distinguish
-- "accepted the invite" from "still pending". This admin-only function
-- exposes each user's real last sign-in time from auth.users.
-- Run after 0019_access_log.sql.
-- ============================================================

create or replace function public.user_sign_in_status()
returns table(email text, last_sign_in_at timestamptz)
language sql security definer set search_path = ''
as $$
  select lower(u.email) as email, u.last_sign_in_at
  from auth.users u
  where public.is_admin()
$$;
