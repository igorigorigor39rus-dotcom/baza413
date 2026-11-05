-- Общая карта. Существующие таблицы проекта не затрагиваются: свои таблицы
-- находятся в paws, наружу доступны только строго ограниченные RPC-функции.
begin;
create schema if not exists extensions;
create extension if not exists postgis with schema extensions;
create schema if not exists paws;

-- PostGIS мог быть установлен раньше в другом schema. Используем его настоящее
-- расположение; не переносим расширение и не меняем чужие настройки проекта.
do $$ declare ns text; begin
  select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
  perform set_config('search_path',format('pg_catalog,paws,%I',ns),true);
end $$;

create table if not exists paws.pets (
  owner_id bigint primary key check(owner_id>0 and owner_id<4503599627370496),
  name text not null check(length(trim(name)) between 1 and 40),
  age numeric not null check(age>=0 and age<=35),
  description text not null default '' check(length(description)<=400),
  color text not null check(color ~ '^#[0-9A-Fa-f]{6}$'),
  photo_key text
);
create table if not exists paws.walks (
  id uuid primary key default gen_random_uuid(),
  owner_id bigint not null references paws.pets(owner_id),
  started_at timestamptz not null default now(), active boolean not null default true,
  result jsonb
);
create table if not exists paws.territories (
  id uuid primary key default gen_random_uuid(),
  owner_id bigint not null references paws.pets(owner_id),
  geom geometry(MultiPolygon,4326) not null,
  area double precision not null check(area>0),
  created_at timestamptz not null default now()
);
create index if not exists paws_territory_gist on paws.territories using gist(geom);
create index if not exists paws_territory_owner on paws.territories(owner_id);
create index if not exists paws_walk_owner on paws.walks(owner_id);
alter table paws.pets enable row level security;
alter table paws.walks enable row level security;
alter table paws.territories enable row level security;
revoke all on schema paws from public,anon,authenticated;
revoke all on all tables in schema paws from public,anon,authenticated;

