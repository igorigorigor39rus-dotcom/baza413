-- Только временная локальная база. Все тестовые записи откатываются.
\set ON_ERROR_STOP on
begin;
do $$
declare r jsonb; again jsonb; ticket_id bigint; claim jsonb; order_id text; failed boolean := false;
begin
  assert not has_function_privilege('anon', 'public.feedback_apply(bigint,bigint,text,jsonb)', 'EXECUTE');
  assert not has_function_privilege('authenticated', 'public.feedback_claim()', 'EXECUTE');
  assert has_function_privilege('service_role', 'public.feedback_apply(bigint,bigint,text,jsonb)', 'EXECUTE');
  assert not has_schema_privilege('anon', 'dogwars_feedback', 'USAGE');
  assert (select relrowsecurity from pg_class where oid = 'dogwars_feedback.tickets'::regclass);

  r := public.feedback_apply(1,9,'session','{"mode":"bug"}');
  assert r->>'kind' = 'prompt';
  r := public.feedback_apply(2,9,'input','{"message_id":10,"text":"Ошибка","name":"Тест","attachment":true}');
  assert r->>'kind' = 'ticket';
  assert r->'ticket'->>'category' = 'bug';
  ticket_id := (r->'ticket'->>'id')::bigint;
  again := public.feedback_apply(2,9,'input','{"message_id":10,"text":"Changed"}');
  assert r = again;
  assert (select count(*) = 1 from dogwars_feedback.tickets);
  r := public.feedback_apply(3,9,'input','{"message_id":11,"text":"too soon"}');
  assert r->>'kind' = 'rate_limit';
  r := public.feedback_apply(4,8,'mine');
  assert jsonb_array_length(r->'tickets') = 0;
  r := public.feedback_apply(5,9,'mine');
  assert jsonb_array_length(r->'tickets') = 1;
  r := public.feedback_apply(6,7,'reply','{"chat_id":-100123,"reply_to":555,"text":"fake reply"}');
  assert r->>'kind' = 'unmapped';

  perform public.feedback_enqueue('test','sendMessage','{"chat_id":-100123,"text":"Ticket"}',ticket_id,'ticket');
  perform public.feedback_enqueue('test','sendMessage','{"chat_id":-100123,"text":"Duplicate"}',ticket_id,'ticket');
  assert (select count(*) = 1 from dogwars_feedback.outbox);
  claim := public.feedback_claim();
  assert claim is not null;
  assert public.feedback_claim() is null, 'leased row must not be claimed concurrently';
  perform public.feedback_finish((claim->>'id')::bigint,gen_random_uuid(),true,999);
  assert (select not delivered from dogwars_feedback.outbox limit 1), 'wrong lease must not acknowledge';
  perform public.feedback_finish((claim->>'id')::bigint,(claim->>'lease')::uuid,true,555);
  r := public.feedback_apply(7,7,'reply','{"chat_id":-100123,"reply_to":555,"text":"Настоящий ответ"}');
  assert r->>'kind' = 'reply' and r->'ticket'->>'user_id' = '9';
  r := public.feedback_apply(8,7,'status','{"chat_id":-100123,"reply_to":555,"status":"working"}');
  assert r->'ticket'->>'status' = 'working';
  r := public.feedback_apply(9,7,'reply','{"chat_id":-100999,"reply_to":555,"text":"wrong group"}');
  assert r->>'kind' = 'unmapped';

  perform public.feedback_apply(10,9,'session','{"mode":"donation"}');
  r := public.feedback_apply(11,9,'input','{"text":"0"}');
  assert r->>'kind' = 'amount_error';
  r := public.feedback_apply(12,9,'input','{"text":"12.5"}');
  assert r->>'kind' = 'amount_error';
  r := public.feedback_apply(13,9,'input','{"text":"10001"}');
  assert r->>'kind' = 'amount_error';
  r := public.feedback_apply(14,9,'input','{"text":"50"}');
  assert r->>'kind' = 'invoice';
  order_id := r->'order'->>'id';
  assert public.feedback_apply(14,9,'input','{"text":"50"}') = r;
  r := public.feedback_apply(15,9,'checkout',jsonb_build_object('order',order_id,'amount',50,'currency','XTR'));
  assert (r->>'ok')::boolean;
  r := public.feedback_apply(16,8,'checkout',jsonb_build_object('order',order_id,'amount',50,'currency','XTR'));
  assert not (r->>'ok')::boolean, 'another user cannot pay the invoice';
  r := public.feedback_apply(17,9,'checkout',jsonb_build_object('order',order_id,'amount',51,'currency','XTR'));
  assert not (r->>'ok')::boolean;
  r := public.feedback_apply(180,9,'checkout',jsonb_build_object('order',order_id));
  assert r->>'ok' = 'false', 'incomplete checkout must be rejected explicitly';
  r := public.feedback_apply(18,9,'checkout',jsonb_build_object('order',order_id,'amount',50,'currency','RUB'));
  assert not (r->>'ok')::boolean;
  r := public.feedback_apply(19,7,'refund',jsonb_build_object('order',order_id));
  assert r->>'kind' = 'refund_unavailable';
  begin
    perform public.feedback_apply(20,8,'paid',jsonb_build_object('order',order_id,'amount',50,'currency','XTR','charge','charge1'));
  exception when raise_exception then failed := true; end;
  assert failed, 'wrong payer payment must fail';
  failed := false;
  begin
    perform public.feedback_apply(200,9,'paid',jsonb_build_object('order',order_id,'charge','charge1'));
  exception when raise_exception then failed := true; end;
  assert failed, 'missing amount/currency must not pass NULL comparisons';
  r := public.feedback_apply(21,9,'paid',jsonb_build_object('order',order_id,'amount',50,'currency','XTR','charge','charge1'));
  assert r->>'kind' = 'paid';
  r := public.feedback_apply(22,9,'paid',jsonb_build_object('order',order_id,'amount',50,'currency','XTR','charge','charge1'));
  assert r->>'kind' = 'noop';
  assert (select count(*) = 1 from dogwars_feedback.donations where state = 'paid');
  r := public.feedback_apply(23,7,'refund',jsonb_build_object('order',order_id));
  assert r->>'kind' = 'refund';
  perform public.feedback_enqueue('refund','refundStarPayment','{"user_id":9,"telegram_payment_charge_id":"charge1"}');
  claim := public.feedback_claim();
  perform public.feedback_finish((claim->>'id')::bigint,(claim->>'lease')::uuid,true);
  assert (select state = 'refunded' from dogwars_feedback.donations where id::text = order_id);
  r := public.feedback_apply(24,7,'refund',jsonb_build_object('order',order_id));
  assert r->>'kind' = 'refund_unavailable';
  raise notice 'Database checks passed: tickets, isolation, deduplication, leases, Stars and refunds';
end $$;
rollback;
