-- Where in the day a recurring task sits — drives the calendar event's
-- start (and lets same-day items stagger instead of stacking at 9:00).
alter table public.recurring_tasks add column if not exists start_time time;
