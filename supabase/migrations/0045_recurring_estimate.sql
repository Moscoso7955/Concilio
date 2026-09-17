-- How long a recurring task is expected to take (minutes) — sizes the
-- calendar block in "Add to Google Calendar".
alter table public.recurring_tasks add column if not exists est_minutes int;
