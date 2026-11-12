begin;
-- v.1.1.4 после v.1.1.3. Лимита длительности прогулки больше нет.
-- Заменяются только функции; активные маршруты и балансы не меняются.
do $migration$ declare ns text; begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
create or replace function public.paws_capture(p_user bigint,p_walk uuid,p_points jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare w paws.walks; sample jsonb; lon double precision; lat double precision; accuracy double precision;
 ts double precision; previous_ts double precision; current_point geometry; previous_point geometry; first_point geometry;
 vertices geometry[]='{}'; faces geometry; polygon geometry; remaining geometry; old record; area_m2 double precision; new_id uuid;
 server_now double precision; capture_result jsonb; first_ts double precision;
 distance_m double precision=0;segment_m double precision;average_speed double precision;
begin
 -- Для небольшого сервиса глобальная транзакционная блокировка надёжно
 -- сериализует захваты, в том числе когда старых территорий пока нет.
 perform pg_advisory_xact_lock(413,1);
 server_now=extract(epoch from clock_timestamp());
 select * into w from paws.walks where id=p_walk and owner_id=p_user for update;
 if not found then raise exception 'Прогулка не найдена. Начните новую.'; end if;
 -- Повтор после потери сетевого ответа возвращает тот же результат, без нового захвата.
 if w.result is not null then return w.result; end if;
 if not w.active then raise exception 'Прогулка отменена или завершена. Начните новую.'; end if;
 if p_points is null or jsonb_typeof(p_points)<>'array' then raise exception 'Некорректный маршрут.'; end if;
 if jsonb_array_length(p_points) not between 4 and 5000 then raise exception 'Нужно от 4 до 5000 GPS-точек.'; end if;
 for sample in select value from jsonb_array_elements(p_points) loop
   if jsonb_typeof(sample->'longitude') is distinct from 'number' or jsonb_typeof(sample->'latitude') is distinct from 'number'
      or jsonb_typeof(sample->'accuracy') is distinct from 'number' or jsonb_typeof(sample->'timestamp') is distinct from 'number' then
     raise exception 'Некорректные GPS-данные.';
   end if;
   lon=(sample->>'longitude')::double precision; lat=(sample->>'latitude')::double precision;
   accuracy=(sample->>'accuracy')::double precision; ts=(sample->>'timestamp')::double precision;
   if not(lon between -180 and 180 and lat between -85 and 85 and accuracy between 0 and 20) then raise exception 'Нужны корректные координаты и точность до 20 м.'; end if;
   if not(ts between extract(epoch from w.started_at)-5 and server_now+30) then raise exception 'Проверьте время телефона и начните новую прогулку.'; end if;
   current_point=ST_SetSRID(ST_MakePoint(lon,lat),4326);
   if first_point is null then first_point=current_point;first_ts=ts; end if;
   if abs(lon-ST_X(first_point))>180 then raise exception 'Переход через линию смены дат пока не поддерживается.'; end if;
   if ST_Distance(first_point::geography,current_point::geography)>10000 then raise exception 'Маршрут должен оставаться в радиусе 10 км от старта.'; end if;
   if previous_point is not null then
     if ts<=previous_ts then raise exception 'Нарушен порядок GPS-точек.'; end if;
     segment_m=ST_Distance(previous_point::geography,current_point::geography);
     distance_m=distance_m+segment_m;
     if segment_m>20*(ts-previous_ts)+30 then raise exception 'Слишком большой скачок GPS. Начните новую прогулку.';end if;
   end if;
   if previous_point is null or not ST_Equals(previous_point,current_point) then vertices=array_append(vertices,current_point); end if;
   previous_point=current_point; previous_ts=ts;
 end loop;
 -- Telegram присылает изменения нерегулярно, особенно после остановки.
 -- Уже записанный сервером замкнутый трек можно завершить и после
 -- остановки трансляции. Клиентские/подменённые точки этого исключения не имеют.
 if server_now-previous_ts>15 and not exists(
   select 1 from paws.live_walks recorded
   where recorded.walk_id=w.id and recorded.owner_id=p_user
     and recorded.points=p_points and recorded.message_id is not null
     and recorded.invalid_reason is null
 ) then raise exception 'Нет свежего GPS. Дождитесь точного местоположения.'; end if;
 -- Средняя скорость = сумма GPS-отрезков / время первой–последней точки.
 -- Не используем площадь, внешний периметр, время нажатия кнопки или старт
 -- пустой сессии. Повторные проходы тоже входят в пройденное расстояние.
 average_speed=distance_m/(previous_ts-first_ts)*3.6;
 -- Допуск 0.000001 км/ч нужен только для числовой погрешности на границе 20.
 if average_speed>20.000001 then
  capture_result=jsonb_build_object('annulled',true,'code','SPEED_LIMIT','walkId',w.id,
   'detail','Ай яй яй, захват аннулирован, играй честно','averageSpeedKmh',average_speed,
   'distanceMeters',distance_m,'durationSeconds',previous_ts-first_ts);
  -- Возвращаем результат без RAISE: исключение откатило бы аннулирование.
  -- Edge Function выдаст HTTP 422 уже после фиксации транзакции RPC.
  update paws.walks set active=false,result=capture_result where id=w.id;
  return capture_result;
 end if;
 if cardinality(vertices)<4 then raise exception 'Обойдите участок: точек для площади пока недостаточно.'; end if;
 if ST_Distance(first_point::geography,previous_point::geography)>20 then raise exception 'Контур открыт. Вернитесь к старту в пределах 20 м.'; end if;
 if not ST_Equals(first_point,previous_point) then vertices=array_append(vertices,first_point); end if;
 -- Разбиваем пересечения на узлы и собираем ВСЕ замкнутые грани маршрута.
 -- Затем объединяем внешние кольца: внутренние петли не вырезают отверстия,
 -- повторный проход не удваивает площадь, незамкнутые отростки площади не дают.
 -- Выпуклая оболочка не используется: вогнутые внешние границы сохраняются.
 faces=ST_Polygonize(ARRAY[ST_UnaryUnion(ST_MakeLine(vertices))]);
 select ST_Multi(ST_UnaryUnion(ST_Collect(ST_MakePolygon(ST_ExteriorRing(part.geom)))))
 into polygon from ST_Dump(faces) part;
 if polygon is null or ST_IsEmpty(polygon) then raise exception 'Маршрут не образует замкнутой площади.';end if;
 if not ST_IsValid(polygon) then raise exception 'Не удалось построить внешний контур маршрута.';end if;
 area_m2=ST_Area(polygon::geography);
 if not(area_m2 between 25 and 10000000) then raise exception 'Площадь должна быть от 25 м² до 10 км².'; end if;
 for old in select * from paws.territories where geom && polygon and ST_Intersects(geom,polygon) for update loop
   remaining=ST_Multi(ST_CollectionExtract(ST_Difference(old.geom,polygon),3));
   if ST_IsEmpty(remaining) or ST_Area(remaining::geography)<=0 then delete from paws.territories where id=old.id;
   else update paws.territories set geom=remaining,area=ST_Area(remaining::geography) where id=old.id; end if;
 end loop;
 insert into paws.territories(owner_id,geom,area) values(p_user,ST_Multi(polygon),area_m2) returning id into new_id;
 capture_result=jsonb_build_object('id',new_id,'area',area_m2);
 update paws.walks set active=false,result=capture_result where id=w.id;
 return capture_result;
end $$;
$definition$,'__POSTGIS_SCHEMA__',quote_ident(ns));
end $migration$;

