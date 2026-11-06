-- ЕДИНЫЙ переход с v0.2–v.0.5 на v.0.6 после базовой миграции.
-- Повторное применение сохраняет данные и баланс. Включает основу досье v0.3.
-- Применяется ПОСЛЕ 202611050001_paws.sql. Не начисляет награды задним числом.
begin;
-- Согласуем начало начислений с уже работающими захватами.
select pg_advisory_xact_lock(413,1);
alter table paws.pets add column if not exists hue integer check(hue between 0 and 359);
alter table paws.pets add column if not exists saturation integer not null default 55 check(saturation between 20 and 100);
alter table paws.pets add column if not exists opacity numeric not null default .35 check(opacity between .15 and .8);
alter table paws.pets add column if not exists pattern text not null default 'solid' check(pattern in('solid','stripes','grid','camo'));
create table if not exists paws.wallets(
 owner_id bigint primary key references paws.pets(owner_id), balance numeric not null default 0 check(balance>=0),
 checked_at timestamptz not null default clock_timestamp());
insert into paws.wallets(owner_id) select owner_id from paws.pets on conflict do nothing;
alter table paws.wallets enable row level security;
revoke all on paws.wallets from public,anon,authenticated;

create or replace function paws.pet_json(p_user bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
declare p paws.pets; begin
 select * into p from paws.pets where owner_id=p_user;
 if not found then return null; end if;
 return jsonb_build_object('id',p.owner_id::text,'name',p.name,'age',p.age,'description',p.description,
 'color',p.color,'photo_key',p.photo_key,'hue',p.hue,'saturation',p.saturation,'opacity',p.opacity,'pattern',p.pattern);
end $$;

create or replace function public.paws_save_dossier(p_user bigint,p_name text,p_age numeric,p_description text,p_color text,
 p_hue integer,p_saturation integer,p_opacity numeric,p_pattern text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if p_hue is null or p_hue not between 0 and 359 or p_saturation is null or p_saturation not between 20 and 100
 or p_opacity is null or p_opacity not between .15 and .8 or p_pattern is null or p_pattern not in('solid','stripes','grid','camo') then
 raise exception 'Проверьте оттенок и рисунок заливки.'; end if;
 perform public.paws_save_pet(p_user,p_name,p_age,p_description,p_color);
 update paws.pets set hue=p_hue,saturation=p_saturation,opacity=p_opacity,pattern=p_pattern where owner_id=p_user;
 return public.paws_me(p_user);
end $$;

-- Перед каждым изменением площади фиксируем доход за предыдущий интервал.
-- Часы браузера и присутствие пользователя в приложении на начисление не влияют.
create or replace function paws.settle(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.wallets; sqm numeric; checkpoint timestamptz; begin
 perform pg_advisory_xact_lock(413,1);
 insert into paws.wallets(owner_id) values(p_user) on conflict do nothing;
 select * into w from paws.wallets where owner_id=p_user for update;
 checkpoint=clock_timestamp();
 select coalesce(sum(area),0)::numeric into sqm from paws.territories where owner_id=p_user;
 update paws.wallets set balance=balance+sqm*greatest(extract(epoch from checkpoint-w.checked_at),0)/3600,
 checked_at=checkpoint where owner_id=p_user returning * into w;
 return jsonb_build_object('balance',w.balance,'rate',sqm,'asOf',extract(epoch from checkpoint));
end $$;
create or replace function public.paws_wallet(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if not exists(select 1 from paws.pets where owner_id=p_user) then return '{"balance":0,"rate":0}'::jsonb; end if;
 return paws.settle(p_user);
end $$;
create or replace function paws.before_area_change() returns trigger
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if TG_OP in('UPDATE','DELETE') then perform paws.settle(OLD.owner_id); end if;
 if TG_OP='INSERT' or (TG_OP='UPDATE' and OLD.owner_id<>NEW.owner_id) then perform paws.settle(NEW.owner_id); end if;
 if TG_OP='DELETE' then return OLD; end if; return NEW;
end $$;
drop trigger if exists paws_income on paws.territories;
create trigger paws_income before insert or update or delete on paws.territories for each row execute function paws.before_area_change();

create table if not exists paws.messages(
 id bigint generated always as identity primary key,owner_id bigint not null references paws.pets(owner_id),
 text text not null check(length(trim(text)) between 1 and 500),created_at timestamptz not null default clock_timestamp());
create index if not exists paws_messages_owner_time on paws.messages(owner_id,created_at desc);
alter table paws.messages enable row level security;
revoke all on paws.messages from public,anon,authenticated;
create or replace function public.paws_chat(p_user bigint,p_after bigint default 0) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 return (select jsonb_build_object('messages',coalesce(jsonb_agg(jsonb_build_object('id',m.id::text,'text',m.text,
 'createdAt',extract(epoch from m.created_at),'pet',paws.pet_json(m.owner_id)) order by m.id),'[]'::jsonb))
 from (select * from paws.messages where id>p_after order by id desc limit 100) m);
end $$;
create or replace function public.paws_send(p_user bigint,p_text text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare last_at timestamptz; begin
 -- Блокируем профиль, чтобы параллельные запросы не обходили ограничение частоты.
 perform 1 from paws.pets where owner_id=p_user for update;
 if not found then raise exception 'Сначала создайте досье питомца.'; end if;
 if p_text is null or length(trim(p_text)) not between 1 and 500 then raise exception 'Сообщение должно содержать от 1 до 500 символов.'; end if;
 select max(created_at) into last_at from paws.messages where owner_id=p_user;
 if last_at>clock_timestamp()-interval '3 seconds' then raise exception 'Подождите 3 секунды перед следующим сообщением.'; end if;
 insert into paws.messages(owner_id,text) values(p_user,trim(p_text));
 return '{"ok":true}'::jsonb;
end $$;
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname in('paws_save_dossier','paws_wallet','paws_chat','paws_send'))
 or (n.nspname='paws' and p.proname in('settle','before_area_change','pet_json')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- v.0.4: публичный снимок баланса без изменения чужого кошелька.
create or replace function paws.public_wallet(p_user bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.wallets; sqm numeric; checkpoint timestamptz=statement_timestamp(); begin
 select coalesce(sum(area),0)::numeric into sqm from paws.territories where owner_id=p_user;
 select * into w from paws.wallets where owner_id=p_user;
 if not found then return jsonb_build_object('balance',0,'rate',sqm,'asOf',extract(epoch from checkpoint)); end if;
 return jsonb_build_object('balance',w.balance+sqm*greatest(extract(epoch from checkpoint-w.checked_at),0)/3600,
 'rate',sqm,'asOf',extract(epoch from checkpoint));
end $$;
create or replace function public.paws_pet(p_user bigint,p_pet bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
declare p jsonb; begin
 p=paws.pet_json(p_pet);if p is null then return null;end if;
 return p||jsonb_build_object('wallet',paws.public_wallet(p_pet));
end $$;
create or replace function public.paws_capabilities() returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select '{"dossier":true,"chat":true,"wallet":true,"publicWallet":true,"photoLimit":1000000}'::jsonb;
$$;
revoke all on function paws.public_wallet(bigint) from public,anon,authenticated;
revoke all on function public.paws_capabilities() from public,anon,authenticated;
grant execute on function paws.public_wallet(bigint),public.paws_capabilities() to service_role;
-- Существующие фото сохраняются. Ограничение применяется к новым загрузкам.
update storage.buckets set file_size_limit=1000000 where id='paws-photos';
notify pgrst,'reload schema';



-- PL/pgSQL проверяет типы geometry при создании. Подставляем schema PostGIS
-- через quote_ident: расширение может уже находиться в public, extensions или gis.
do $migration$ declare ns text; begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
create or replace function public.paws_capture(p_user bigint,p_walk uuid,p_points jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare w paws.walks; sample jsonb; lon double precision; lat double precision; accuracy double precision;
 ts double precision; previous_ts double precision; current_point geometry; previous_point geometry; first_point geometry;
 vertices geometry[]='{}'; faces geometry; polygon geometry; remaining geometry; old record; area_m2 double precision; new_id uuid;
 server_now double precision; capture_result jsonb;
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
 if server_now-extract(epoch from w.started_at)>7200 then raise exception 'Прогулка длится больше 2 часов. Начните новую.'; end if;
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
   if first_point is null then first_point=current_point; end if;
   if abs(lon-ST_X(first_point))>180 then raise exception 'Переход через линию смены дат пока не поддерживается.'; end if;
   if ST_Distance(first_point::geography,current_point::geography)>10000 then raise exception 'Маршрут должен оставаться в радиусе 10 км от старта.'; end if;
   if previous_point is not null then
     if ts<=previous_ts or ts-previous_ts>45 then raise exception 'В записи есть перерыв GPS больше 45 секунд или нарушен порядок точек.'; end if;
     if ST_Distance(previous_point::geography,current_point::geography)>20*(ts-previous_ts)+30 then raise exception 'Слишком большой скачок GPS. Начните новую прогулку.'; end if;
   end if;
   if previous_point is null or not ST_Equals(previous_point,current_point) then vertices=array_append(vertices,current_point); end if;
   previous_point=current_point; previous_ts=ts;
 end loop;
 if server_now-previous_ts>15 then raise exception 'Нет свежего GPS. Дождитесь точного местоположения.'; end if;
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


-- Рейтинг читает баланс и начисления одним снимком времени, не меняя кошельки.
create or replace function public.paws_top(p_user bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 return (select jsonb_build_object('agents',coalesce(jsonb_agg(jsonb_build_object('pet',pet,'wallet',wallet) order by balance desc,owner_id),'[]'::jsonb))
 from (select p.owner_id,paws.pet_json(p.owner_id) pet,paws.public_wallet(p.owner_id) wallet,
 ((paws.public_wallet(p.owner_id))->>'balance')::numeric balance from paws.pets p order by balance desc,p.owner_id limit 10) ranked);
end $$;

-- Временные точки фоновой прогулки приходят ТОЛЬКО через подписанный webhook
-- Telegram. Веб-странице нельзя прислать свои точки в этот RPC.
create table if not exists paws.live_walks(
 walk_id uuid primary key references paws.walks(id) on delete cascade,
 owner_id bigint not null references paws.pets(owner_id),message_id bigint,
 last_update bigint not null default -1,points jsonb not null default '[]',invalid_reason text);
create index if not exists paws_live_owner on paws.live_walks(owner_id);
alter table paws.live_walks enable row level security;
revoke all on paws.live_walks from public,anon,authenticated;

create or replace function paws.clear_live_points() returns trigger
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if not NEW.active then update paws.live_walks set points='[]'::jsonb where walk_id=NEW.id;end if;
 return NEW;
end $$;
drop trigger if exists paws_clear_live on paws.walks;
create trigger paws_clear_live after update of active on paws.walks for each row execute function paws.clear_live_points();

create or replace function paws.live_cleanup() returns void
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 perform pg_advisory_xact_lock(413,1);
 update paws.walks set active=false where active and started_at<clock_timestamp()-interval '2 hours'
 and id in(select walk_id from paws.live_walks);
 update paws.live_walks l set points='[]'::jsonb from paws.walks w where w.id=l.walk_id and not w.active and l.points<>'[]'::jsonb;
end $$;

create or replace function public.paws_live_status(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;l paws.live_walks;begin
 perform paws.live_cleanup();
 select * into w from paws.walks where owner_id=p_user order by active desc,started_at desc,id limit 1;
 if not found then return '{"walk":null}'::jsonb;end if;
 select * into l from paws.live_walks where walk_id=w.id;
 if not found then return '{"walk":null}'::jsonb;end if;
 if not w.active then return jsonb_build_object('walk',null,'result',w.result);end if;
 return jsonb_build_object('walk',jsonb_build_object('id',w.id,'startedAt',extract(epoch from w.started_at),
 'points',l.points,'error',l.invalid_reason,'waiting',l.message_id is null));
end $$;

create or replace function public.paws_live_start(p_user bigint,p_accuracy numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare result jsonb;begin
 if p_accuracy is null or not(p_accuracy between 0 and 20) then raise exception 'Перед стартом нужна точность GPS ≤20 м.';end if;
 perform paws.live_cleanup();result=public.paws_start(p_user);
 insert into paws.live_walks(walk_id,owner_id)values((result->>'id')::uuid,p_user);
 return public.paws_live_status(p_user);
end $$;

create or replace function paws.geo_gap(a jsonb,b jsonb) returns double precision
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 return ST_Distance(ST_SetSRID(ST_MakePoint((a->>'longitude')::float8,(a->>'latitude')::float8),4326)::geography,
 ST_SetSRID(ST_MakePoint((b->>'longitude')::float8,(b->>'latitude')::float8),4326)::geography);
end $$;

create or replace function public.paws_live_point(p_user bigint,p_message bigint,p_update bigint,p_timestamp double precision,
 p_longitude double precision,p_latitude double precision,p_accuracy double precision,p_period integer) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;l paws.live_walks;current jsonb;previous jsonb;dt double precision;reason text;begin
 perform paws.live_cleanup();
 select * into w from paws.walks where owner_id=p_user and active order by started_at desc,id limit 1 for update;
 if not found then return '{"accepted":false,"reason":"no_walk"}'::jsonb;end if;
 select * into l from paws.live_walks where walk_id=w.id for update;
 if not found then return '{"accepted":false,"reason":"no_walk"}'::jsonb;end if;
 if p_message is null or p_message<=0 or p_update is null or p_update<=l.last_update then return '{"accepted":false,"reason":"duplicate"}'::jsonb;end if;
 if l.message_id is not null and l.message_id<>p_message then return '{"accepted":false,"reason":"other_message"}'::jsonb;end if;
 if p_period is null or p_period<=0 then return '{"accepted":false,"reason":"not_live"}'::jsonb;end if;
 if p_timestamp is null or not(p_timestamp between extract(epoch from w.started_at)-5 and extract(epoch from clock_timestamp())+30) then return '{"accepted":false,"reason":"old"}'::jsonb;end if;
 update paws.live_walks set message_id=p_message,last_update=p_update where walk_id=w.id;
 if l.invalid_reason is not null then return jsonb_build_object('accepted',false,'reason','invalid');end if;
 if p_accuracy is null or not(p_accuracy between 0 and 20) then return '{"accepted":false,"reason":"accuracy"}'::jsonb;end if;
 if p_longitude is null or p_latitude is null or not(p_longitude between -180 and 180 and p_latitude between -85 and 85) then return '{"accepted":false,"reason":"coordinates"}'::jsonb;end if;
 current=jsonb_build_object('longitude',p_longitude,'latitude',p_latitude,'accuracy',p_accuracy,'timestamp',p_timestamp);
 previous=l.points->-1;
 if previous is not null then
  dt=p_timestamp-(previous->>'timestamp')::double precision;
  if dt<=0 then return '{"accepted":false,"reason":"old"}'::jsonb;end if;
  if dt>45 then reason='Перерыв GPS больше 45 секунд. Начните новую прогулку.';
  elsif paws.geo_gap(previous,current)>20*dt+30 then reason='Обнаружен скачок GPS. Начните новую прогулку.';end if;
  if paws.geo_gap(l.points->0,current)>10000 or abs(p_longitude-(l.points->0->>'longitude')::float8)>180 then reason='Маршрут вне допустимой области. Начните новую прогулку.';end if;
 end if;
 if jsonb_array_length(l.points)>=5000 then reason='Достигнут предел 5000 точек. Начните новую прогулку.';end if;
 if reason is not null then update paws.live_walks set invalid_reason=reason where walk_id=w.id;return jsonb_build_object('accepted',false,'reason','gap','message',reason);end if;
 update paws.live_walks set points=points||jsonb_build_array(current) where walk_id=w.id;
 return jsonb_build_object('accepted',true,'first',jsonb_array_length(l.points)=0);
end $$;

create or replace function public.paws_live_capture(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;l paws.live_walks;begin
 perform paws.live_cleanup();
 select * into w from paws.walks where owner_id=p_user order by active desc,started_at desc,id limit 1 for update;
 if not found then raise exception 'Нет фоновой прогулки. Начните её в мини-приложении.';end if;
 select * into l from paws.live_walks where walk_id=w.id;
 if not found then raise exception 'Нет фоновой прогулки. Начните её в мини-приложении.';end if;
 if w.result is not null then return w.result;end if;
 if l.invalid_reason is not null then raise exception '%',l.invalid_reason;end if;
 return public.paws_capture(p_user,w.id,l.points);
end $$;
create or replace function public.paws_live_cancel(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;begin
 perform paws.live_cleanup();select w1.* into w from paws.walks w1 join paws.live_walks l on l.walk_id=w1.id where w1.owner_id=p_user and w1.active order by w1.started_at desc limit 1;
 if found then perform public.paws_cancel(p_user,w.id);end if;return '{"ok":true}'::jsonb;
end $$;
create or replace function public.paws_capabilities() returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select '{"dossier":true,"chat":true,"wallet":true,"publicWallet":true,"photoLimit":1000000,"leaderboard":true,"liveTracking":true,"autoLiveStart":true,"crossingRoutes":true,"maxAccuracy":20,"closureMeters":20,"purchases":true,"purchasePrice":10,"territoryLeaderboard":true}'::jsonb;
$$;
do $$ declare f record;ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute format('alter function paws.geo_gap(jsonb,jsonb) set search_path to pg_catalog,paws,%I,pg_temp',ns);
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where(n.nspname='public' and p.proname in('paws_top','paws_live_status','paws_live_start','paws_live_point','paws_live_capture','paws_live_cancel','paws_capabilities'))
 or(n.nspname='paws' and p.proname in('clear_live_points','live_cleanup','geo_gap'))loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';

-- Приём трансляции автоматически подготавливает прогулку. Сам трек начинается
-- с первой точной точки (≤20 м). edited_message без исходного нового сообщения
-- не запускает прогулку: после захвата/отмены старый поток не должен оживать.
create or replace function public.paws_live_receive(p_user bigint,p_message bigint,p_update bigint,
 p_timestamp double precision,p_sent_at double precision,p_longitude double precision,p_latitude double precision,
 p_accuracy double precision,p_period integer,p_initial boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.walks;l paws.live_walks;created jsonb;prepared boolean=false;begin
 perform paws.live_cleanup();
 if p_message is null or p_message<=0 or p_update is null or p_update<0 then
  return '{"accepted":false,"reason":"duplicate"}'::jsonb;end if;
 if p_period is null or p_period<=0 then return '{"accepted":false,"reason":"not_live"}'::jsonb;end if;
 select * into w from paws.walks where owner_id=p_user and active order by started_at desc,id limit 1 for update;
 if found then
  select * into l from paws.live_walks where walk_id=w.id;
  if not found then return '{"accepted":false,"reason":"foreground_active"}'::jsonb;end if;
  -- Не привязываем к новой подготовленной прогулке старую трансляцию.
  if l.message_id is null and (p_sent_at is null or p_sent_at<extract(epoch from w.started_at)-5) then
   return '{"accepted":false,"reason":"old"}'::jsonb;end if;
 else
  if exists(select 1 from paws.live_walks where owner_id=p_user and message_id=p_message) then
   return '{"accepted":false,"reason":"closed"}'::jsonb;end if;
  if p_initial is distinct from true then return '{"accepted":false,"reason":"no_walk"}'::jsonb;end if;
  if p_sent_at is null or not(p_sent_at between extract(epoch from clock_timestamp())-30 and extract(epoch from clock_timestamp())+30)
   or p_timestamp is distinct from p_sent_at then return '{"accepted":false,"reason":"old"}'::jsonb;end if;
  if not exists(select 1 from paws.pets where owner_id=p_user) then
   return '{"accepted":false,"reason":"profile"}'::jsonb;end if;
  created=public.paws_start(p_user);
  update paws.walks set started_at=to_timestamp(p_sent_at) where id=(created->>'id')::uuid;
  insert into paws.live_walks(walk_id,owner_id)values((created->>'id')::uuid,p_user);
  prepared=true;
 end if;
 return public.paws_live_point(p_user,p_message,p_update,p_timestamp,p_longitude,p_latitude,p_accuracy,p_period)
  ||jsonb_build_object('prepared',prepared);
end $$;
revoke all on function public.paws_live_receive(bigint,bigint,bigint,double precision,double precision,double precision,double precision,double precision,integer,boolean) from public,anon,authenticated;
grant execute on function public.paws_live_receive(bigint,bigint,bigint,double precision,double precision,double precision,double precision,double precision,integer,boolean) to service_role;

-- Чек покупки сохраняется отдельно от территории: участок могут перезахватить,
-- но повтор сетевого запроса всё равно должен вернуть чек без нового списания.
create table if not exists paws.purchases(
 owner_id bigint not null references paws.pets(owner_id), request_id uuid not null,
 result jsonb not null, created_at timestamptz not null default clock_timestamp(),
 primary key(owner_id,request_id));
alter table paws.purchases enable row level security;
revoke all on paws.purchases from public,anon,authenticated;

do $purchase$ declare ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
create or replace function paws.purchase_shape(p_vertices jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare sample jsonb;lon float8;lat float8;current_point geometry;vertices geometry[]='{}';polygon geometry;area_m2 float8;begin
 if p_vertices is null or jsonb_typeof(p_vertices)<>'array' or jsonb_array_length(p_vertices) not between 3 and 100 then
  raise exception 'Отметьте от 3 до 100 точек участка.';end if;
 for sample in select value from jsonb_array_elements(p_vertices) loop
  if jsonb_typeof(sample->'longitude') is distinct from 'number' or jsonb_typeof(sample->'latitude') is distinct from 'number' then
   raise exception 'Некорректные точки участка.';end if;
  lon=(sample->>'longitude')::float8;lat=(sample->>'latitude')::float8;
  if not(lon between -180 and 180 and lat between -85 and 85) then raise exception 'Некорректные координаты участка.';end if;
  current_point=ST_SetSRID(ST_MakePoint(lon,lat),4326);
  if cardinality(vertices)>0 and (abs(lon-ST_X(vertices[1]))>180 or ST_Distance(current_point::geography,vertices[1]::geography)>10000) then
   raise exception 'Участок должен находиться в радиусе 10 км от первой точки.';end if;
  vertices=array_append(vertices,current_point);
 end loop;
 if not ST_Equals(vertices[1],vertices[cardinality(vertices)]) then vertices=array_append(vertices,vertices[1]);end if;
 if cardinality(vertices)<4 then raise exception 'Отметьте минимум 3 разные точки.';end if;
 polygon=ST_MakePolygon(ST_MakeLine(vertices));
 if not ST_IsValid(polygon) then raise exception 'Границы покупки пересекаются. Переместите точки.';end if;
 area_m2=ST_Area(polygon::geography);
 if not(area_m2 between 25 and 10000000) then raise exception 'Площадь покупки должна быть от 25 м² до 10 км².';end if;
 return jsonb_build_object('geometry',ST_AsGeoJSON(polygon,15)::jsonb,'area',area_m2);
end $$;

create or replace function public.paws_purchase_quote(p_user bigint,p_vertices jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare shape jsonb;polygon geometry;cost numeric;wallet jsonb;begin
 if not exists(select 1 from paws.pets where owner_id=p_user) then raise exception 'Сначала создайте досье питомца.';end if;
 shape=paws.purchase_shape(p_vertices);polygon=ST_GeomFromGeoJSON(shape->>'geometry');
 -- Общая граница разрешена. Пересечение внутренних площадей запрещено даже
 -- с собственным участком: оплачивается только полностью свободная земля.
 if exists(select 1 from paws.territories where geom && polygon and ST_Relate(geom,polygon,'T********')) then
  raise exception 'Покупать можно только свободную территорию. Участок пересекает занятую площадь.';end if;
 cost=ceil((shape->>'area')::numeric*10);wallet=paws.public_wallet(p_user);
 return jsonb_build_object('area',shape->'area','cost',cost,'price',10,'balance',wallet->'balance',
 'affordable',(wallet->>'balance')::numeric>=cost);
end $$;

create or replace function public.paws_purchase(p_user bigint,p_request uuid,p_vertices jsonb,p_max_cost numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare receipt jsonb;quote jsonb;wallet jsonb;shape jsonb;cost numeric;new_id uuid;begin
 perform pg_advisory_xact_lock(413,1);
 if p_request is null then raise exception 'Нет номера покупки. Повторите расчёт.';end if;
 select result into receipt from paws.purchases where owner_id=p_user and request_id=p_request;
 if found then return receipt;end if;
 quote=public.paws_purchase_quote(p_user,p_vertices);cost=(quote->>'cost')::numeric;
 if p_max_cost is null or p_max_cost<cost then raise exception 'Стоимость изменилась. Повторите расчёт перед покупкой.';end if;
 wallet=paws.settle(p_user);
 if (wallet->>'balance')::numeric<cost then raise exception 'Недостаточно косточек для покупки.';end if;
 update paws.wallets set balance=balance-cost where owner_id=p_user;
 shape=paws.purchase_shape(p_vertices);
 insert into paws.territories(owner_id,geom,area) values(p_user,ST_Multi(ST_GeomFromGeoJSON(shape->>'geometry')),(shape->>'area')::float8) returning id into new_id;
 receipt=jsonb_build_object('id',new_id,'area',shape->'area','cost',cost,'requestId',p_request);
 insert into paws.purchases(owner_id,request_id,result) values(p_user,p_request,receipt);
 return receipt;
end $$;
$definition$,'__POSTGIS_SCHEMA__',quote_ident(ns));
end $purchase$;

create or replace function public.paws_top_area(p_user bigint) returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select jsonb_build_object('agents',coalesce(jsonb_agg(jsonb_build_object('pet',paws.pet_json(owner_id),
 'area',area,'wallet',paws.public_wallet(owner_id)) order by area desc,owner_id),'[]'::jsonb))
 from(select p.owner_id,coalesce(sum(t.area),0) area from paws.pets p left join paws.territories t on t.owner_id=p.owner_id
 group by p.owner_id order by area desc,p.owner_id limit 10) ranked;
$$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname in('paws_purchase_quote','paws_purchase','paws_top_area'))
 or(n.nspname='paws' and p.proname='purchase_shape')loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