create or replace function paws.pet_json(p_user bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws as $$
declare p paws.pets; begin
 select * into p from paws.pets where owner_id=p_user;
 if not found then return null; end if;
 return jsonb_build_object('id',p.owner_id::text,'name',p.name,'age',p.age,
   'description',p.description,'color',p.color,'photo_key',p.photo_key);
end $$;

create or replace function public.paws_me(p_user bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws as $$ begin
 return jsonb_build_object('pet',paws.pet_json(p_user),'area',
   coalesce((select sum(area) from paws.territories where owner_id=p_user),0));
end $$;

create or replace function public.paws_save_pet(p_user bigint,p_name text,p_age numeric,p_description text,p_color text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws as $$ begin
 if p_name is null or length(trim(p_name)) not between 1 and 40 or p_age is null or not(p_age>=0 and p_age<=35)
    or p_description is null or length(p_description)>400 or p_color is null or p_color !~ '^#[0-9A-Fa-f]{6}$' then
   raise exception 'Проверьте кличку, возраст, описание и цвет питомца.';
 end if;
 insert into paws.pets(owner_id,name,age,description,color) values(p_user,trim(p_name),p_age,trim(p_description),p_color)
 on conflict(owner_id) do update set name=excluded.name,age=excluded.age,description=excluded.description,color=excluded.color;
 return public.paws_me(p_user);
end $$;

create or replace function public.paws_photo(p_user bigint,p_key text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws as $$
declare previous text; begin
 if p_key is null or p_key !~ '^[0-9]+/[0-9a-f-]{36}\.jpg$' or split_part(p_key,'/',1)<>p_user::text then
   raise exception 'Некорректный адрес фотографии.';
 end if;
 select photo_key into previous from paws.pets where owner_id=p_user for update;
 if not found then raise exception 'Сначала создайте профиль питомца.'; end if;
 update paws.pets set photo_key=p_key where owner_id=p_user;
 return jsonb_build_object('profile',public.paws_me(p_user),'previous',previous);
end $$;

create or replace function public.paws_pet(p_user bigint,p_pet bigint) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws as $$ begin
 return paws.pet_json(p_pet);
end $$;

create or replace function public.paws_map(p_user bigint,p_west double precision,p_south double precision,p_east double precision,p_north double precision) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,paws as $$
declare ids uuid[]; result jsonb; people jsonb; begin
 if p_west < -180 or p_east > 180 or p_south < -85 or p_north > 85 or p_west>p_east or p_south>p_north then
   raise exception 'Некорректная область карты.';
 end if;
 select array_agg(id) into ids from (select id from paws.territories where geom && ST_MakeEnvelope(p_west,p_south,p_east,p_north,4326) order by created_at desc,id limit 201) t;
 select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'ownerId',t.owner_id::text,'area',t.area,
   'geometry',ST_AsGeoJSON(t.geom)::jsonb,'marker',jsonb_build_array(ST_Y(ST_PointOnSurface(t.geom)),ST_X(ST_PointOnSurface(t.geom))))),'[]'::jsonb)
 into result from paws.territories t where id=any(ids[1:200]);
 select coalesce(jsonb_object_agg(p.owner_id::text,paws.pet_json(p.owner_id)),'{}'::jsonb) into people
 from paws.pets p where p.owner_id in(select t.owner_id from paws.territories t where t.id=any(ids[1:200]));
 return jsonb_build_object('territories',result,'pets',people,'truncated',coalesce(cardinality(ids)>200,false));
end $$;

create or replace function public.paws_start(p_user bigint) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws as $$
declare w paws.walks; begin
 perform pg_advisory_xact_lock(413,1);
 if not exists(select 1 from paws.pets where owner_id=p_user) then raise exception 'Сначала создайте профиль питомца.'; end if;
 update paws.walks set active=false where owner_id=p_user and active;
 delete from paws.walks where started_at<now()-interval '1 day';
 insert into paws.walks(owner_id) values(p_user) returning * into w;
 return jsonb_build_object('id',w.id,'startedAt',extract(epoch from w.started_at));
end $$;

create or replace function public.paws_cancel(p_user bigint,p_walk uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws as $$ begin
 perform pg_advisory_xact_lock(413,1);
 update paws.walks set active=false where id=p_walk and owner_id=p_user;
 return '{"ok":true}'::jsonb;
end $$;

-- PL/pgSQL проверяет типы geometry при создании. Подставляем schema PostGIS
-- через quote_ident: расширение может уже находиться в public, extensions или gis.
do $migration$ declare ns text; begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 execute replace($definition$
create or replace function public.paws_capture(p_user bigint,p_walk uuid,p_points jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,paws,__POSTGIS_SCHEMA__,pg_temp as $$
declare w paws.walks; sample jsonb; lon double precision; lat double precision; accuracy double precision;
 ts double precision; previous_ts double precision; current_point geometry; previous_point geometry; first_point geometry;
 vertices geometry[]='{}'; polygon geometry; remaining geometry; old record; area_m2 double precision; new_id uuid;
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
   if not(lon between -180 and 180 and lat between -85 and 85 and accuracy between 0 and 15) then raise exception 'Нужны корректные координаты и точность до 15 м.'; end if;
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
 if ST_Distance(first_point::geography,previous_point::geography)>5 then raise exception 'Контур открыт. Вернитесь к старту в пределах 5 м.'; end if;
 if not ST_Equals(first_point,previous_point) then vertices=array_append(vertices,first_point); end if;
 polygon=ST_MakePolygon(ST_MakeLine(vertices));
 if not ST_IsValid(polygon) or not ST_IsSimple(ST_ExteriorRing(polygon)) then raise exception 'Маршрут пересекает сам себя. Начните новую прогулку.'; end if;
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

-- Все RPC работают только через Edge Function с service_role, а не через
-- публикуемый браузерный ключ. search_path не содержит доступных для записи schema.
do $$ declare f record; ns text; begin
 select n.nspname into ns from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='postgis';
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='public' and p.proname=any(array['paws_me','paws_save_pet','paws_photo','paws_pet','paws_map','paws_start','paws_cancel','paws_capture']))
      or (n.nspname='paws' and p.proname='pet_json') loop
   execute format('alter function %s set search_path to pg_catalog,paws,%I,pg_temp',f.signature,ns);
   execute format('revoke all on function %s from public,anon,authenticated',f.signature);
   execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;

-- Публичны только готовые JPEG-аватары по непредсказуемому адресу.
-- Анонимная загрузка/удаление не разрешаются: Storage пишет только Edge Function.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('paws-photos','paws-photos',true,2097152,array['image/jpeg'])
on conflict(id) do nothing;
do $$ begin
 if exists(select 1 from storage.buckets where id='paws-photos' and not public) then
   raise exception 'Bucket paws-photos уже существует как приватный. Не меняйте его публичность автоматически: выберите отдельное имя bucket для приложения.';
 end if;
end $$;
-- Даже если в проекте раньше была широкая разрешающая Storage-политика,
-- наш bucket нельзя изменять напрямую через anon/authenticated.
-- Для остальных bucket это условие true и их правила не меняются.
drop policy if exists paws_storage_closed on storage.objects;
create policy paws_storage_closed on storage.objects as restrictive for all
to anon,authenticated using(bucket_id<>'paws-photos') with check(bucket_id<>'paws-photos');
commit;
