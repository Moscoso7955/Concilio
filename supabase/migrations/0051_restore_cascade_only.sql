-- Restoring a task was also resurrecting notes the user had deleted
-- individually BEFORE deleting the task. Cascade captures happen in
-- the same transaction as the task capture, so they share its exact
-- deleted_at — restore only those.
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
    -- only the notes swept away by this same delete (same transaction
    -- timestamp), not ones deleted deliberately beforehand
    for d in select * from deleted_items
      where kind = 'task_note' and restored_at is null
        and (payload->>'task_id')::uuid = r.item_id
        and deleted_at = r.deleted_at loop
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
