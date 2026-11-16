begin;
-- Supabase включает safeupdate для запросов API. Он запрещает UPDATE без WHERE
-- даже у служебной таблицы, в которой по ограничению может быть одна строка.
-- Счётчик нужен карте и чату после изменений территории или анкеты питомца.
create or replace function paws.bump_sync_revision() returns trigger
language plpgsql security definer set search_path=pg_catalog,paws as $$
begin
 update paws.sync_revision set revision=revision+1 where id=true;
 return null;
end $$;
-- CREATE OR REPLACE сохраняет владельца и существующие права функции.
-- Миграция не меняет территории, маршруты, балансы или значение счётчика.
do $$ declare flags jsonb;begin
 flags=public.paws_capabilities() || '{"safeSyncRevision":true}'::jsonb;
 execute format('create or replace function public.paws_capabilities() returns jsonb language sql stable security definer set search_path=pg_catalog,paws,pg_temp as %L','select '||quote_literal(flags::text)||'::jsonb;');
end $$;
notify pgrst,'reload schema';
commit;
