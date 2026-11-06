-- ЕДИНЫЙ переход с v0.2 ИЛИ v0.3 на v.0.4 после базовой 202611050001.
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
commit;
