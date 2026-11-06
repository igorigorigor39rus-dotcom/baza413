-- ЕДИНЫЙ переход с v0.2–v.0.8 на v.0.9 после базовой миграции.
-- Повторное применение сохраняет данные и баланс. Включает основу досье v0.3.
-- Применяется ПОСЛЕ 202611050001_paws.sql. Не начисляет награды задним числом.
begin;
-- Согласуем начало начислений с уже работающими захватами.
select pg_advisory_xact_lock(413,1);
alter table paws.pets add column if not exists hue integer check(hue between 0 and 359);
alter table paws.pets add column if not exists saturation integer not null default 55 check(saturation between 20 and 100);
alter table paws.pets add column if not exists opacity numeric not null default .35 check(opacity between .15 and .8);
alter table paws.pets add column if not exists pattern text not null default 'solid' check(pattern in('solid','stripes','grid','camo','digital','tiger','flecktarn'));
-- Меняем только проверку колонки pattern; старые значения сохраняются.
do $$ declare c record;begin
 for c in select conname from pg_constraint where conrelid='paws.pets'::regclass and contype='c'
 and conkey=array[(select attnum from pg_attribute where attrelid='paws.pets'::regclass and attname='pattern')]::smallint[] loop
 execute format('alter table paws.pets drop constraint %I',c.conname);
 end loop;
end $$;
alter table paws.pets add constraint paws_pets_pattern_v09_check check(pattern in('solid','stripes','grid','camo','digital','tiger','flecktarn'));
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
 or p_opacity is null or p_opacity not between .15 and .8 or p_pattern is null or p_pattern not in('solid','stripes','grid','camo','digital','tiger','flecktarn') then
 raise exception 'Проверьте оттенок и рисунок заливки.'; end if;
 perform public.paws_save_pet(p_user,p_name,p_age,p_description,p_color);
 update paws.pets set hue=p_hue,saturation=p_saturation,opacity=p_opacity,pattern=p_pattern where owner_id=p_user;
 return public.paws_me(p_user);
end $$;

