-- Выполняется владельцем в Supabase SQL Editor после основной миграции v.0.8.
-- Ключ генерируется в Vault и не попадает в репозиторий/команду cron.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
do $$ begin
 if not exists(select 1 from vault.secrets where name='dogwars_scheduler_secret') then
  perform vault.create_secret(replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-',''),
   'dogwars_scheduler_secret','DogWars cron → paws-api');
 end if;
end $$;
select cron.schedule('dogwars-reminders-v08','* * * * *',$job$
 select net.http_post(
  url:='https://fywsqxijebneqkxusgro.supabase.co/functions/v1/paws-api/internal/scheduler',
  headers:=jsonb_build_object('Content-Type','application/json','X-Scheduler-Secret',
   (select decrypted_secret from vault.decrypted_secrets where name='dogwars_scheduler_secret' limit 1)),
  body:='{}'::jsonb,timeout_milliseconds:=10000);
$job$);
commit;
-- Скопируйте результат в Edge Functions → Secrets → SCHEDULER_SECRET.
-- Не отправляйте это значение в чат и не сохраняйте в файлах проекта.
select decrypted_secret as scheduler_secret_for_edge_functions from vault.decrypted_secrets where name='dogwars_scheduler_secret';
