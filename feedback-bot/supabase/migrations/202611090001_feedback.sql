-- Отдельная схема: таблицы питомцев, косточек и игровой бот не затрагиваются.
begin;
select pg_advisory_xact_lock(414, 1);
create schema if not exists dogwars_feedback;
revoke all on schema dogwars_feedback from public, anon, authenticated;

create table if not exists dogwars_feedback.sessions (
  user_id bigint primary key,
  mode text not null
);
create table if not exists dogwars_feedback.tickets (
  id bigint generated always as identity primary key,
  user_id bigint not null,
  source_message_id bigint not null,
  display_name text not null,
  username text,
  category text not null,
  body text not null,
  attachment boolean not null default false,
  status text not null default 'open' check (status in ('open', 'working', 'closed')),
  created_at timestamptz not null default now(),
  unique (user_id, source_message_id)
);
create index if not exists feedback_tickets_user on dogwars_feedback.tickets(user_id, created_at desc);
create table if not exists dogwars_feedback.donations (
  id uuid primary key default gen_random_uuid(),
  user_id bigint not null,
  stars integer not null check (stars between 1 and 10000),
  state text not null default 'pending' check (state in ('pending', 'paid', 'refunded')),
  charge_id text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
-- Результат обработки update сохраняется: повторная доставка Telegram не создаёт обращение заново.
create table if not exists dogwars_feedback.updates (
  id bigint primary key,
  result jsonb not null,
  created_at timestamptz not null default now()
);
-- Исходящие сообщения хранятся до успешной доставки, включая ответы администраторов.
create table if not exists dogwars_feedback.outbox (
  id bigint generated always as identity primary key,
  action_key text unique not null,
  method text not null check (method in ('sendMessage', 'copyMessage', 'sendInvoice', 'refundStarPayment')),
  payload jsonb not null,
  ticket_id bigint references dogwars_feedback.tickets(id),
  role text not null default 'notice',
  message_id bigint,
  delivered boolean not null default false,
  lease uuid,
  lease_until timestamptz,
  retry_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);

-- Этот RPC доступен только Edge Function с service_role. Права администратора проверяет обработчик.
create or replace function public.feedback_apply(p_update_id bigint, p_actor bigint, p_action text, p_data jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = pg_catalog, dogwars_feedback as $$
declare
  result jsonb; mode text; t dogwars_feedback.tickets; d dogwars_feedback.donations;
  text_value text := coalesce(p_data->>'text', ''); amount integer; mapped bigint;
begin
  perform pg_advisory_xact_lock(414, 1);
  select u.result into result from dogwars_feedback.updates u where u.id = p_update_id;
  if found then return result; end if;
  if p_actor <= 0 then raise exception 'Invalid actor'; end if;
  case p_action
    when 'start' then
      delete from dogwars_feedback.sessions where user_id = p_actor;
      result := jsonb_build_object('kind', 'menu');
    when 'session' then
      if p_data->>'mode' not in ('idea', 'bug', 'question', 'donation') then raise exception 'Invalid mode'; end if;
      insert into dogwars_feedback.sessions values (p_actor, p_data->>'mode')
        on conflict (user_id) do update set mode = excluded.mode;
      result := jsonb_build_object('kind', 'prompt', 'mode', p_data->>'mode');
    when 'input' then
      select s.mode into mode from dogwars_feedback.sessions s where s.user_id = p_actor;
      if mode = 'donation' then
        if text_value !~ '^[0-9]{1,5}$' or length(text_value) > 5 then
          result := jsonb_build_object('kind', 'amount_error');
        else
          amount := text_value::integer;
          if amount not between 1 and 10000 then result := jsonb_build_object('kind', 'amount_error');
          else
            insert into dogwars_feedback.donations(user_id, stars) values (p_actor, amount) returning * into d;
            delete from dogwars_feedback.sessions where user_id = p_actor;
            result := jsonb_build_object('kind', 'invoice', 'order', to_jsonb(d));
          end if;
        end if;
      elsif length(text_value) > 3000 or (btrim(text_value) = '' and not coalesce((p_data->>'attachment')::boolean, false)) then
        result := jsonb_build_object('kind', 'text_error');
      elsif exists (select 1 from dogwars_feedback.tickets where user_id = p_actor and created_at > now() - interval '10 seconds') then
        result := jsonb_build_object('kind', 'rate_limit');
      else
        insert into dogwars_feedback.tickets(user_id, source_message_id, display_name, username, category, body, attachment)
        values (p_actor, (p_data->>'message_id')::bigint, left(coalesce(p_data->>'name','Пользователь'),128),
          left(p_data->>'username',64), coalesce(mode,'question'), text_value, coalesce((p_data->>'attachment')::boolean,false))
        on conflict (user_id, source_message_id) do update set user_id = excluded.user_id returning * into t;
        delete from dogwars_feedback.sessions where user_id = p_actor;
        result := jsonb_build_object('kind', 'ticket', 'ticket', to_jsonb(t));
      end if;
    when 'checkout' then
      select * into d from dogwars_feedback.donations where id::text = p_data->>'order';
      result := jsonb_build_object('kind', 'checkout', 'ok', coalesce(found and d.user_id = p_actor and d.state = 'pending'
        and d.stars = (p_data->>'amount')::integer and p_data->>'currency' = 'XTR' and d.created_at > now() - interval '1 hour',false));
    when 'paid' then
      select * into d from dogwars_feedback.donations where id::text = p_data->>'order' for update;
      if not found or d.user_id is distinct from p_actor or d.stars is distinct from (p_data->>'amount')::integer or p_data->>'currency' is distinct from 'XTR'
        or coalesce(p_data->>'charge','') = '' then raise exception 'Payment mismatch'; end if;
      if d.state = 'pending' then
        update dogwars_feedback.donations set state = 'paid', charge_id = p_data->>'charge', paid_at = now() where id = d.id;
        result := jsonb_build_object('kind', 'paid', 'stars', d.stars, 'order_id', d.id);
      else
        if d.charge_id <> p_data->>'charge' then raise exception 'Charge mismatch'; end if;
        result := jsonb_build_object('kind','noop');
      end if;
    when 'refunded' then
      update dogwars_feedback.donations set state = 'refunded'
      where charge_id = p_data->>'charge' and user_id = p_actor and stars = (p_data->>'amount')::integer and p_data->>'currency' = 'XTR';
      result := jsonb_build_object('kind','noop');
    when 'mine' then
      select jsonb_build_object('kind','list','tickets',coalesce(jsonb_agg(to_jsonb(q)), '[]')) into result
      from (select id, category, status from dogwars_feedback.tickets where user_id = p_actor order by id desc limit 10) q;
    when 'inbox' then
      select jsonb_build_object('kind','list','tickets',coalesce(jsonb_agg(to_jsonb(q)), '[]')) into result
      from (select id, category, status from dogwars_feedback.tickets where status <> 'closed' order by id desc limit 20) q;
    when 'reply', 'status' then
      -- Только ответ на реально доставленное ботом сообщение в настроенной группе.
      select o.ticket_id into mapped from dogwars_feedback.outbox o
      where o.delivered and o.role = 'ticket' and o.message_id = (p_data->>'reply_to')::bigint
        and o.payload->>'chat_id' = p_data->>'chat_id' order by o.id desc limit 1;
      if mapped is null then result := jsonb_build_object('kind','unmapped');
      else
        select * into t from dogwars_feedback.tickets where id = mapped;
        if p_action = 'reply' then
          if btrim(text_value) = '' or length(text_value) > 3000 then result := jsonb_build_object('kind','text_error');
          else result := jsonb_build_object('kind','reply','ticket', to_jsonb(t),'text',text_value); end if;
        else
          if p_data->>'status' not in ('working','closed') then raise exception 'Invalid status'; end if;
          update dogwars_feedback.tickets set status = p_data->>'status' where id = mapped returning * into t;
          result := jsonb_build_object('kind','status','ticket',to_jsonb(t));
        end if;
      end if;
    when 'refund' then
      select * into d from dogwars_feedback.donations where id::text = p_data->>'order';
      if not found or d.state <> 'paid' then result := jsonb_build_object('kind','refund_unavailable');
      else result := jsonb_build_object('kind','refund','order', to_jsonb(d)); end if;
    else raise exception 'Unknown action';
  end case;
  insert into dogwars_feedback.updates values (p_update_id, result, now());
  return result;
end $$;

create or replace function public.feedback_enqueue(p_key text, p_method text, p_payload jsonb, p_ticket bigint default null, p_role text default 'notice')
returns void language sql security definer set search_path = pg_catalog, dogwars_feedback as $$
  insert into dogwars_feedback.outbox(action_key,method,payload,ticket_id,role)
  values (p_key,p_method,p_payload,p_ticket,p_role) on conflict (action_key) do nothing;
$$;

create or replace function public.feedback_claim()
returns jsonb language plpgsql security definer set search_path = pg_catalog, dogwars_feedback as $$
declare r dogwars_feedback.outbox;
begin
  select * into r from dogwars_feedback.outbox where not delivered and retry_at <= now()
    and (lease_until is null or lease_until < now()) order by id for update skip locked limit 1;
  if not found then return null; end if;
  update dogwars_feedback.outbox set lease = gen_random_uuid(), lease_until = now() + interval '60 seconds', attempts = attempts + 1
    where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.feedback_finish(p_id bigint, p_lease uuid, p_ok boolean, p_message bigint default null, p_error text default null)
returns void language plpgsql security definer set search_path = pg_catalog, dogwars_feedback as $$
declare r dogwars_feedback.outbox;
begin
  update dogwars_feedback.outbox set delivered = p_ok, message_id = p_message, lease_until = null,
    retry_at = now() + make_interval(secs => least(300, attempts * 15)), last_error = left(p_error,200)
    where id = p_id and lease = p_lease and not delivered returning * into r;
  if found and p_ok and r.method = 'refundStarPayment' then
    update dogwars_feedback.donations set state = 'refunded' where charge_id = r.payload->>'telegram_payment_charge_id';
  end if;
end $$;

-- RLS и отзыв EXECUTE защищают RPC и таблицы от браузера и пользователей Mini App.
alter table dogwars_feedback.sessions enable row level security;
alter table dogwars_feedback.tickets enable row level security;
alter table dogwars_feedback.donations enable row level security;
alter table dogwars_feedback.updates enable row level security;
alter table dogwars_feedback.outbox enable row level security;
revoke all on all tables in schema dogwars_feedback from public, anon, authenticated;
revoke all on all sequences in schema dogwars_feedback from public, anon, authenticated;
revoke all on function public.feedback_apply(bigint,bigint,text,jsonb) from public, anon, authenticated;
revoke all on function public.feedback_enqueue(text,text,jsonb,bigint,text) from public, anon, authenticated;
revoke all on function public.feedback_claim() from public, anon, authenticated;
revoke all on function public.feedback_finish(bigint,uuid,boolean,bigint,text) from public, anon, authenticated;
grant execute on function public.feedback_apply(bigint,bigint,text,jsonb),
 public.feedback_enqueue(text,text,jsonb,bigint,text), public.feedback_claim(),
 public.feedback_finish(bigint,uuid,boolean,bigint,text) to service_role;
commit;
