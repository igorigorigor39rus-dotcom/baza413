-- ТОЛЬКО одноразовая локальная БД, не Supabase! Там эти роли/Storage уже есть.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text);
alter table storage.objects enable row level security;
