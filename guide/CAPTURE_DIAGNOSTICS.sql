-- Диагностика v.1.1.3–v.1.1.4. Вставьте ВЕСЬ файл в Supabase → SQL Editor → New query.
-- Пробует захват внутри откатываемого блока. Территории, баланс и маршрут
-- сохраняются в прежнем состоянии; сообщения Telegram не отправляются.
-- Не переустанавливает миграции и не требует ключей/токенов.
create or replace function pg_temp.dogwars_capture_check(p_actor bigint default null)
returns jsonb language plpgsql as $$
declare
 target record; result jsonb; error_code text; error_message text; error_context text;
 active_count integer;
 capture_oid oid:=to_regprocedure('public.paws_live_capture_shared(bigint)');
 api_can_execute boolean;api_arguments text;
 walk_state jsonb;
begin
 if capture_oid is null then
  return jsonb_build_object('status','missing_rpc','message','Отсутствует public.paws_live_capture_shared(bigint).');
 end if;
 api_can_execute=has_function_privilege('service_role',capture_oid,'execute');
 select pg_get_function_arguments(capture_oid) into api_arguments;
 select count(*) into active_count from paws.walks w
 join paws.live_walks l on l.walk_id=w.id where w.active;
 if p_actor is null and active_count>1 then
  return jsonb_build_object('status','choose_account',
   'message','Активны несколько прогулок. В последней строке скрипта замените null на telegram_account своего аккаунта из списка и выполните скрипт ещё раз.',
   'walks',(select jsonb_agg(t) from (
    select coalesce(l.actor_id,l.owner_id)::text telegram_account,w.started_at
    from paws.walks w join paws.live_walks l on l.walk_id=w.id
    where w.active order by w.started_at desc limit 20) t));
 end if;
 select w.id,coalesce(l.actor_id,l.owner_id) actor,w.started_at,
  l.broadcast_stopped,l.broadcast_until,
  to_timestamp((l.points->-1->>'timestamp')::double precision) last_gps_at,
  jsonb_array_length(l.points) point_count
 into target from paws.walks w join paws.live_walks l on l.walk_id=w.id
 where w.active and (p_actor is null or coalesce(l.actor_id,l.owner_id)=p_actor)
 order by w.started_at desc,w.id limit 1;
 if not found then
  return jsonb_build_object('status','no_active_walk',
   'message','Нет активной Telegram-прогулки для проверки. Пришлите разработчику ошибку из Logs → Postgres за момент неудачного захвата.');
 end if;
 walk_state=jsonb_build_object('started_at',target.started_at,'checked_at',clock_timestamp(),
  'broadcast_stopped',target.broadcast_stopped,'broadcast_until',target.broadcast_until,
  'last_gps_at',target.last_gps_at);
 begin
  result=public.paws_live_capture_shared(target.actor);
  -- Искусственное исключение откатывает ВСЕ действия пробного захвата.
  -- Переменные PL/pgSQL сохраняют результат для ответа диагностики.
  raise exception using errcode='DW001',message='diagnostic rollback';
 exception
  when sqlstate 'DW001' then
   return jsonb_build_object('status','capture_succeeded_in_dry_run',
    'rolled_back',true,'walk_id',target.id,'points',target.point_count,
    'annulled',coalesce((result->>'annulled')::boolean,false),
    'service_role_can_execute',api_can_execute,'api_arguments',api_arguments,'state',walk_state);
  when others then
   get stacked diagnostics error_code=returned_sqlstate,
    error_message=message_text,error_context=pg_exception_context;
   return jsonb_build_object('status','capture_failed','rolled_back',true,
    'walk_id',target.id,'points',target.point_count,'code',error_code,
    'message',error_message,'context',error_context,
    'service_role_can_execute',api_can_execute,'api_arguments',api_arguments,'state',walk_state);
 end;
end $$;

-- Если прогулка одна, оставьте null. Иначе впишите числовой telegram_account.
select pg_temp.dogwars_capture_check(null) as capture_diagnostics;
