-- ============================================================
-- Document Hub — shared documentation for owners.
-- Admins upload; all signed-in members can view/download.
-- Files live in a PRIVATE bucket, accessed via signed URLs.
-- Run after 0001_full_backend.sql.
-- ============================================================

create table if not exists documents (
  id               uuid primary key default uuid_generate_v4(),
  title            text not null,
  description      text,
  category         text,
  file_path        text not null,        -- path within the private 'documents' bucket
  file_name        text not null,
  mime             text,
  size_bytes       bigint,
  uploaded_by      uuid references auth.users(id),
  uploaded_by_name text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_documents_created on documents (created_at desc);

alter table documents enable row level security;

create policy "members read documents" on documents
  for select using (public.is_member());
create policy "admin write documents" on documents
  for all using (public.is_admin()) with check (public.is_admin());

-- Private bucket: no public URLs; downloads use short-lived signed URLs.
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy "members read document files" on storage.objects
  for select using (bucket_id = 'documents' and public.is_member());
create policy "admin insert document files" on storage.objects
  for insert with check (bucket_id = 'documents' and public.is_admin());
create policy "admin update document files" on storage.objects
  for update using (bucket_id = 'documents' and public.is_admin());
create policy "admin delete document files" on storage.objects
  for delete using (bucket_id = 'documents' and public.is_admin());