create or replace function public.paws_start(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws as $$
declare w paws.walks; begin
 perform pg_advisory_xact_lock(413,1);
 if not exists(select 1 from paws.pets where owner_id=p_user) then raise exception 'Сначала создайте профиль питомца.'; end if;
 update paws.walks set active=false where owner_id=p_user and active;
 delete from paws.walks where not active and started_at<now()-interval '1 day';
 insert into paws.walks(owner_id) values(p_user) returning * into w;
 return jsonb_build_object('id',w.id,'startedAt',extract(epoch from w.started_at));
end $$;

-- Очищаем точки только завершённых/отменённых сессий. Давность сама
-- по себе не отменяет прогулку; один питомец по-прежнему имеет один трек.
create or replace function paws.live_cleanup() returns void
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 perform pg_advisory_xact_lock(413,1);
 update paws.live_walks l set points='[]'::jsonb from paws.walks w
 where w.id=l.walk_id and not w.active and l.points<>'[]'::jsonb;
end $$;

create or replace function public.paws_live_capture(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;l paws.live_walks;begin
 perform paws.live_cleanup();
 select * into w from paws.walks where owner_id=p_user order by active desc,started_at desc,id limit 1 for update;
 if not found then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
 select * into l from paws.live_walks where walk_id=w.id;
 if not found then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
 if w.result is not null then return w.result;end if;
 if not w.active then raise exception 'Прогулка отменена. Начните новую трансляцию геопозиции.';end if;
 if l.message_id is null then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
 if l.invalid_reason is not null then raise exception '%',l.invalid_reason;end if;
 if jsonb_array_length(l.points)<4 and (l.broadcast_stopped or l.broadcast_until<=clock_timestamp()) then
  raise exception 'В записанном треке недостаточно точных GPS-точек для площади. Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию, пройдите замкнутый маршрут и нажмите «Захватить».';
 end if;
 -- Трансляция может закончиться раньше нажатия кнопки. Проверяем весь
 -- сохранённый трек: время точек, точность, скорость, скачки и замыкание.
 return public.paws_capture(p_user,w.id,l.points);
end $$;

-- Убираем скрытую отмену старой прогулки при обновлении Mini App.
create or replace function public.paws_sync(p_actor bigint,p_walk uuid default null,p_after integer default 0,
 p_channel text default null,p_chat_after bigint default 0,p_context text default null,
 p_notifications_key text default null,p_timezone text default 'UTC') returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare u bigint:=paws.account_owner(p_actor);w paws.walks;l paws.live_walks;a paws.activity;
 n jsonb;nkey text;ctx text;chat jsonb;walk jsonb;points jsonb;start_at integer;total integer;has_pet boolean;
begin
 if p_after is null or p_after not between 0 and 5000 or p_chat_after is null or p_chat_after<0
  or (p_channel is not null and p_channel not in ('district','city','world'))
  or p_timezone is null or length(p_timezone)>100 then raise exception 'Invalid sync parameters';end if;
 select exists(select 1 from paws.pets where owner_id=u) into has_pet;
 if has_pet then
  select * into a from paws.activity where owner_id=u;
  if not found or a.timezone is distinct from p_timezone then
   perform public.paws_activity(u,p_timezone);
   select * into a from paws.activity where owner_id=u;
  elsif a.last_seen<clock_timestamp()-interval '1 minute' then
   -- Сохранённая зона уже проверена: не сканируем pg_timezone_names снова.
   update paws.activity set last_seen=clock_timestamp()
    where owner_id=u and last_seen<clock_timestamp()-interval '1 minute' returning * into a;
   if not found then select * into a from paws.activity where owner_id=u;end if;
  end if;
 end if;
 select * into w from paws.walks where owner_id=u order by active desc,started_at desc,id limit 1;
 if found then
  select * into l from paws.live_walks where walk_id=w.id;
  if found and w.active then
   total=jsonb_array_length(l.points);
   start_at=case when p_walk=w.id and p_after<=total then p_after else 0 end;
   points=case when start_at<total then jsonb_path_query_array(l.points,format('$[%s to last]',start_at)::jsonpath) else '[]'::jsonb end;
   walk=jsonb_build_object('id',w.id,'startedAt',extract(epoch from w.started_at),'points',points,
    'offset',start_at,'pointCount',total,'reset',p_walk is distinct from w.id or p_after>total,
    'error',l.invalid_reason,'waiting',l.message_id is null,'trackingByMe',coalesce(l.actor_id,l.owner_id)=p_actor);
  end if;
 end if;
 n=public.paws_notifications(u);nkey=md5(n::text);
 if p_channel is not null then
  select revision::text || ':' || u::text into ctx from paws.sync_revision where id;
  chat=public.paws_chat_room(u,p_channel,case when ctx=p_context then p_chat_after else 0 end);
  chat=chat||jsonb_build_object('context',ctx,'reset',ctx is distinct from p_context);
 end if;
 return jsonb_build_object('wallet',paws.daily_wallet(u,statement_timestamp()),
  'live',jsonb_build_object('walk',walk,'result',case when not coalesce(w.active,false) then w.result else null end),
  'notifications',case when nkey is distinct from p_notifications_key then n else null end,
  'notificationsKey',nkey,'chat',chat,'deliveryPending',exists(select 1 from paws.notifications where telegram_sent_at is null and retry_at<=clock_timestamp() and (lease_until is null or lease_until<clock_timestamp())),
  'presence',case when has_pet then
   jsonb_build_object('enabled',a.reminders_enabled,'timezone',a.timezone,'lastSeen',extract(epoch from a.last_seen)) else null end);
end $$;

revoke all on function public.paws_capture(bigint,uuid,jsonb),public.paws_start(bigint),
 paws.live_cleanup(),public.paws_live_capture(bigint),
 public.paws_sync(bigint,uuid,integer,text,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.paws_capture(bigint,uuid,jsonb),public.paws_start(bigint),
 paws.live_cleanup(),public.paws_live_capture(bigint),
 public.paws_sync(bigint,uuid,integer,text,bigint,text,text,text) to service_role;
do $$ declare flags jsonb;begin
 flags=public.paws_capabilities() || '{"unlimitedWalkDuration":true,"recordedFinishAfterStop":true}'::jsonb;
 execute format('create or replace function public.paws_capabilities() returns jsonb language sql stable security definer set search_path=pg_catalog,paws,pg_temp as %L','select '||quote_literal(flags::text)||'::jsonb;');
end $$;
notify pgrst,'reload schema';
commit;
