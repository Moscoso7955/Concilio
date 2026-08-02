-- Remove the To-Do feature's table (feature retired 2026-08-02; reverses
-- migration 0010). Seeded items are intentionally discarded.
drop table if exists todos;
select count(*) as todos_tables from information_schema.tables where table_name = 'todos';
