-- Safety net for the Management module: every deleted task, time
-- entry, recurring definition, and note is captured by trigger into
-- deleted_items (full row as jsonb, who and when), and staff can bring
-- one back with restore_deleted(). Restoring a task also restores the
-- notes that its delete cascaded away.
create table if not exists public.deleted_items (
  id uuid primary key default uuid_generate_v4(),
  kind text not null check (kind in ('task','time_entry','recurring_task','task_note')),
  item_id uuid not null,
  payload jsonb not null,
  deleted_by text,
  deleted_at timestamptz not null default now(),
  restored_at timestamptz
);
create index if not exists deleted_items_when on public.deleted_items (deleted_at desc);
alter table public.deleted_items enable row level security;
drop policy if exists del_staff_read on public.deleted_items;
create policy del_staff_read on public.deleted_items
  for select using (public.is_staff());

create or replace function public.mg_capture_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.deleted_items (kind, item_id, payload, deleted_by)
  values (tg_argv[0], old.id, to_jsonb(old), coalesce(auth.jwt()->>'email',''));
  return old;
end $$;

drop trigger if exists tasks_capture_delete on public.tasks;
create trigger tasks_capture_delete before delete on public.tasks
  for each row execute function public.mg_capture_delete('task');
drop trigger if exists time_capture_delete on public.time_entries;
create trigger time_capture_delete before delete on public.time_entries
  for each row execute function public.mg_capture_delete('time_entry');
drop trigger if exists recur_capture_delete on public.recurring_tasks;
create trigger recur_capture_delete before delete on public.recurring_tasks
  for each row execute function public.mg_capture_delete('recurring_task');
drop trigger if exists notes_capture_delete on public.task_notes;
create trigger notes_capture_delete before delete on public.task_notes
  for each row execute function public.mg_capture_delete('task_note');

create or replace function public.restore_deleted(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r record;
  d record;
begin
  if not public.is_staff() then raise exception 'Not allowed'; end if;
  select * into r from deleted_items where id = p_id and restored_at is null;
  if not found then raise exception 'Nothing to restore'; end if;

  if r.kind = 'task' then
    insert into tasks select * from jsonb_populate_record(null::tasks, r.payload)
      on conflict do nothing;
    -- notes lost in the same cascade come back with the task
    for d in select * from deleted_items
      where kind = 'task_note' and restored_at is null
        and (payload->>'task_id')::uuid = r.item_id loop
      insert into task_notes select * from jsonb_populate_record(null::task_notes, d.payload)
        on conflict do nothing;
      update deleted_items set restored_at = now() where id = d.id;
    end loop;
  elsif r.kind = 'time_entry' then
    insert into time_entries select * from jsonb_populate_record(null::time_entries, r.payload)
      on conflict do nothing;
  elsif r.kind = 'recurring_task' then
    insert into recurring_tasks select * from jsonb_populate_record(null::recurring_tasks, r.payload)
      on conflict do nothing;
  elsif r.kind = 'task_note' then
    if not exists (select 1 from tasks where id = (r.payload->>'task_id')::uuid) then
      raise exception 'Restore the task first — this note belongs to a deleted task';
    end if;
    insert into task_notes select * from jsonb_populate_record(null::task_notes, r.payload)
      on conflict do nothing;
  end if;

  update deleted_items set restored_at = now() where id = p_id;
end $$;
grant execute on function public.restore_deleted(uuid) to authenticated;