-- Перед каждым изменением площади фиксируем доход за предыдущий интервал.
-- Часы браузера и присутствие пользователя в приложении на начисление не влияют.
create or replace function paws.settle(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.wallets; sqm numeric; checkpoint timestamptz;debt numeric;available numeric;repaid numeric; begin
 perform pg_advisory_xact_lock(413,1);
 insert into paws.wallets(owner_id) values(p_user) on conflict do nothing;
 select * into w from paws.wallets where owner_id=p_user for update;
 checkpoint=clock_timestamp();
 select coalesce(sum(area),0)::numeric into sqm from paws.territories where owner_id=p_user;
 available=w.balance+sqm*greatest(extract(epoch from checkpoint-w.checked_at),0)/3600;
 select amount into debt from paws.star_debts where owner_id=p_user;debt=coalesce(debt,0);repaid=least(available,debt);
 if repaid>0 then update paws.star_debts set amount=amount-repaid where owner_id=p_user;end if;
 update paws.wallets set balance=available-repaid,checked_at=checkpoint where owner_id=p_user returning * into w;
 return jsonb_build_object('balance',w.balance,'rate',sqm,'asOf',extract(epoch from checkpoint),'debt',debt-repaid);
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
 return jsonb_build_object('balance',greatest(w.balance+sqm*greatest(extract(epoch from checkpoint-w.checked_at),0)/3600-coalesce((select amount from paws.star_debts where owner_id=p_user),0),0),
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

-- Полный финансовый журнал Stars хранится отдельно от подписей k/кк.
create table if not exists paws.star_packages(
 id uuid primary key,stars integer not null check(stars>0),bones numeric not null check(bones>0),active boolean not null default true);
insert into paws.star_packages(id,stars,bones) values
 ('00000000-0000-0000-0000-000000000100',100,10000),
 ('00000000-0000-0000-0000-000000000250',250,30000),
 ('00000000-0000-0000-0000-000000000500',500,80000),
 ('00000000-0000-0000-0000-000000001000',1000,200000) on conflict(id) do nothing;
create table if not exists paws.star_orders(
 id uuid primary key default gen_random_uuid(),owner_id bigint not null references paws.pets(owner_id),
 package_id uuid not null references paws.star_packages(id),stars integer not null,bones numeric not null,
 request_key text not null,checkout_id text,created_at timestamptz not null default clock_timestamp(),
 expires_at timestamptz not null default clock_timestamp()+interval '20 minutes',paid_at timestamptz,
 unique(owner_id,request_key));
create table if not exists paws.star_payments(
 charge_id text primary key,order_id uuid not null references paws.star_orders(id),owner_id bigint not null references paws.pets(owner_id),
 stars integer not null,bones numeric not null,refunded boolean not null default false,created_at timestamptz not null default clock_timestamp());
create table if not exists paws.star_refunds(charge_id text primary key,order_id uuid not null references paws.star_orders(id),owner_id bigint not null references paws.pets(owner_id),created_at timestamptz not null default clock_timestamp());
create table if not exists paws.star_debts(owner_id bigint primary key references paws.pets(owner_id),amount numeric not null default 0 check(amount>=0));
create table if not exists paws.payment_issues(charge_id text primary key,owner_id bigint not null,payload text not null,reason text not null,refunded boolean not null default false,created_at timestamptz not null default clock_timestamp());
create table if not exists paws.payment_support(id uuid primary key default gen_random_uuid(),owner_id bigint not null references paws.pets(owner_id),message text not null,created_at timestamptz not null default clock_timestamp(),resolved boolean not null default false);

create table if not exists paws.activity(
 owner_id bigint primary key references paws.pets(owner_id),last_seen timestamptz not null default clock_timestamp(),
 timezone text,reminders_enabled boolean not null default true);
insert into paws.activity(owner_id) select owner_id from paws.pets on conflict do nothing;
create table if not exists paws.reminder_messages(
 id uuid primary key default gen_random_uuid(),owner_id bigint not null references paws.pets(owner_id),
 local_date date not null,slot smallint not null check(slot in(8,18)),message text not null,
 created_at timestamptz not null default clock_timestamp(),sent_at timestamptz,
 retry_at timestamptz not null default clock_timestamp(),lease_token uuid,lease_until timestamptz,attempts integer not null default 0,
 unique(owner_id,local_date,slot));
do $$ declare t text;begin
 foreach t in array array['star_packages','star_orders','star_payments','star_refunds','star_debts','payment_issues','payment_support','activity','reminder_messages']loop
 execute format('alter table paws.%I enable row level security',t);
 execute format('revoke all on paws.%I from public,anon,authenticated',t);
 end loop;
end $$;
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
   if first_point is null then first_point=current_point;first_ts=ts; end if;
   if abs(lon-ST_X(first_point))>180 then raise exception 'Переход через линию смены дат пока не поддерживается.'; end if;
   if ST_Distance(first_point::geography,current_point::geography)>10000 then raise exception 'Маршрут должен оставаться в радиусе 10 км от старта.'; end if;
   if previous_point is not null then
     if ts<=previous_ts or ts-previous_ts>45 then raise exception 'В записи есть перерыв GPS больше 45 секунд или нарушен порядок точек.'; end if;
     segment_m=ST_Distance(previous_point::geography,current_point::geography);
     distance_m=distance_m+segment_m;
     if segment_m>20*(ts-previous_ts)+30 then raise exception 'Слишком большой скачок GPS. Начните новую прогулку.';end if;
   end if;
   if previous_point is null or not ST_Equals(previous_point,current_point) then vertices=array_append(vertices,current_point); end if;
   previous_point=current_point; previous_ts=ts;
 end loop;
 if server_now-previous_ts>15 then raise exception 'Нет свежего GPS. Дождитесь точного местоположения.'; end if;
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
-- Метаданные трансляции позволяют подсказать, что она выключена, не удаляя трек.
alter table paws.live_walks add column if not exists broadcast_stopped boolean not null default false;
alter table paws.live_walks add column if not exists broadcast_until timestamptz;
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
 if p_period is null or p_period<=0 then
  if l.message_id=p_message then update paws.live_walks set broadcast_stopped=true,last_update=p_update where walk_id=w.id;end if;
  return '{"accepted":false,"reason":"not_live"}'::jsonb;end if;
 if p_timestamp is null or not(p_timestamp between extract(epoch from w.started_at)-5 and extract(epoch from clock_timestamp())+30) then return '{"accepted":false,"reason":"old"}'::jsonb;end if;
 update paws.live_walks set message_id=p_message,last_update=p_update,broadcast_stopped=false,broadcast_until=w.started_at+p_period*interval '1 second' where walk_id=w.id;
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
 if not found then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
 select * into l from paws.live_walks where walk_id=w.id;
 if not found then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
 if w.result is not null then return w.result;end if;
 if not w.active or l.message_id is null or l.broadcast_stopped or l.broadcast_until<=clock_timestamp() then raise exception 'Включите трансляцию: 📎 → Геопозиция → Транслировать геопозицию. Затем пройдите маршрут и нажмите «Захватить».';end if;
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
 select '{"dossier":true,"chat":true,"wallet":true,"publicWallet":true,"photoLimit":1000000,"leaderboard":true,"liveTracking":true,"autoLiveStart":true,"crossingRoutes":true,"maxAccuracy":20,"closureMeters":20,"purchases":true,"purchasePrice":10,"territoryLeaderboard":true,"unlimitedPurchases":true,"mergeOwnPurchases":true,"foreignBuyouts":true,"notifications":true,"speedLimit":true,"maxSpeedKmh":20,"reminders":true,"starShop":true,"largestTerritory":true,"dailyIncome":true,"geoChat":true,"captureHelp":true,"liveOnly":true,"extraCamouflage":true,"incomePeriodSeconds":86400,"sqmPerBone":10}'::jsonb;
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
declare w paws.walks;l paws.live_walks;created jsonb;received jsonb;prepared boolean=false;needs_start boolean=false;begin
 perform paws.live_cleanup();
 if p_message is null or p_message<=0 or p_update is null or p_update<0 then return '{"accepted":false,"reason":"duplicate"}'::jsonb;end if;
 if p_period is null or p_period<=0 then
  update paws.live_walks tracked set broadcast_stopped=true,last_update=p_update from paws.walks session_walk
  where session_walk.id=tracked.walk_id and session_walk.owner_id=p_user and session_walk.active and tracked.message_id=p_message and p_update>tracked.last_update;
  return '{"accepted":false,"reason":"not_live"}'::jsonb;
 end if;
 select * into w from paws.walks where owner_id=p_user and active order by started_at desc,id limit 1 for update;
 if found then
  select * into l from paws.live_walks where walk_id=w.id;
  if not found then
   -- Новая трансляция заменяет оставшуюся с прежней версии браузерную сессию.
   if p_initial is distinct from true then return '{"accepted":false,"reason":"foreground_active"}'::jsonb;end if;
   needs_start=true;
  elsif p_initial is true and l.message_id is not null and l.message_id<>p_message
   and(l.broadcast_stopped or l.broadcast_until<=clock_timestamp()) then needs_start=true;
  elsif l.message_id is null and(p_sent_at is null or p_sent_at<extract(epoch from w.started_at)-5) then
   return '{"accepted":false,"reason":"old"}'::jsonb;
  end if;
 else needs_start=true;
 end if;
 if needs_start then
  if exists(select 1 from paws.live_walks where owner_id=p_user and message_id=p_message) then return '{"accepted":false,"reason":"closed"}'::jsonb;end if;
  if p_initial is distinct from true then return '{"accepted":false,"reason":"no_walk"}'::jsonb;end if;
  if p_sent_at is null or not(p_sent_at between extract(epoch from clock_timestamp())-30 and extract(epoch from clock_timestamp())+30)
   or p_timestamp is distinct from p_sent_at then return '{"accepted":false,"reason":"old"}'::jsonb;end if;
  if not exists(select 1 from paws.pets where owner_id=p_user) then return '{"accepted":false,"reason":"profile"}'::jsonb;end if;
  created=public.paws_start(p_user);
  update paws.walks set started_at=to_timestamp(p_sent_at) where id=(created->>'id')::uuid;
  insert into paws.live_walks(walk_id,owner_id)values((created->>'id')::uuid,p_user);prepared=true;
 end if;
 received=public.paws_live_point(p_user,p_message,p_update,p_timestamp,p_longitude,p_latitude,p_accuracy,p_period);
 if received->>'accepted'='true' or received->>'reason' in('accuracy','coordinates','invalid','gap') then
  update paws.live_walks set broadcast_until=to_timestamp(p_sent_at+p_period)
  where owner_id=p_user and message_id=p_message and last_update=p_update;
 end if;
 return received||jsonb_build_object('prepared',prepared);
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

-- Начисление репараций и создание уведомления входят в транзакцию покупки.
-- Доставка Telegram идёт после COMMIT: сбой сети не отменяет выплаченное.
create table if not exists paws.notifications(
 id uuid primary key default gen_random_uuid(),recipient_id bigint not null references paws.pets(owner_id),
 buyer_id bigint not null references paws.pets(owner_id),request_id uuid not null,amount numeric not null check(amount>0),
 message text not null,created_at timestamptz not null default clock_timestamp(),read_at timestamptz,
 telegram_sent_at timestamptz,retry_at timestamptz not null default clock_timestamp(),
 lease_token uuid,lease_until timestamptz,attempts integer not null default 0,
 unique(buyer_id,request_id,recipient_id));
alter table paws.notifications enable row level security;
revoke all on paws.notifications from public,anon,authenticated;
create index if not exists paws_notifications_recipient on paws.notifications(recipient_id,created_at desc);
create index if not exists paws_notifications_pending on paws.notifications(retry_at) where telegram_sent_at is null;

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
  vertices=array_append(vertices,current_point);
 end loop;
 if not ST_Equals(vertices[1],vertices[cardinality(vertices)]) then vertices=array_append(vertices,vertices[1]);end if;
 if cardinality(vertices)<4 then raise exception 'Отметьте минимум 3 разные точки.';end if;
 polygon=ST_MakePolygon(ST_MakeLine(vertices));
 if not ST_IsValid(polygon) then raise exception 'Границы покупки пересекаются. Переместите точки.';end if;
 area_m2=ST_Area(polygon::geography);
 -- Покупка не имеет минимальной/максимальной площади или радиуса.
 -- Нулевая площадь не образует участок. Правила GPS-захвата выше сохраняются.
 if not(area_m2>0) then raise exception 'Отметьте участок с положительной площадью.';end if;
 return jsonb_build_object('geometry',ST_AsGeoJSON(polygon,15)::jsonb,'area',area_m2);
end $$;

-- План покупки учитывает свои участки: оплачивается только новая площадь,
-- а все связанные собственные территории объединяются в одну геометрию.
create or replace function paws.purchase_plan(p_user bigint,p_vertices jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare shape jsonb;polygon geometry;combined geometry;owned geometry;new_land geometry;
 ids uuid[]='{}';added uuid[];area_m2 float8;foreign_ids uuid[];foreign_land geometry;neutral_land geometry;
 foreign_areas jsonb;foreign_sqm float8;neutral_sqm float8;begin
 if not exists(select 1 from paws.pets where owner_id=p_user) then raise exception 'Сначала создайте досье питомца.';end if;
 shape=paws.purchase_shape(p_vertices);polygon=ST_GeomFromGeoJSON(shape->>'geometry');
 combined=polygon;
 loop
  select coalesce(array_agg(id),'{}'::uuid[]) into added from paws.territories
  where owner_id=p_user and not(id=any(ids)) and geom && combined and ST_Intersects(geom,combined);
  exit when cardinality(added)=0;
  ids=ids||added;
  select ST_UnaryUnion(ST_Collect(geom)) into owned from paws.territories where id=any(added);
  combined=ST_UnaryUnion(ST_Collect(combined,owned));
 end loop;
 select ST_UnaryUnion(ST_Collect(geom)) into owned from paws.territories where id=any(ids);
 new_land=case when owned is null then polygon else ST_Difference(polygon,owned) end;
 area_m2=ST_Area(new_land::geography);
 if not(area_m2>0) then raise exception 'Выбранная земля уже принадлежит вам. Добавьте нейтральную или чужую землю.';end if;
 -- Цена охватывает нейтральную и чужую землю, но не собственную.
 select coalesce(array_agg(id),'{}'::uuid[]),ST_UnaryUnion(ST_Collect(ST_Intersection(geom,new_land)))
 into foreign_ids,foreign_land from paws.territories
 where owner_id<>p_user and geom && new_land and ST_Relate(geom,new_land,'T********');
 select coalesce(jsonb_agg(jsonb_build_object('ownerId',owner_id::text,'area',sqm) order by owner_id),'[]'::jsonb),coalesce(sum(sqm),0)
 into foreign_areas,foreign_sqm from(
  select owner_id,ST_Area(ST_UnaryUnion(ST_Collect(ST_Intersection(geom,new_land)))::geography) sqm
  from paws.territories where id=any(foreign_ids) group by owner_id) owners;
 neutral_land=case when foreign_land is null then new_land else ST_Difference(new_land,foreign_land) end;
 neutral_sqm=ST_Area(neutral_land::geography);
 return jsonb_build_object('geometry',ST_AsGeoJSON(combined,15)::jsonb,'purchaseGeometry',ST_AsGeoJSON(polygon,15)::jsonb,
 'area',area_m2,'selectedArea',shape->'area','totalArea',ST_Area(combined::geography),'mergeIds',to_jsonb(ids),'merged',cardinality(ids)>0,
 'foreignIds',to_jsonb(foreign_ids),'foreignOwners',foreign_areas,'foreignArea',foreign_sqm,'neutralArea',neutral_sqm,
 'pricedArea',(select coalesce(sum((v->>'area')::numeric),0) from jsonb_array_elements(foreign_areas) v)+neutral_sqm::numeric);
end $$;

create or replace function public.paws_purchase_quote(p_user bigint,p_vertices jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare plan jsonb;cost numeric;wallet jsonb;begin
 plan=paws.purchase_plan(p_user,p_vertices);cost=ceil((plan->>'area')::numeric*10);wallet=paws.public_wallet(p_user);
 return jsonb_build_object('area',plan->'area','selectedArea',plan->'selectedArea','totalArea',plan->'totalArea',
 'merged',plan->'merged','cost',cost,'price',10,'balance',wallet->'balance','foreignArea',plan->'foreignArea',
 'ownersCount',jsonb_array_length(plan->'foreignOwners'),'affordable',(wallet->>'balance')::numeric>=cost);
end $$;

create or replace function public.paws_purchase(p_user bigint,p_request uuid,p_vertices jsonb,p_max_cost numeric) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare receipt jsonb;plan jsonb;wallet jsonb;cost numeric;new_id uuid;owner jsonb;compensation numeric;
 buyer_name text;reparations jsonb='[]';polygon geometry;remaining geometry;old record;begin
 perform pg_advisory_xact_lock(413,1);
 if p_request is null then raise exception 'Нет номера покупки. Повторите расчёт.';end if;
 select result into receipt from paws.purchases where owner_id=p_user and request_id=p_request;
 if found then return receipt;end if;
 plan=paws.purchase_plan(p_user,p_vertices);cost=ceil((plan->>'area')::numeric*10);
 if p_max_cost is null or p_max_cost<cost then raise exception 'Стоимость изменилась. Повторите расчёт перед покупкой.';end if;
 wallet=paws.settle(p_user);
 if (wallet->>'balance')::numeric<cost then raise exception 'Недостаточно косточек для покупки.';end if;
 update paws.wallets set balance=balance-cost where owner_id=p_user;
 -- Фиксируем заработанный доход продавца до изменения площади и добавляем
 -- 1/10 его доли стоимости покупки. Нейтральная земля репараций не даёт.
 select name into buyer_name from paws.pets where owner_id=p_user;
 for owner in select value from jsonb_array_elements(plan->'foreignOwners') loop
  compensation=cost*(owner->>'area')::numeric/(plan->>'pricedArea')::numeric/10;
  perform paws.settle((owner->>'ownerId')::bigint);
  update paws.wallets set balance=balance+compensation where owner_id=(owner->>'ownerId')::bigint;
  insert into paws.notifications(recipient_id,buyer_id,request_id,amount,message)
  values((owner->>'ownerId')::bigint,p_user,p_request,compensation,
   buyer_name||' выкупил вашу территорию, вам выплачены репарации в количестве '||trim_scale(compensation)::text||' 🦴.');
  reparations=reparations||jsonb_build_array(jsonb_build_object('ownerId',owner->>'ownerId','amount',compensation,'area',owner->'area'));
 end loop;
 polygon=ST_GeomFromGeoJSON(plan->>'purchaseGeometry');
 for old in select * from paws.territories where id in(select value::uuid from jsonb_array_elements_text(plan->'foreignIds')) for update loop
  remaining=ST_Multi(ST_CollectionExtract(ST_Difference(old.geom,polygon),3));
  if ST_IsEmpty(remaining) or ST_Area(remaining::geography)<=0 then delete from paws.territories where id=old.id;
  else update paws.territories set geom=remaining,area=ST_Area(remaining::geography) where id=old.id;end if;
 end loop;
 delete from paws.territories where owner_id=p_user and id in(select value::uuid from jsonb_array_elements_text(plan->'mergeIds'));
 insert into paws.territories(owner_id,geom,area) values(p_user,ST_Multi(ST_GeomFromGeoJSON(plan->>'geometry')),(plan->>'totalArea')::float8) returning id into new_id;
 receipt=jsonb_build_object('id',new_id,'area',plan->'area','totalArea',plan->'totalArea','merged',plan->'merged','cost',cost,'requestId',p_request,'reparations',reparations);
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
 or(n.nspname='paws' and p.proname in('purchase_shape','purchase_plan'))loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';

-- История получателя доступна только через Edge Function с проверенным user ID.
create or replace function public.paws_notifications(p_user bigint) returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select jsonb_build_object('unread',(select count(*) from paws.notifications where recipient_id=p_user and read_at is null),
 'notifications',coalesce((select jsonb_agg(jsonb_build_object('id',id,'message',message,'amount',amount::text,
 'createdAt',extract(epoch from created_at),'read',read_at is not null) order by (read_at is null) desc,created_at desc,id)
 from(select * from paws.notifications where recipient_id=p_user order by (read_at is null) desc,created_at desc,id limit 50) recent),'[]'::jsonb));
$$;
create or replace function public.paws_notifications_read(p_user bigint,p_ids jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 update paws.notifications set read_at=coalesce(read_at,clock_timestamp()) where recipient_id=p_user
 and id in(select value::uuid from jsonb_array_elements_text(p_ids));
 return '{"ok":true}'::jsonb;
end $$;

-- Аренда сообщения защищает от параллельной отправки несколькими запросами.
-- Неотправленное хранится до следующей попытки; сумма уже выплачена в покупке.
create or replace function public.paws_notify_claim(p_buyer bigint default null,p_request uuid default null,p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare result jsonb;begin
 with candidates as(select id from paws.notifications where telegram_sent_at is null and retry_at<=clock_timestamp()
  and (lease_until is null or lease_until<clock_timestamp()) and (p_buyer is null or buyer_id=p_buyer)
  and (p_request is null or request_id=p_request) order by created_at,id for update skip locked limit least(greatest(p_limit,1),20)),
 claimed as(update paws.notifications n set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '60 seconds',attempts=attempts+1
  from candidates c where n.id=c.id returning n.*)
 select jsonb_build_object('messages',coalesce(jsonb_agg(jsonb_build_object('id',id,'recipientId',recipient_id::text,
 'message',message,'leaseToken',lease_token)),'[]'::jsonb)) into result from claimed;
 return result;
end $$;
create or replace function public.paws_notify_finish(p_id uuid,p_token uuid,p_ok boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 update paws.notifications set telegram_sent_at=case when p_ok then clock_timestamp() else null end,
 retry_at=clock_timestamp()+least(attempts,60)*interval '60 seconds',lease_token=null,lease_until=null
 where id=p_id and lease_token=p_token and telegram_sent_at is null;
 return '{"ok":true}'::jsonb;
end $$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in('paws_notifications','paws_notifications_read','paws_notify_claim','paws_notify_finish') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';

-- Утверждённая цена фиксируется в заказе: клиент не может подменить пакет.
create or replace function public.paws_star_catalog(p_user bigint) returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select jsonb_build_object('packages',coalesce((select jsonb_agg(jsonb_build_object('id',id,'stars',stars,'bones',bones) order by stars) from paws.star_packages where active),'[]'::jsonb),
 'debt',coalesce((select amount from paws.star_debts where owner_id=p_user),0));
$$;
create or replace function public.paws_star_order(p_user bigint,p_package uuid,p_request text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare o paws.star_orders;p paws.star_packages;begin
 perform pg_advisory_xact_lock(413,1);
 if not exists(select 1 from paws.pets where owner_id=p_user) then raise exception 'Сначала создайте досье питомца.';end if;
 if p_request is null or length(p_request) not between 1 and 200 then raise exception 'Некорректный номер заказа.';end if;
 select * into o from paws.star_orders where owner_id=p_user and request_key=p_request;
 if not found then
  select * into p from paws.star_packages where id=p_package and active;
  if not found then raise exception 'Пакет недоступен.';end if;
  insert into paws.star_orders(owner_id,package_id,stars,bones,request_key) values(p_user,p.id,p.stars,p.bones,p_request) returning * into o;
 end if;
 if o.package_id<>p_package or o.paid_at is not null or o.expires_at<clock_timestamp() then raise exception 'Создайте новый счёт.';end if;
 return jsonb_build_object('id',o.id,'stars',o.stars,'bones',o.bones);
end $$;
create or replace function public.paws_star_checkout(p_user bigint,p_order uuid,p_currency text,p_amount integer,p_query text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare o paws.star_orders;begin
 perform pg_advisory_xact_lock(413,1);select * into o from paws.star_orders where id=p_order for update;
 if not found or o.owner_id<>p_user or p_currency is distinct from 'XTR' or o.stars is distinct from p_amount
 or p_query is null or length(p_query) not between 1 and 256 or o.expires_at<clock_timestamp() or o.paid_at is not null
 or(o.checkout_id is not null and o.checkout_id<>p_query) then raise exception 'Счёт недоступен. Откройте магазин и создайте новый счёт.';end if;
 update paws.star_orders set checkout_id=p_query where id=o.id;return '{"ok":true}'::jsonb;
end $$;
create or replace function public.paws_star_paid(p_user bigint,p_order uuid,p_currency text,p_amount integer,p_charge text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare o paws.star_orders;paid paws.star_payments;was_refunded boolean;wallet jsonb;begin
 perform pg_advisory_xact_lock(413,1);select * into o from paws.star_orders where id=p_order for update;
 if not found or o.owner_id<>p_user or p_currency is distinct from 'XTR' or o.stars is distinct from p_amount
 or o.checkout_id is null or p_charge is null or length(p_charge) not between 1 and 512 then raise exception 'Платёж не соответствует счёту.';end if;
 select * into paid from paws.star_payments where charge_id=p_charge;
 if found then
  if paid.owner_id<>p_user or paid.order_id<>p_order then raise exception 'Платёж уже относится к другому заказу.';end if;
  return jsonb_build_object('credited',false,'bones',paid.bones,'refunded',paid.refunded);
 end if;
 if exists(select 1 from paws.star_refunds where charge_id=p_charge and(owner_id<>p_user or order_id<>p_order)) then raise exception 'Возврат относится к другому заказу.';end if;
 was_refunded=exists(select 1 from paws.star_refunds where charge_id=p_charge);
 insert into paws.star_payments(charge_id,order_id,owner_id,stars,bones,refunded) values(p_charge,o.id,p_user,o.stars,o.bones,was_refunded);
 update paws.star_orders set paid_at=coalesce(paid_at,clock_timestamp()) where id=o.id;
 if not was_refunded then
  perform paws.settle(p_user);update paws.wallets set balance=balance+o.bones where owner_id=p_user;
  wallet=paws.settle(p_user);
 end if;
 return jsonb_build_object('credited',not was_refunded,'bones',o.bones,'refunded',was_refunded,'wallet',wallet);
end $$;
create or replace function public.paws_star_status(p_user bigint,p_order uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if not exists(select 1 from paws.star_orders where id=p_order and owner_id=p_user) then raise exception 'Заказ не найден.';end if;
 return jsonb_build_object('paid',exists(select 1 from paws.star_payments where order_id=p_order and not refunded),
 'refunded',exists(select 1 from paws.star_refunds where order_id=p_order));
end $$;
create or replace function public.paws_star_refunded(p_user bigint,p_order uuid,p_currency text,p_amount integer,p_charge text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare o paws.star_orders;p paws.star_payments;available numeric;take numeric;begin
 perform pg_advisory_xact_lock(413,1);select * into o from paws.star_orders where id=p_order for update;
 if not found or o.owner_id<>p_user or p_currency is distinct from 'XTR' or o.stars is distinct from p_amount then raise exception 'Возврат не соответствует счёту.';end if;
 if exists(select 1 from paws.star_refunds where charge_id=p_charge) then return '{"changed":false}'::jsonb;end if;
 select * into p from paws.star_payments where charge_id=p_charge;
 if found and(p.owner_id<>p_user or p.order_id<>p_order) then raise exception 'Возврат относится к другому заказу.';end if;
 insert into paws.star_refunds(charge_id,order_id,owner_id) values(p_charge,p_order,p_user);
 if p.charge_id is not null then
  perform paws.settle(p_user);select balance into available from paws.wallets where owner_id=p_user for update;
  take=least(available,p.bones);update paws.wallets set balance=balance-take where owner_id=p_user;
  if p.bones>take then insert into paws.star_debts(owner_id,amount) values(p_user,p.bones-take)
   on conflict(owner_id) do update set amount=paws.star_debts.amount+excluded.amount;end if;
  update paws.star_payments set refunded=true where charge_id=p_charge;
 end if;
 return '{"changed":true}'::jsonb;
end $$;
create or replace function public.paws_payment_issue(p_user bigint,p_charge text,p_payload text,p_reason text,p_refunded boolean default false) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 insert into paws.payment_issues(charge_id,owner_id,payload,reason,refunded) values(p_charge,p_user,p_payload,left(p_reason,1000),p_refunded)
 on conflict(charge_id) do update set refunded=paws.payment_issues.refunded or excluded.refunded;
 return jsonb_build_object('refunded',(select refunded from paws.payment_issues where charge_id=p_charge));
end $$;
create or replace function public.paws_payment_support(p_user bigint,p_message text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ declare n uuid;begin
 if not exists(select 1 from paws.pets where owner_id=p_user) or p_message is null or length(p_message) not between 1 and 1000 then raise exception 'Опишите вопрос после /paysupport, до 1000 символов.';end if;
 insert into paws.payment_support(owner_id,message) values(p_user,p_message) returning id into n;return jsonb_build_object('id',n);
end $$;

-- Активность фиксируем при реальном посещении, а не при работе cron.
create or replace function public.paws_activity(p_user bigint,p_timezone text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ declare a paws.activity;begin
 if p_timezone is not null and not exists(select 1 from pg_timezone_names where name=p_timezone) then raise exception 'Неизвестный часовой пояс.';end if;
 if not exists(select 1 from paws.pets where owner_id=p_user) then return '{"profileRequired":true}'::jsonb;end if;
 insert into paws.activity(owner_id,timezone) values(p_user,p_timezone) on conflict(owner_id) do update set last_seen=clock_timestamp(),timezone=coalesce(excluded.timezone,paws.activity.timezone);
 select * into a from paws.activity where owner_id=p_user;
 return jsonb_build_object('enabled',a.reminders_enabled,'timezone',a.timezone,'lastSeen',extract(epoch from a.last_seen));
end $$;
create or replace function public.paws_reminders_set(p_user bigint,p_enabled boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 perform public.paws_activity(p_user);
 update paws.activity set reminders_enabled=p_enabled where owner_id=p_user;
 if not found then raise exception 'Сначала создайте досье питомца.';end if;
 return jsonb_build_object('enabled',p_enabled);
end $$;
create or replace function public.paws_reminders_generate(p_now timestamptz default clock_timestamp()) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ declare count_new integer;begin
 insert into paws.reminder_messages(owner_id,local_date,slot,message,created_at,retry_at)
 select a.owner_id,(p_now at time zone a.timezone)::date,extract(hour from p_now at time zone a.timezone)::smallint,
  'Генерал, пора захватить новое и погулять со своим пёсиком! '||p.name||' ждёт прогулки 🐾',p_now,p_now
 from paws.activity a join paws.pets p on p.owner_id=a.owner_id where a.reminders_enabled and a.timezone is not null
 and a.last_seen<p_now-interval '48 hours' and extract(hour from p_now at time zone a.timezone) in(8,18)
 and extract(minute from p_now at time zone a.timezone)<15 on conflict(owner_id,local_date,slot) do nothing;
 get diagnostics count_new=row_count;return jsonb_build_object('queued',count_new);
end $$;
create or replace function public.paws_reminders_claim(p_now timestamptz default clock_timestamp(),p_limit integer default 20) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ declare result jsonb;begin
 with candidates as(select r.id from paws.reminder_messages r join paws.activity a on a.owner_id=r.owner_id
  where r.sent_at is null and r.retry_at<=p_now and(r.lease_until is null or r.lease_until<p_now)
  and a.reminders_enabled and a.timezone is not null and a.last_seen<p_now-interval '48 hours'
  and r.local_date=(p_now at time zone a.timezone)::date and r.slot=extract(hour from p_now at time zone a.timezone)
  and extract(minute from p_now at time zone a.timezone)<15
  order by r.created_at,r.id for update of r skip locked limit least(greatest(p_limit,1),20)),
 claimed as(update paws.reminder_messages r set lease_token=gen_random_uuid(),lease_until=p_now+interval '60 seconds',attempts=attempts+1
  from candidates c where r.id=c.id returning r.*)
 select jsonb_build_object('messages',coalesce(jsonb_agg(jsonb_build_object('id',id,'recipientId',owner_id::text,'message',message,'leaseToken',lease_token)),'[]'::jsonb)) into result from claimed;
 return result;
end $$;
create or replace function public.paws_reminders_finish(p_id uuid,p_token uuid,p_ok boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 update paws.reminder_messages set sent_at=case when p_ok then clock_timestamp() else null end,
 retry_at=clock_timestamp()+least(attempts,15)*interval '60 seconds',lease_token=null,lease_until=null
 where id=p_id and lease_token=p_token and sent_at is null;return '{"ok":true}'::jsonb;
end $$;

-- Публичные территории можно показать из досье даже за пределами текущей карты.
do $largest$ declare ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
 create or replace function public.paws_largest_territory(p_user bigint,p_pet bigint) returns jsonb
 language sql stable security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
 select (select jsonb_build_object('id',id,'area',area,'ownerId',owner_id::text,'geometry',ST_AsGeoJSON(geom)::jsonb)
 from paws.territories where owner_id=p_pet order by area desc,id limit 1);
 $$;
 $definition$,'__POSTGIS_SCHEMA__',quote_ident(ns));
end $largest$;
do $$ declare f record;begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and (p.proname like 'paws_star_%' or p.proname in('paws_payment_issue','paws_payment_support','paws_activity','paws_reminders_set','paws_reminders_generate','paws_reminders_claim','paws_reminders_finish','paws_largest_territory')) loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
notify pgrst,'reload schema';

-- v.0.9: 10 м² дают 1 🦴 за 86400 секунд; выплата только за полные периоды.
-- До смены правил один раз фиксируем заработанное по прежней ставке.
create table if not exists paws.economy_versions(version smallint primary key,applied_at timestamptz not null default clock_timestamp());
alter table paws.economy_versions enable row level security;
revoke all on paws.economy_versions from public,anon,authenticated;
alter table paws.wallets add column if not exists income_pending numeric not null default 0 check(income_pending>=0);
alter table paws.wallets add column if not exists income_cycle_at timestamptz;
do $$ declare u bigint;begin
 if not exists(select 1 from paws.economy_versions where version=9) then
  for u in select owner_id from paws.wallets order by owner_id loop
   perform paws.settle(u);
   update paws.wallets set income_pending=0,income_cycle_at=case when exists(select 1 from paws.territories where owner_id=u) then checked_at else null end where owner_id=u;
  end loop;
  -- Старые сессии браузерного GPS завершаем при переходе на единственный режим.
  update paws.walks set active=false where active and id not in(select walk_id from paws.live_walks);
  insert into paws.economy_versions(version) values(9);
 end if;
end $$;

-- Общий расчёт используют списание, покупка, публичное досье и рейтинг.
-- Это чистый снимок: просмотр чужого кошелька не меняет чужие данные.
create or replace function paws.daily_wallet(p_user bigint,p_at timestamptz) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
declare w paws.wallets;sqm numeric;daily_rate numeric;checkpoint timestamptz;cycle_at timestamptz;
 boundary timestamptz;complete_cycles bigint;pending numeric;earned numeric=0;debt numeric;available numeric;repaid numeric;
begin
 select * into w from paws.wallets where owner_id=p_user;
 select coalesce(sum(area),0)::numeric into sqm from paws.territories where owner_id=p_user;
 daily_rate=sqm/10;
 if w.owner_id is null then
  return jsonb_build_object('balance',0,'rate',daily_rate,'asOf',extract(epoch from p_at),'pending',0,'debt',0,'nextPayoutAt',null,'incomePeriodSeconds',86400,'sqmPerBone',10);
 end if;
 -- Не даём переводу часов сервера повторно учитывать уже оплаченный интервал.
 checkpoint=greatest(p_at,w.checked_at);pending=w.income_pending;cycle_at=w.income_cycle_at;
 if cycle_at is null and sqm>0 then cycle_at=w.checked_at;end if;
 if cycle_at is not null then
  boundary=cycle_at+interval '24 hours';
  if checkpoint<boundary then
   pending=pending+daily_rate*extract(epoch from checkpoint-w.checked_at)/86400;
  else
   -- Первая выплата включает доход, накопленный до изменения площади.
   earned=pending+daily_rate*greatest(extract(epoch from boundary-w.checked_at),0)/86400;
   complete_cycles=floor(extract(epoch from checkpoint-boundary)/86400)::bigint;
   earned=earned+daily_rate*complete_cycles;
   cycle_at=boundary+complete_cycles*interval '24 hours';
   pending=daily_rate*extract(epoch from checkpoint-cycle_at)/86400;
  end if;
 end if;
 available=w.balance+earned;
 select amount into debt from paws.star_debts where owner_id=p_user;debt=coalesce(debt,0);repaid=least(available,debt);
 return jsonb_build_object('balance',available-repaid,'rate',daily_rate,'asOf',extract(epoch from checkpoint),
 'pending',pending,'debt',debt-repaid,'nextPayoutAt',extract(epoch from cycle_at+interval '24 hours'),
 'incomePeriodSeconds',86400,'sqmPerBone',10);
end $$;
create or replace function paws.settle(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare snapshot jsonb;begin
 perform pg_advisory_xact_lock(413,1);
 insert into paws.wallets(owner_id) values(p_user) on conflict do nothing;
 perform 1 from paws.wallets where owner_id=p_user for update;
 snapshot=paws.daily_wallet(p_user,clock_timestamp());
 update paws.wallets set balance=(snapshot->>'balance')::numeric,checked_at=to_timestamp((snapshot->>'asOf')::double precision),
 income_pending=(snapshot->>'pending')::numeric,
 income_cycle_at=to_timestamp((snapshot->>'nextPayoutAt')::double precision)-interval '24 hours' where owner_id=p_user;
 update paws.star_debts set amount=(snapshot->>'debt')::numeric where owner_id=p_user;
 return snapshot;
end $$;
create or replace function paws.public_wallet(p_user bigint) returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$
 select paws.daily_wallet(p_user,statement_timestamp())-'debt'-'pending';
$$;
create or replace function public.paws_wallet(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$ begin
 if not exists(select 1 from paws.pets where owner_id=p_user) then return jsonb_build_object('balance',0,'rate',0,'pending',0,'nextPayoutAt',null,'incomePeriodSeconds',86400,'sqmPerBone',10);end if;
 return paws.settle(p_user);
end $$;
revoke all on function paws.daily_wallet(bigint,timestamptz),paws.settle(bigint),paws.public_wallet(bigint),public.paws_wallet(bigint) from public,anon,authenticated;
grant execute on function paws.daily_wallet(bigint,timestamptz),paws.settle(bigint),paws.public_wallet(bigint),public.paws_wallet(bigint) to service_role;
notify pgrst,'reload schema';



-- Три независимых канала. Прежняя общая переписка остаётся в «Мире».
alter table paws.messages add column if not exists channel text not null default 'world' check(channel in('district','city','world'));
create index if not exists paws_messages_channel_time on paws.messages(channel,id desc);
do $chat$ declare ns text;begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
 create or replace function paws.chat_anchor(p_user bigint) returns __POSTGIS_SCHEMA__.geometry
 language sql stable security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
  select ST_PointOnSurface(geom) from paws.territories where owner_id=p_user order by area desc,id limit 1;
 $$;
 create or replace function public.paws_chat_room(p_user bigint,p_channel text,p_after bigint default 0) returns jsonb
 language plpgsql stable security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
 declare anchor geometry;radius integer;total_area numeric;may_read boolean;may_post boolean;reason text;messages jsonb;
 begin
  if p_channel is null or p_channel not in('district','city','world') then raise exception 'Выберите Район, Город или Мир.';end if;
  anchor=paws.chat_anchor(p_user);radius=case p_channel when 'district' then 2000 when 'city' then 20000 else null end;
  select coalesce(sum(area),0)::numeric into total_area from paws.territories where owner_id=p_user;
  may_read=p_channel='world' or anchor is not null;
  may_post=exists(select 1 from paws.pets where owner_id=p_user) and case when p_channel='world' then total_area>=1000000 else anchor is not null end;
  reason=case when not exists(select 1 from paws.pets where owner_id=p_user) then 'Сначала создайте досье питомца.'
   when p_channel<>'world' and anchor is null then 'Для локального чата нужна своя территория. Можно читать Мир.'
   when p_channel='world' and total_area<1000000 then 'Мир читают все. Для отправки сообщений нужно владеть минимум 1 000 000 м².' else null end;
  select coalesce(jsonb_agg(jsonb_build_object('id',m.id::text,'text',m.text,'channel',m.channel,
   'createdAt',extract(epoch from m.created_at),'pet',paws.pet_json(m.owner_id)) order by m.id),'[]'::jsonb) into messages
  from(select m.* from paws.messages m where m.channel=p_channel and m.id>p_after and may_read
   and(p_channel='world' or ST_DWithin(anchor::geography,paws.chat_anchor(m.owner_id)::geography,radius))
   order by m.id desc limit 100) m;
  return jsonb_build_object('channel',p_channel,'messages',messages,'canRead',may_read,'canPost',may_post,'reason',reason,'radiusMeters',radius,'ownedArea',total_area);
 end $$;
 $definition$,'__POSTGIS_SCHEMA__',quote_ident(ns));
end $chat$;
create or replace function public.paws_send_room(p_user bigint,p_channel text,p_text text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,pg_temp as $$
declare last_at timestamptz;rights jsonb;begin
 perform pg_advisory_xact_lock(413,1);
 perform 1 from paws.pets where owner_id=p_user for update;
 if not found then raise exception 'Сначала создайте досье питомца.';end if;
 if p_text is null or length(trim(p_text)) not between 1 and 500 then raise exception 'Сообщение должно содержать от 1 до 500 символов.';end if;
 rights=public.paws_chat_room(p_user,p_channel);
 if not (rights->>'canPost')::boolean then raise exception '%',rights->>'reason';end if;
 select max(created_at) into last_at from paws.messages where owner_id=p_user;
 if last_at>clock_timestamp()-interval '3 seconds' then raise exception 'Подождите 3 секунды перед следующим сообщением.';end if;
 insert into paws.messages(owner_id,channel,text) values(p_user,p_channel,trim(p_text));return '{"ok":true}'::jsonb;
end $$;
-- Старый клиент без категории тоже обязан соблюдать порог мирового чата.
create or replace function public.paws_chat(p_user bigint,p_after bigint default 0) returns jsonb
language sql stable security definer set search_path=pg_catalog,paws,pg_temp as $$ select public.paws_chat_room(p_user,'world',p_after); $$;
create or replace function public.paws_send(p_user bigint,p_text text) returns jsonb
language sql security definer set search_path=pg_catalog,paws,pg_temp as $$ select public.paws_send_room(p_user,'world',p_text); $$;
revoke all on function paws.chat_anchor(bigint),public.paws_chat_room(bigint,text,bigint),public.paws_send_room(bigint,text,text),public.paws_chat(bigint,bigint),public.paws_send(bigint,text) from public,anon,authenticated;
grant execute on function paws.chat_anchor(bigint),public.paws_chat_room(bigint,text,bigint),public.paws_send_room(bigint,text,text),public.paws_chat(bigint,bigint),public.paws_send(bigint,text) to service_role;
notify pgrst,'reload schema';

commit;
