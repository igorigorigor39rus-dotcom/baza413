begin;
-- Индексы для истории прогулок и поиска крупнейшей территории пользователя.
create index if not exists paws_walk_recent_sync on paws.walks(owner_id,active desc,started_at desc,id);
create index if not exists paws_territory_owner_area_sync on paws.territories(owner_id,area desc,id);
create table if not exists paws.sync_revision(id boolean primary key default true check(id),revision bigint not null default 0);
insert into paws.sync_revision values(true,0) on conflict do nothing;
alter table paws.sync_revision enable row level security;
revoke all on paws.sync_revision from public,anon,authenticated;
create or replace function paws.bump_sync_revision() returns trigger language plpgsql security definer set search_path=pg_catalog,paws as $$
begin update paws.sync_revision set revision=revision+1;return null;end $$;
drop trigger if exists paws_territories_sync_revision on paws.territories;
create trigger paws_territories_sync_revision after insert or update or delete on paws.territories for each statement execute function paws.bump_sync_revision();
drop trigger if exists paws_pets_sync_revision on paws.pets;
create trigger paws_pets_sync_revision after insert or update or delete on paws.pets for each statement execute function paws.bump_sync_revision();

-- Исследовательский прототип. Браузер получает только собственный кошелёк,
-- свой маршрут и сообщения разрешённого сервером канала.
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
  if w.active and w.started_at<clock_timestamp()-interval '2 hours' then
   update paws.walks set active=false where id=w.id and active and started_at<clock_timestamp()-interval '2 hours';
   w.active=false;
  end if;
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
revoke all on function public.paws_sync(bigint,uuid,integer,text,bigint,text,text,text),paws.bump_sync_revision() from public,anon,authenticated;
grant execute on function public.paws_sync(bigint,uuid,integer,text,bigint,text,text,text) to service_role;
-- Сохраняем все существующие возможности сервера, добавляя только флаг протокола.
do $$ declare flags jsonb; begin
 flags=public.paws_capabilities() || '{"efficientSync":true}'::jsonb;
 execute format('create or replace function public.paws_capabilities() returns jsonb language sql stable security definer set search_path=pg_catalog,paws,pg_temp as %L', 'select '||quote_literal(flags::text)||'::jsonb;');
end $$;
commit;
